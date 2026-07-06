import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson, SIGNATURE_SCHEME, type ContinuitySigner } from "./block.js";
import { expandHome } from "./config.js";

const execFile = promisify(execFileCallback);
const PEER_INVITE_KIND = "agent-continuity.peer-invite";
const PRESENCE_KIND = "agent-continuity.peer-presence";
const INVITE_URL_HOST = "peer";
const RENDEZVOUS_FILE_SUFFIX = ".presence.json";
const MDNS_SERVICE = "_continuity._tcp";
const MDNS_ADVERTISER_STATE_FILE = "mdns-advertise.json";

export interface PeerEndpoint {
  endpoint: string;
  provider?: string;
}

export interface SignedDocumentSignature {
  scheme: typeof SIGNATURE_SCHEME;
  publicKey: string;
  value: string;
}

export interface PeerInvite {
  version: 1;
  kind: typeof PEER_INVITE_KIND;
  nodeId: string;
  publicKey: string;
  name?: string;
  endpoint: string;
  provider?: string;
  createdAt: string;
  expiresAt?: string;
  projects?: string[];
  signature: SignedDocumentSignature;
}

export interface PeerPresence {
  version: 1;
  kind: typeof PRESENCE_KIND;
  nodeId: string;
  publicKey: string;
  name?: string;
  endpoints: PeerEndpoint[];
  projects?: string[];
  updatedAt: string;
  expiresAt?: string;
  signature: SignedDocumentSignature;
}

export interface DiscoveredOnboardingPeer {
  source: "rendezvous" | "mdns";
  nodeId: string;
  publicKey: string;
  name?: string;
  endpoint: string;
  provider?: string;
  projects?: string[];
  updatedAt?: string;
  expiresAt?: string;
}

export interface DiscoveryFilter {
  trustedNames?: string[];
  trustedNodeIds?: string[];
  projectId?: string;
}

export interface DiscoveryResult {
  peers: DiscoveredOnboardingPeer[];
  warnings: string[];
}

export interface MdnsAdvertiserState {
  version: 1;
  pid: number;
  name: string;
  nodeId: string;
  endpoint: string;
  provider?: string;
  projects?: string[];
  startedAt: string;
  stateFile: string;
}

export interface MdnsAdvertiserStatus {
  stateFile: string;
  running: boolean;
  state?: MdnsAdvertiserState;
  reason?: string;
}

export interface MdnsAdvertiserStopResult {
  stateFile: string;
  stopped: boolean;
  pid?: number;
  reason?: string;
}

export async function createPeerInvite(
  input: {
    endpoint: string;
    provider?: string;
    name?: string;
    projects?: string[];
    expiresAt?: string;
    createdAt?: string;
  },
  signer: ContinuitySigner,
): Promise<PeerInvite> {
  validateEndpoint(input.endpoint);
  const unsigned = {
    version: 1 as const,
    kind: PEER_INVITE_KIND as typeof PEER_INVITE_KIND,
    nodeId: signer.nodeId,
    publicKey: signer.publicKey,
    name: nonEmpty(input.name),
    endpoint: input.endpoint,
    provider: nonEmpty(input.provider),
    createdAt: input.createdAt ?? new Date().toISOString(),
    expiresAt: nonEmpty(input.expiresAt),
    projects: cleanList(input.projects),
  };
  return signDocument(unsigned, signer);
}

export function encodePeerInvite(invite: PeerInvite): string {
  const payload = Buffer.from(canonicalJson(invite)).toString("base64url");
  return `continuity://${INVITE_URL_HOST}?payload=${encodeURIComponent(payload)}`;
}

export function decodePeerInvite(value: string, now = new Date()): PeerInvite {
  const url = new URL(value);
  if (url.protocol !== "continuity:" || url.hostname !== INVITE_URL_HOST) {
    throw new Error("peer invite must use continuity://peer?payload=...");
  }
  const payload = url.searchParams.get("payload");
  if (!payload) throw new Error("peer invite is missing payload");
  const invite = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PeerInvite;
  validatePeerInvite(invite, now);
  return invite;
}

export function validatePeerInvite(invite: PeerInvite, now = new Date()): void {
  if (invite.version !== 1 || invite.kind !== PEER_INVITE_KIND) throw new Error("unsupported peer invite");
  if (!invite.nodeId || !invite.publicKey || !invite.endpoint) throw new Error("peer invite is missing nodeId, publicKey, or endpoint");
  validateEndpoint(invite.endpoint);
  assertNotExpired(invite.expiresAt, now, "peer invite");
  if (!verifySignedDocument(invite)) throw new Error("peer invite signature does not verify");
}

export async function createPeerPresence(
  input: {
    endpoints: PeerEndpoint[];
    name?: string;
    projects?: string[];
    expiresAt?: string;
    updatedAt?: string;
  },
  signer: ContinuitySigner,
): Promise<PeerPresence> {
  if (input.endpoints.length === 0) throw new Error("at least one endpoint is required");
  for (const endpoint of input.endpoints) validateEndpoint(endpoint.endpoint);
  const unsigned = {
    version: 1 as const,
    kind: PRESENCE_KIND as typeof PRESENCE_KIND,
    nodeId: signer.nodeId,
    publicKey: signer.publicKey,
    name: nonEmpty(input.name),
    endpoints: input.endpoints.map((entry) => ({ endpoint: entry.endpoint, provider: nonEmpty(entry.provider) })),
    projects: cleanList(input.projects),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    expiresAt: nonEmpty(input.expiresAt),
  };
  return signDocument(unsigned, signer);
}

export async function publishRendezvousPresence(input: { rendezvous: string; presence: PeerPresence }): Promise<string> {
  validatePeerPresence(input.presence);
  const dir = rendezvousDir(input.rendezvous);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${safeFileName(input.presence.nodeId)}${RENDEZVOUS_FILE_SUFFIX}`);
  const tmp = path.join(dir, `.${safeFileName(input.presence.nodeId)}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${canonicalJson(input.presence)}\n`, "utf8");
  await rename(tmp, target);
  return target;
}

export async function discoverRendezvousPeers(input: { rendezvous: string; filter?: DiscoveryFilter; now?: Date }): Promise<DiscoveryResult> {
  const dir = rendezvousDir(input.rendezvous);
  const warnings: string[] = [];
  const peers: DiscoveredOnboardingPeer[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    throw new Error(`read rendezvous directory ${dir}: ${(error as Error).message}`);
  }

  for (const file of files.filter((entry) => entry.endsWith(RENDEZVOUS_FILE_SUFFIX))) {
    const filePath = path.join(dir, file);
    try {
      const presence = JSON.parse(await readFile(filePath, "utf8")) as PeerPresence;
      validatePeerPresence(presence, input.now);
      if (!matchesFilter(presence, input.filter)) continue;
      for (const endpoint of presence.endpoints) {
        peers.push({
          source: "rendezvous",
          nodeId: presence.nodeId,
          publicKey: presence.publicKey,
          name: presence.name,
          endpoint: endpoint.endpoint,
          provider: endpoint.provider ?? "rendezvous",
          projects: presence.projects,
          updatedAt: presence.updatedAt,
          expiresAt: presence.expiresAt,
        });
      }
    } catch (error) {
      warnings.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { peers, warnings };
}

export function validatePeerPresence(presence: PeerPresence, now = new Date()): void {
  if (presence.version !== 1 || presence.kind !== PRESENCE_KIND) throw new Error("unsupported peer presence");
  if (!presence.nodeId || !presence.publicKey || !Array.isArray(presence.endpoints)) {
    throw new Error("peer presence is missing nodeId, publicKey, or endpoints");
  }
  if (presence.endpoints.length === 0) throw new Error("peer presence has no endpoints");
  for (const endpoint of presence.endpoints) validateEndpoint(endpoint.endpoint);
  assertNotExpired(presence.expiresAt, now, "peer presence");
  if (!verifySignedDocument(presence)) throw new Error("peer presence signature does not verify");
}

export function mdnsTxtForPresence(presence: PeerPresence): string[] {
  validatePeerPresence(presence);
  const endpoint = presence.endpoints[0];
  return [
    "txtvers=1",
    `node=${presence.nodeId}`,
    `pub=${presence.publicKey}`,
    `endpoint=${endpoint.endpoint}`,
    `provider=${endpoint.provider ?? "mdns"}`,
    ...(presence.endpoints.length > 1 ? [`endpoints=${Buffer.from(canonicalJson(presence.endpoints)).toString("base64url")}`] : []),
    `updated=${presence.updatedAt}`,
    `sig=${presence.signature.value}`,
    ...(presence.name ? [`name=${presence.name}`] : []),
    ...(presence.projects?.length ? [`projects=${presence.projects.join(",")}`] : []),
    ...(presence.expiresAt ? [`expires=${presence.expiresAt}`] : []),
  ];
}

export function presenceFromMdnsTxt(values: string[]): PeerPresence {
  const txt = parseTxtValues(values);
  const endpoint = requiredTxt(txt, "endpoint");
  const endpoints = txt.endpoints ? parseMdnsEndpointList(txt.endpoints) : [{ endpoint, provider: txt.provider ?? "mdns" }];
  const presence: PeerPresence = {
    version: 1,
    kind: PRESENCE_KIND,
    nodeId: requiredTxt(txt, "node"),
    publicKey: requiredTxt(txt, "pub"),
    name: txt.name,
    endpoints,
    projects: txt.projects ? txt.projects.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
    updatedAt: requiredTxt(txt, "updated"),
    expiresAt: txt.expires,
    signature: {
      scheme: SIGNATURE_SCHEME,
      publicKey: requiredTxt(txt, "pub"),
      value: requiredTxt(txt, "sig"),
    },
  };
  validatePeerPresence(presence);
  return presence;
}

export async function advertiseMdnsPresence(input: { presence: PeerPresence; durationMs?: number }): Promise<void> {
  const child = spawn("dns-sd", mdnsAdvertiseArgs(input.presence), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForMdnsAdvertiser(child, input.durationMs);
}

export async function startMdnsAdvertiser(input: { presence: PeerPresence; stateDir: string; now?: string }): Promise<MdnsAdvertiserState> {
  validatePeerPresence(input.presence);
  const stateFile = mdnsAdvertiserStatePath(input.stateDir);
  const existing = await readMdnsAdvertiserStatus({ stateDir: input.stateDir });
  if (existing.running && existing.state) {
    throw new Error(`mDNS advertiser is already running with pid ${existing.state.pid}; stop it first`);
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  const child = spawn("dns-sd", mdnsAdvertiseArgs(input.presence), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const endpoint = input.presence.endpoints[0];
  const state: MdnsAdvertiserState = {
    version: 1,
    pid: child.pid ?? 0,
    name: input.presence.name ?? input.presence.nodeId,
    nodeId: input.presence.nodeId,
    endpoint: endpoint.endpoint,
    provider: endpoint.provider,
    projects: input.presence.projects,
    startedAt: input.now ?? new Date().toISOString(),
    stateFile,
  };
  if (!state.pid) throw new Error("dns-sd did not report a pid");
  await writeFile(stateFile, `${canonicalJson(stripUndefined(state))}\n`, "utf8");
  await sleep(250);
  if (!isProcessRunning(state.pid)) {
    await rm(stateFile, { force: true });
    throw new Error("dns-sd advertiser exited immediately");
  }
  return state;
}

export async function readMdnsAdvertiserStatus(input: { stateDir: string }): Promise<MdnsAdvertiserStatus> {
  const stateFile = mdnsAdvertiserStatePath(input.stateDir);
  let state: MdnsAdvertiserState;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8")) as MdnsAdvertiserState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { stateFile, running: false, reason: "not started" };
    return { stateFile, running: false, reason: `cannot read state: ${(error as Error).message}` };
  }
  if (!state.pid) return { stateFile, running: false, state, reason: "state file is missing pid" };
  return {
    stateFile,
    running: isProcessRunning(state.pid),
    state,
    reason: isProcessRunning(state.pid) ? undefined : "process is not running",
  };
}

export async function stopMdnsAdvertiser(input: { stateDir: string }): Promise<MdnsAdvertiserStopResult> {
  const status = await readMdnsAdvertiserStatus(input);
  if (!status.state) {
    await rm(status.stateFile, { force: true });
    return { stateFile: status.stateFile, stopped: false, reason: status.reason ?? "not started" };
  }
  if (status.running) {
    sendSignal(status.state.pid, "SIGTERM");
    await waitForProcessExit(status.state.pid, 2000);
    if (isProcessRunning(status.state.pid)) {
      sendSignal(status.state.pid, "SIGKILL");
      await waitForProcessExit(status.state.pid, 1000);
    }
  }
  const stopped = !isProcessRunning(status.state.pid);
  if (stopped) await rm(status.stateFile, { force: true });
  return {
    stateFile: status.stateFile,
    stopped,
    pid: status.state.pid,
    reason: stopped ? undefined : "process is still running",
  };
}

export async function discoverMdnsPeers(input: { timeoutMs?: number; filter?: DiscoveryFilter }): Promise<DiscoveryResult> {
  const timeoutMs = input.timeoutMs ?? 2500;
  const browse = await runDnsSd(["-B", MDNS_SERVICE, "local"], timeoutMs);
  const warnings = [...browse.warnings];
  const names = parseDnsSdBrowseOutput(browse.stdout);
  const peers: DiscoveredOnboardingPeer[] = [];
  for (const name of names) {
    const resolved = await runDnsSd(["-L", name, MDNS_SERVICE, "local"], Math.min(timeoutMs, 2000));
    warnings.push(...resolved.warnings);
    const txtValues = parseDnsSdResolveTxt(resolved.stdout);
    if (txtValues.length === 0) continue;
    try {
      const presence = presenceFromMdnsTxt(txtValues);
      if (!matchesFilter(presence, input.filter)) continue;
      for (const endpoint of presence.endpoints) {
        peers.push({
          source: "mdns",
          nodeId: presence.nodeId,
          publicKey: presence.publicKey,
          name: presence.name,
          endpoint: endpoint.endpoint,
          provider: endpoint.provider ?? "mdns",
          projects: presence.projects,
          updatedAt: presence.updatedAt,
          expiresAt: presence.expiresAt,
        });
      }
    } catch (error) {
      warnings.push(`${name}: ${(error as Error).message}`);
    }
  }
  return { peers, warnings };
}

export function parseDnsSdBrowseOutput(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\bAdd\b.*\blocal\.\s+_continuity\._tcp\.\s+(.+)$/);
    if (match?.[1]) names.add(match[1].trim());
  }
  return [...names];
}

export function parseDnsSdResolveTxt(output: string): string[] {
  const values: string[] = [];
  const knownKeys = ["txtvers", "node", "pub", "endpoint", "provider", "updated", "sig", "name", "projects", "expires"];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!knownKeys.some((key) => trimmed.includes(`${key}=`))) continue;
    for (const key of knownKeys) {
      const match = trimmed.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
      if (match?.[1]) values.push(`${key}=${match[1]}`);
    }
  }
  return values;
}

export function peerTrustInputFromInvite(invite: PeerInvite): { endpoint: string; nodeId: string; name?: string; publicKey: string; provider?: string } {
  return {
    endpoint: invite.endpoint,
    nodeId: invite.nodeId,
    name: invite.name ?? invite.nodeId,
    publicKey: invite.publicKey,
    provider: invite.provider ?? "invite",
  };
}

export function peerTrustInputFromDiscovery(peer: DiscoveredOnboardingPeer): { endpoint: string; nodeId: string; name?: string; publicKey: string; provider?: string } {
  return {
    endpoint: peer.endpoint,
    nodeId: peer.nodeId,
    name: peer.name ?? peer.nodeId,
    publicKey: peer.publicKey,
    provider: peer.provider ?? peer.source,
  };
}

export function requireTrustedFilterForAdd(filter: DiscoveryFilter | undefined): void {
  if (!filter?.trustedNames?.length && !filter?.trustedNodeIds?.length) {
    throw new Error("--add requires --trusted-names or --trusted-node-ids");
  }
}

function signDocument<T extends { publicKey: string }>(unsigned: T, signer: ContinuitySigner): Promise<T & { signature: SignedDocumentSignature }> {
  const normalized = stripUndefined(unsigned) as T;
  return signer.sign(Buffer.from(canonicalJson(normalized))).then((value) => ({
    ...normalized,
    signature: { scheme: SIGNATURE_SCHEME, publicKey: signer.publicKey, value },
  }));
}

function verifySignedDocument(document: { publicKey: string; signature: SignedDocumentSignature }): boolean {
  if (document.signature?.scheme !== SIGNATURE_SCHEME || document.signature.publicKey !== document.publicKey) return false;
  const { signature: _signature, ...unsigned } = document;
  try {
    const key = createPublicKey({ key: Buffer.from(document.publicKey, "base64url"), format: "der", type: "spki" });
    return verifySignature(null, Buffer.from(canonicalJson(stripUndefined(unsigned))), key, Buffer.from(document.signature.value, "base64url"));
  } catch {
    return false;
  }
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = stripUndefined(entry);
  }
  return result;
}

function assertNotExpired(expiresAt: string | undefined, now: Date, label: string): void {
  if (!expiresAt) return;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) throw new Error(`${label} expiresAt is not a valid timestamp`);
  if (expires <= now.getTime()) throw new Error(`${label} expired at ${expiresAt}`);
}

function validateEndpoint(endpoint: string): void {
  if (endpoint.startsWith("unix://")) {
    if (endpoint.length <= "unix://".length) throw new Error("unix peer endpoint path is empty");
    return;
  }
  if (endpoint.startsWith("/")) return;
  parseTcpEndpoint(endpoint);
}

function parseTcpEndpoint(endpoint: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`unsupported peer endpoint ${endpoint}: expected tcp://<host:port>`);
  }
  if (url.protocol !== "tcp:" || !url.hostname || !url.port) {
    throw new Error(`unsupported peer endpoint ${endpoint}: expected tcp://<host:port>`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid peer endpoint port in ${endpoint}`);
  return { host: url.hostname, port };
}

function rendezvousDir(value: string): string {
  if (value.startsWith("file://")) return path.resolve(new URL(value).pathname);
  return path.resolve(expandHome(value));
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "node";
}

function cleanList(values: string[] | undefined): string[] | undefined {
  const cleaned = (values ?? []).map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function matchesFilter(presence: PeerPresence, filter: DiscoveryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.projectId && !(presence.projects ?? []).includes(filter.projectId)) return false;
  if (filter.trustedNodeIds?.length && !filter.trustedNodeIds.includes(presence.nodeId)) return false;
  if (filter.trustedNames?.length) {
    const names = new Set([presence.name, presence.nodeId].filter((entry): entry is string => Boolean(entry)).map(normalizeName));
    if (!filter.trustedNames.some((name) => names.has(normalizeName(name)))) return false;
  }
  return true;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function parseTxtValues(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) continue;
    result[value.slice(0, index)] = value.slice(index + 1);
  }
  return result;
}

function requiredTxt(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`mDNS TXT record is missing ${key}`);
  return value;
}

function parseMdnsEndpointList(value: string): PeerEndpoint[] {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PeerEndpoint[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not a non-empty array");
    return parsed.map((entry) => ({
      endpoint: typeof entry.endpoint === "string" ? entry.endpoint : "",
      provider: typeof entry.provider === "string" ? entry.provider : undefined,
    }));
  } catch (error) {
    throw new Error(`mDNS TXT endpoints field is invalid: ${(error as Error).message}`);
  }
}

async function runDnsSd(args: string[], timeoutMs: number): Promise<{ stdout: string; warnings: string[] }> {
  try {
    const result = await execFile("dns-sd", args, { timeout: timeoutMs });
    return { stdout: result.stdout, warnings: [] };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number; message?: string };
    const stdout = result.stdout ?? "";
    if (stdout && (result.killed || result.signal === "SIGTERM")) return { stdout, warnings: [] };
    return { stdout, warnings: [`dns-sd ${args.join(" ")} failed: ${result.stderr?.trim() || result.message || result.code || "unknown error"}`] };
  }
}

function mdnsAdvertiseArgs(presence: PeerPresence): string[] {
  const endpoint = parseTcpEndpoint(presence.endpoints[0].endpoint);
  return ["-R", presence.name ?? presence.nodeId, MDNS_SERVICE, "local", String(endpoint.port), ...mdnsTxtForPresence(presence)];
}

function mdnsAdvertiserStatePath(stateDir: string): string {
  return path.join(path.resolve(expandHome(stateDir)), MDNS_ADVERTISER_STATE_FILE);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(50);
  }
  return !isProcessRunning(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForMdnsAdvertiser(child: ChildProcess, durationMs: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    const finish = (result: "resolve" | "reject", error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result === "resolve") resolve();
      else reject(error);
    };
    const stop = (): void => {
      child.kill("SIGTERM");
    };
    child.once("error", (error) => finish("reject", error));
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") finish("resolve");
      else finish("reject", new Error(`dns-sd advertiser exited with ${signal ?? code}: ${stderr.trim()}`));
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (durationMs !== undefined) timer = setTimeout(stop, durationMs);
    if (durationMs === undefined) {
      console.log(`mDNS advertising ${MDNS_SERVICE} as ${child.spawnargs.slice(2, 6).join(" ")}`);
    }
  });
}

export function defaultPresenceName(): string {
  return os.hostname();
}

export function defaultMdnsHost(hostname = os.hostname()): string {
  const cleaned = hostname.trim().replace(/\.$/, "");
  if (!cleaned) throw new Error("hostname is empty");
  return cleaned.toLowerCase().endsWith(".local") ? cleaned : `${cleaned}.local`;
}

export function defaultMdnsEndpoint(port: number, hostname = os.hostname()): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  return `tcp://${defaultMdnsHost(hostname)}:${port}`;
}
