import type { ActorRef, LaneRef, TaskBlock } from "./block.js";
import type { LaneStatus, ProviderHealth } from "./provider.js";
import type { PeerDiscoverInput, PeerDiscoverResult } from "./daemon-provider.js";

export interface DashboardProvider {
  health(): Promise<ProviderHealth>;
  status(input: LaneRef & { actor?: ActorRef; now?: string }): Promise<LaneStatus>;
  blocks(ref: LaneRef): Promise<TaskBlock[]>;
  discoverPeers?(input: PeerDiscoverInput): Promise<PeerDiscoverResult>;
}

export interface DashboardOptions extends LaneRef {
  actor?: ActorRef;
  now?: string;
  discovery?: PeerDiscoverInput;
  recentLimit?: number;
}

export interface DashboardSnapshot extends LaneRef {
  generatedAt: string;
  health: ProviderHealth;
  status: LaneStatus;
  blockCount: number;
  recentBlocks: TaskBlock[];
  discovery?: PeerDiscoverResult;
}

export async function loadDashboardSnapshot(provider: DashboardProvider, options: DashboardOptions): Promise<DashboardSnapshot> {
  const ref: LaneRef = {
    projectId: options.projectId,
    taskId: options.taskId,
    laneId: options.laneId,
  };
  const [health, status, blocks] = await Promise.all([
    provider.health(),
    provider.status({ ...ref, actor: options.actor, now: options.now }),
    provider.blocks(ref),
  ]);

  const recentLimit = options.recentLimit ?? 5;
  const recentBlocks = [...blocks]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(Math.max(0, blocks.length - recentLimit));
  const discovery = options.discovery && provider.discoverPeers ? await provider.discoverPeers(options.discovery) : undefined;

  return {
    ...ref,
    generatedAt: options.now ?? new Date().toISOString(),
    health,
    status,
    blockCount: blocks.length,
    recentBlocks,
    discovery,
  };
}

export function renderDashboard(snapshot: DashboardSnapshot): string {
  const lane = snapshot.status.lane;
  const owner = lane.owner ? `${lane.owner.nodeId}/${lane.owner.actorId}` : "none";
  const lease = lane.owner?.leaseUntil ? `${lane.leaseEpoch} until ${lane.owner.leaseUntil}` : String(lane.leaseEpoch);
  const lines = [
    "Continuity Dashboard",
    "====================",
    kv("generated", snapshot.generatedAt),
    kv("provider", `${snapshot.health.provider} v${snapshot.health.version} ${snapshot.health.ok ? "ok" : "unhealthy"}`),
    kv("project", snapshot.projectId),
    kv("task", snapshot.taskId),
    kv("lane", snapshot.laneId),
    "",
    "Lane",
    "----",
    kv("action", snapshot.status.reason ? `${snapshot.status.action} (${snapshot.status.reason})` : snapshot.status.action),
    kv("tip", lane.tip ?? "<empty>"),
    kv("owner", owner),
    kv("lease_epoch", lease),
    kv("blocks", String(snapshot.blockCount)),
  ];

  if (lane.checkpoint) {
    lines.push(
      "",
      "Checkpoint",
      "----------",
      kv("status", lane.checkpoint.status),
      kv("progress", lane.checkpoint.progress),
      kv("blocking", lane.checkpoint.blocking ?? "None"),
      kv("next", lane.checkpoint.next ?? "None"),
    );
  }

  lines.push("", "Recent Blocks", "-------------");
  if (snapshot.recentBlocks.length === 0) {
    lines.push("- none");
  } else {
    for (const block of snapshot.recentBlocks) {
      lines.push(`- ${block.createdAt} ${block.kind} ${shortID(block.blockId)} ${block.nodeId}/${block.actorId}`);
    }
  }

  if (snapshot.discovery) {
    lines.push("", "Discovered Peers", "----------------");
    if (snapshot.discovery.peers.length === 0) {
      lines.push("- none");
    } else {
      for (const peer of snapshot.discovery.peers) {
        const name = peer.name ?? peer.nodeId ?? "unknown";
        lines.push(`- ${peer.provider} ${name} ${peer.endpoint} ${peer.online ? "online" : "offline"}`);
      }
    }
    if (snapshot.discovery.warnings?.length) {
      lines.push("", "Warnings", "--------");
      for (const warning of snapshot.discovery.warnings) {
        lines.push(`- ${warning}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function kv(label: string, value: string): string {
  return `${label.padEnd(12)} ${value}`;
}

function shortID(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}
