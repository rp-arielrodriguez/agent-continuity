import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEd25519Signer, generateEd25519KeyPairDer, type ContinuitySigner } from "./block.js";

export interface StoredNodeSigner {
  version: 1;
  nodeId: string;
  privateKeyDer: string;
  publicKeyDer: string;
  createdAt: string;
}

export interface LoadNodeSignerOptions {
  keyPath?: string;
  stateDir?: string;
  nodeId?: string;
  actorId: string;
}

export async function loadOrCreateNodeSigner(options: LoadNodeSignerOptions): Promise<{ signer: ContinuitySigner; keyPath: string; created: boolean }> {
  const keyPath = options.keyPath ?? defaultNodeKeyPath(options.stateDir);
  const requestedNodeId = options.nodeId ? sanitizeNodeId(options.nodeId) : undefined;
  const existing = await readNodeSigner(keyPath);
  if (existing) {
    if (requestedNodeId && existing.nodeId !== requestedNodeId) {
      throw new Error(`node key ${keyPath} belongs to ${existing.nodeId}; pass --node-id ${existing.nodeId} or use a different --key-file`);
    }
    return {
      keyPath,
      created: false,
      signer: createEd25519Signer({
        nodeId: existing.nodeId,
        actorId: options.actorId,
        privateKeyDer: existing.privateKeyDer,
        publicKeyDer: existing.publicKeyDer,
      }),
    };
  }

  const nodeId = requestedNodeId ?? sanitizeNodeId(os.hostname());
  const keyPair = generateEd25519KeyPairDer();
  const stored: StoredNodeSigner = {
    version: 1,
    nodeId,
    privateKeyDer: keyPair.privateKeyDer,
    publicKeyDer: keyPair.publicKeyDer,
    createdAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    keyPath,
    created: true,
    signer: createEd25519Signer({
      nodeId,
      actorId: options.actorId,
      privateKeyDer: stored.privateKeyDer,
      publicKeyDer: stored.publicKeyDer,
    }),
  };
}

export function defaultNodeKeyPath(stateDir = path.join(os.homedir(), ".local", "state", "agent-continuity")): string {
  return path.join(stateDir, "node-key.json");
}

async function readNodeSigner(keyPath: string): Promise<StoredNodeSigner | null> {
  try {
    return JSON.parse(await readFile(keyPath, "utf8")) as StoredNodeSigner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to read node key ${keyPath}: ${(error as Error).message}`);
  }
}

function sanitizeNodeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._:/@-]/g, "-");
  if (sanitized === "") return "node";
  return /^[A-Za-z0-9]/.test(sanitized) ? sanitized : `node-${sanitized}`;
}
