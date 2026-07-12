import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LaneRef, TaskBlock } from "./block.js";
import type { LaneProjection } from "./contract.js";
import { BaseContinuityProvider, type LaneStatus, type LaneStatusInput, type ProviderHealth, type ProviderSubmitResult } from "./provider.js";

export interface LocalDaemonProviderOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export interface PeerSyncInput extends LaneRef {
  peers: string[];
}

export type PeerSyncTrustedInput = LaneRef;

export interface PeerSyncResult extends LaneRef {
  peers: Array<{
    endpoint: string;
    selectedEndpoint?: string;
    candidateEndpoints?: Array<{
      endpoint: string;
      advertised?: number;
      missing?: number;
      fetched?: number;
      error?: string;
    }>;
    skipped?: boolean;
    skipReason?: string;
    advertised: number;
    missing: number;
    fetched: number;
    accepted: number;
    inserted: number;
    rejected?: Array<{
      blockId: string;
      code: string;
      message: string;
    }>;
    error?: string;
  }>;
  advertisedBlocks: number;
  missingBlocks: number;
  fetchedBlocks: number;
  acceptedBlocks: number;
  insertedBlocks: number;
  rejectedBlocks: number;
  finalTip?: string;
}

export interface BlockInventoryEntry {
  sequence: number;
  blockId: string;
  kind: string;
  parentTips: string[];
  payloadHash: string;
  createdAt: string;
  sizeBytes: number;
  blobDigests?: string[];
}

export interface LaneInventory extends LaneRef {
  tip?: string;
  heads?: string[];
  blockCount: number;
  archivedCount: number;
  blocks: BlockInventoryEntry[];
}

export interface ProjectLaneInventoryInput {
  projectId: string;
  taskId?: string;
  laneId?: string;
}

export interface ProjectLaneInventoryEntry extends LaneRef {
  tip?: string;
  heads?: string[];
  leaseEpoch: number;
  blockCount: number;
  archivedCount: number;
  updatedAt?: string;
}

export interface ProjectLaneInventory extends ProjectLaneInventoryInput {
  lanes: ProjectLaneInventoryEntry[];
}

export interface RetentionApplyInput extends LaneRef {
  keepRecent?: number;
  requireSnapshot?: boolean;
  allowWithoutSnapshot?: boolean;
  reason?: string;
  now?: string;
}

export interface RetentionApplyResult extends LaneRef {
  archivedBlocks: number;
  activeBlocks: number;
  archivedAt?: string;
  latestSnapshot?: string;
  requireSnapshot: boolean;
}

export interface BlobGetResult {
  digest: string;
  sizeBytes: number;
  contentBase64: string;
}

export type OverlayDiscoveryProvider = "tailscale" | "zerotier";

export interface PeerDiscoverInput {
  providers?: OverlayDiscoveryProvider[];
  port: number;
  trustedNames?: string[];
  trustedNodeIds?: string[];
}

export interface DiscoveredPeer {
  provider: OverlayDiscoveryProvider;
  nodeId?: string;
  name?: string;
  endpoint: string;
  online: boolean;
}

export interface PeerDiscoverResult {
  peers: DiscoveredPeer[];
  warnings?: string[];
}

export interface TrustedPeer {
  endpoint: string;
  nodeId?: string;
  name?: string;
  publicKey?: string;
  provider?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  lastGoodEndpoint?: string;
  lastError?: string;
}

export interface PeerTrustAddInput {
  endpoint: string;
  nodeId?: string;
  name?: string;
  publicKey?: string;
  provider?: string;
  enabled?: boolean;
  now?: string;
}

export interface PeerTrustListInput {
  includeDisabled?: boolean;
}

export interface PeerTrustListResult {
  peers: TrustedPeer[];
}

export interface PeerTrustRemoveInput {
  endpoint: string;
}

export interface PeerTrustRemoveResult {
  endpoint: string;
  removed: boolean;
}

export interface MdnsAdvertiseStartInput {
  name: string;
  service?: string;
  domain?: string;
  port: number;
  txt: string[];
  endpoint: string;
  nodeId: string;
  provider?: string;
  projects?: string[];
  now?: string;
}

export interface MdnsAdvertiseState {
  running: boolean;
  name?: string;
  service?: string;
  domain?: string;
  port?: number;
  endpoint?: string;
  nodeId?: string;
  provider?: string;
  projects?: string[];
  startedAt?: string;
}

export interface MdnsAdvertiseStopResult {
  stopped: boolean;
}

interface JsonRpcResponse<TResult> {
  jsonrpc: "2.0";
  id: string;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class LocalDaemonProvider extends BaseContinuityProvider {
  private readonly client: UnixJsonRpcClient;

  constructor(options: LocalDaemonProviderOptions = {}) {
    super();
    this.client = new UnixJsonRpcClient({
      socketPath: options.socketPath ?? defaultContinuitydSocketPath(),
      timeoutMs: options.timeoutMs,
    });
  }

  async health(): Promise<ProviderHealth> {
    return this.client.call<ProviderHealth>("provider.health", {});
  }

  async status(input: LaneStatusInput): Promise<LaneStatus> {
    return this.client.call<LaneStatus>("lane.status", input);
  }

  async blocks(ref: LaneRef): Promise<TaskBlock[]> {
    return (await this.client.call<TaskBlock[] | null>("lane.blocks", ref)) ?? [];
  }

  async laneInventory(ref: LaneRef): Promise<LaneInventory> {
    return this.client.call<LaneInventory>("lane.inventory", ref);
  }

  async projectInventory(input: ProjectLaneInventoryInput): Promise<ProjectLaneInventory> {
    return this.client.call<ProjectLaneInventory>("project.inventory", input);
  }

  async applyRetention(input: RetentionApplyInput): Promise<RetentionApplyResult> {
    return this.client.call<RetentionApplyResult>("retention.apply", input);
  }

  async blob(digest: string): Promise<BlobGetResult> {
    return this.client.call<BlobGetResult>("blob.get", { digest });
  }

  async latestSessionEnvelope(): Promise<LaneProjection | null> {
    return this.client.call<LaneProjection | null>("session.last", {});
  }

  async submitBlock(block: TaskBlock, options?: { now?: string }): Promise<ProviderSubmitResult> {
    return this.client.call<ProviderSubmitResult>("block.submit", { block, now: options?.now });
  }

  async rebuildProjections(): Promise<{ replayed: number }> {
    return this.client.call<{ replayed: number }>("projection.rebuild", {});
  }

  async syncPeers(input: PeerSyncInput): Promise<PeerSyncResult> {
    return this.client.call<PeerSyncResult>("peer.sync", input);
  }

  async syncTrustedPeers(input: PeerSyncTrustedInput): Promise<PeerSyncResult> {
    return this.client.call<PeerSyncResult>("peer.syncTrusted", input);
  }

  async trustPeer(input: PeerTrustAddInput): Promise<TrustedPeer> {
    return this.client.call<TrustedPeer>("peer.trustAdd", input);
  }

  async listTrustedPeers(input: PeerTrustListInput = {}): Promise<PeerTrustListResult> {
    return this.client.call<PeerTrustListResult>("peer.trustList", input);
  }

  async removeTrustedPeer(input: PeerTrustRemoveInput): Promise<PeerTrustRemoveResult> {
    return this.client.call<PeerTrustRemoveResult>("peer.trustRemove", input);
  }

  async discoverPeers(input: PeerDiscoverInput): Promise<PeerDiscoverResult> {
    return this.client.call<PeerDiscoverResult>("peer.discover", input);
  }

  async startMdnsAdvertiser(input: MdnsAdvertiseStartInput): Promise<MdnsAdvertiseState> {
    return this.client.call<MdnsAdvertiseState>("mdns.advertiseStart", input);
  }

  async mdnsAdvertiserStatus(): Promise<MdnsAdvertiseState> {
    return this.client.call<MdnsAdvertiseState>("mdns.advertiseStatus", {});
  }

  async stopMdnsAdvertiser(): Promise<MdnsAdvertiseStopResult> {
    return this.client.call<MdnsAdvertiseStopResult>("mdns.advertiseStop", {});
  }
}

export class UnixJsonRpcClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: { socketPath: string; timeoutMs?: number }) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  call<TResult>(method: string, params: unknown): Promise<TResult> {
    const id = randomUUID();
    const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise<TResult>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      let response = "";
      const timer = setTimeout(() => {
        fail(new Error(`JSON-RPC call ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const finish = (result: TResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      const decodeLine = (line: string): void => {
        try {
          const decoded = JSON.parse(line) as JsonRpcResponse<TResult>;
          if (decoded.id !== id) {
            fail(new Error(`JSON-RPC response id mismatch: expected ${id}, got ${String(decoded.id)}`));
            return;
          }
          if (decoded.error) {
            const detail = decoded.error.data === undefined ? "" : ` (${JSON.stringify(decoded.error.data)})`;
            fail(new Error(`JSON-RPC ${decoded.error.code} ${decoded.error.message}${detail}`));
            return;
          }
          finish(decoded.result as TResult);
        } catch (error) {
          fail(new Error(`invalid JSON-RPC response from ${this.socketPath}: ${(error as Error).message}`));
        }
      };

      const tryDecodeResponse = (): boolean => {
        const newline = response.indexOf("\n");
        const line = newline >= 0 ? response.slice(0, newline).trim() : "";
        if (!line) return false;
        decodeLine(line);
        return true;
      };

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.end(request);
      });
      socket.on("data", (chunk) => {
        response += chunk;
        tryDecodeResponse();
      });
      socket.on("error", (error) => {
        fail(new Error(`JSON-RPC ${method} failed on ${this.socketPath}: ${error.message}`));
      });
      socket.on("end", () => {
        if (!settled && !tryDecodeResponse()) fail(new Error(`JSON-RPC ${method} ended without a complete response`));
      });
    });
  }
}

export function defaultContinuitydSocketPath(home = os.homedir()): string {
  return process.env.CONTINUITYD_SOCKET ?? path.join(home, ".local", "state", "agent-continuity", "continuityd.sock");
}
