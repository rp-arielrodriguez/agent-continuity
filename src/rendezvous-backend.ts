import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./config.js";
import {
  discoverRendezvousPeers,
  publishRendezvousPresence,
  type DiscoveryFilter,
  type DiscoveryResult,
  type PeerPresence,
} from "./peer-onboarding.js";

const execFile = promisify(execFileCallback);

export type RendezvousBackendKind = "file" | "git" | "s3" | "https";

export interface RendezvousTarget {
  backend: RendezvousBackendKind;
  dir?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  url?: string;
  stateDir?: string;
  awsBin?: string;
  s3EndpointUrl?: string;
  s3Profile?: string;
  httpToken?: string;
}

export interface RendezvousPublishResult {
  backend: RendezvousBackendKind;
  file?: string;
  url?: string;
  worktree?: string;
  branch?: string;
  committed?: boolean;
  pushed?: boolean;
  message?: string;
}

export interface RendezvousDiscoverResult extends DiscoveryResult {
  backend: RendezvousBackendKind;
  worktree?: string;
}

export async function publishRendezvousPresenceToTarget(input: { target: RendezvousTarget; presence: PeerPresence }): Promise<RendezvousPublishResult> {
  switch (input.target.backend) {
    case "file": {
      const file = await publishRendezvousPresence({ rendezvous: requiredDir(input.target), presence: input.presence });
      return { backend: "file", file };
    }
    case "git":
      return publishGitRendezvous(input.target, input.presence);
    case "s3":
      return publishS3Rendezvous(input.target, input.presence);
    case "https":
      return publishHttpsRendezvous(input.target, input.presence);
  }
}

export async function discoverRendezvousPeersFromTarget(input: { target: RendezvousTarget; filter?: DiscoveryFilter }): Promise<RendezvousDiscoverResult> {
  switch (input.target.backend) {
    case "file": {
      const result = await discoverRendezvousPeers({ rendezvous: requiredDir(input.target), filter: input.filter });
      return { ...result, backend: "file" };
    }
    case "git":
      return discoverGitRendezvous(input.target, input.filter);
    case "s3":
      return discoverS3Rendezvous(input.target, input.filter);
    case "https":
      return discoverHttpsRendezvous(input.target, input.filter);
  }
}

async function publishGitRendezvous(target: RendezvousTarget, presence: PeerPresence): Promise<RendezvousPublishResult> {
  const worktree = await prepareGitWorktree(target);
  const branch = gitBranch(target);
  const dir = path.join(worktree, target.dir ?? "rendezvous");
  const file = await publishRendezvousPresence({ rendezvous: dir, presence });
  await git(worktree, ["add", target.dir ?? "rendezvous"]);
  const dirty = (await gitOutput(worktree, ["status", "--porcelain"])).trim() !== "";
  if (!dirty) return { backend: "git", file, worktree, branch, committed: false, pushed: false, message: "presence already current" };
  await git(worktree, ["commit", "-m", `Publish ${presence.name ?? presence.nodeId} rendezvous presence`]);
  await git(worktree, ["push", "origin", `HEAD:${branch}`]);
  return { backend: "git", file, worktree, branch, committed: true, pushed: true };
}

async function discoverGitRendezvous(target: RendezvousTarget, filter: DiscoveryFilter | undefined): Promise<RendezvousDiscoverResult> {
  const worktree = await prepareGitWorktree(target);
  const result = await discoverRendezvousPeers({ rendezvous: path.join(worktree, target.dir ?? "rendezvous"), filter });
  return { ...result, backend: "git", worktree };
}

async function prepareGitWorktree(target: RendezvousTarget): Promise<string> {
  if (!target.repo) throw new Error("--repo is required for git rendezvous");
  const branch = gitBranch(target);
  const worktree = path.resolve(expandHome(target.worktree ?? defaultGitWorktree(target)));
  if (!(await gitWorktreeExists(worktree))) {
    await mkdir(path.dirname(worktree), { recursive: true });
    await execFile("git", ["clone", target.repo, worktree]);
  }
  await git(worktree, ["fetch", "origin"]);
  try {
    await git(worktree, ["checkout", "-B", branch, `origin/${branch}`]);
  } catch {
    await git(worktree, ["checkout", "-B", branch]);
  }
  try {
    await git(worktree, ["pull", "--ff-only", "origin", branch]);
  } catch {
    // New rendezvous branches are valid; publish will create them on push.
  }
  return worktree;
}

async function publishS3Rendezvous(target: RendezvousTarget, presence: PeerPresence): Promise<RendezvousPublishResult> {
  const url = requiredUrl(target, "s3");
  const temp = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-s3-"));
  try {
    const file = await publishRendezvousPresence({ rendezvous: temp, presence });
    const destination = `${trimTrailingSlash(url)}/${path.basename(file)}`;
    await aws(target, ["s3", "cp", file, destination]);
    return { backend: "s3", file, url: destination };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function discoverS3Rendezvous(target: RendezvousTarget, filter: DiscoveryFilter | undefined): Promise<RendezvousDiscoverResult> {
  const url = requiredUrl(target, "s3");
  const temp = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-s3-"));
  try {
    await aws(target, ["s3", "sync", url, temp, "--exclude", "*", "--include", "*.presence.json"]);
    const result = await discoverRendezvousPeers({ rendezvous: temp, filter });
    return { ...result, backend: "s3" };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function publishHttpsRendezvous(target: RendezvousTarget, presence: PeerPresence): Promise<RendezvousPublishResult> {
  const base = requiredUrl(target, "https");
  const temp = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-http-"));
  try {
    const file = await publishRendezvousPresence({ rendezvous: temp, presence });
    const url = `${trimTrailingSlash(base)}/${path.basename(file)}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: httpHeaders(target, "application/json"),
      body: await readFile(file, "utf8"),
    });
    if (!response.ok) throw new Error(`PUT ${url} failed: HTTP ${response.status}`);
    return { backend: "https", file, url };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function discoverHttpsRendezvous(target: RendezvousTarget, filter: DiscoveryFilter | undefined): Promise<RendezvousDiscoverResult> {
  const base = trimTrailingSlash(requiredUrl(target, "https"));
  const index = await fetchJson(`${base}/index.json`, target);
  const temp = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-http-"));
  try {
    if (Array.isArray((index as { presences?: unknown }).presences)) {
      for (const presence of (index as { presences: unknown[] }).presences) {
        const nodeId = typeof (presence as { nodeId?: unknown }).nodeId === "string" ? (presence as { nodeId: string }).nodeId : "presence";
        await writeFile(path.join(temp, `${safeHttpFileName(nodeId)}.presence.json`), `${JSON.stringify(presence)}\n`, "utf8");
      }
    } else {
      const files = httpsIndexFiles(index);
      for (const file of files) {
        const url = file.startsWith("http://") || file.startsWith("https://") ? file : `${base}/${file.replace(/^\/+/, "")}`;
        const response = await fetch(url, { headers: httpHeaders(target) });
        if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
        await writeFile(path.join(temp, path.basename(new URL(url).pathname)), await response.text(), "utf8");
      }
    }
    const result = await discoverRendezvousPeers({ rendezvous: temp, filter });
    return { ...result, backend: "https" };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function httpsIndexFiles(index: unknown): string[] {
  if (Array.isArray(index)) return index.map(String);
  const files = (index as { files?: unknown }).files;
  if (Array.isArray(files)) return files.map(String);
  throw new Error("HTTPS rendezvous index must be an array, {files}, or {presences}");
}

async function fetchJson(url: string, target: RendezvousTarget): Promise<unknown> {
  const response = await fetch(url, { headers: httpHeaders(target) });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.json();
}

function httpHeaders(target: RendezvousTarget, contentType?: string): Record<string, string> {
  const token = target.httpToken ?? process.env.CONTINUITY_RENDEZVOUS_TOKEN;
  return {
    ...(contentType ? { "content-type": contentType } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function aws(target: RendezvousTarget, args: string[]): Promise<void> {
  const fullArgs = [
    ...(target.s3EndpointUrl ? ["--endpoint-url", target.s3EndpointUrl] : []),
    ...(target.s3Profile ? ["--profile", target.s3Profile] : []),
    ...args,
  ];
  await execFile(target.awsBin ?? "aws", fullArgs);
}

async function git(worktree: string, args: string[]): Promise<void> {
  await execFile("git", ["-C", worktree, ...args]);
}

async function gitOutput(worktree: string, args: string[]): Promise<string> {
  return (await execFile("git", ["-C", worktree, ...args])).stdout;
}

async function gitWorktreeExists(worktree: string): Promise<boolean> {
  try {
    await git(worktree, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

function defaultGitWorktree(target: RendezvousTarget): string {
  if (!target.stateDir) throw new Error("--state-dir is required when --worktree is not provided for git rendezvous");
  return path.join(target.stateDir, "rendezvous", "git", hash(`${target.repo ?? ""}:${gitBranch(target)}`));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function gitBranch(target: RendezvousTarget): string {
  return target.branch ?? "continuity-rendezvous";
}

function requiredDir(target: RendezvousTarget): string {
  if (!target.dir) throw new Error("--dir or --rendezvous is required for file rendezvous");
  return target.dir;
}

function requiredUrl(target: RendezvousTarget, backend: string): string {
  if (!target.url) throw new Error(`--url is required for ${backend} rendezvous`);
  return target.url;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeHttpFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "presence";
}
