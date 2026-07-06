#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { claimAgentLane, handoffAgentLane, orientAgent, runAgentCommand } from "./agent-harness.js";
import { defaultCheckpointInput, loadConfig, maskDatabaseUrl } from "./config.js";
import { loadDashboardSnapshot, renderDashboard } from "./dashboard.js";
import { daemonStatus, startDaemon, stopDaemon } from "./daemon-lifecycle.js";
import { daemonConfigFromInstallResult, defaultDaemonRuntimeConfig, installDaemonRuntime } from "./daemon-install.js";
import { LocalDaemonProvider, type OverlayDiscoveryProvider } from "./daemon-provider.js";
import { readDaemonCanon, runDaemonCheckpoint } from "./daemon-workflow.js";
import { installAgentContinuity, type InstallTarget } from "./install.js";
import { migratePostgresTaskToProvider } from "./migration.js";
import {
  advertiseMdnsPresence,
  createPeerInvite,
  createPeerPresence,
  decodePeerInvite,
  defaultMdnsEndpoint,
  defaultPresenceName,
  discoverMdnsPeers,
  discoverRendezvousPeers,
  encodePeerInvite,
  mdnsTxtForPresence,
  peerTrustInputFromDiscovery,
  peerTrustInputFromInvite,
  publishRendezvousPresence,
  readMdnsAdvertiserStatus,
  requireTrustedFilterForAdd,
  startMdnsAdvertiser,
  stopMdnsAdvertiser,
  type DiscoveryFilter,
  type DiscoveredOnboardingPeer,
} from "./peer-onboarding.js";
import { inferProjectId } from "./project.js";
import { discoverRendezvousPeersFromTarget, publishRendezvousPresenceToTarget, type RendezvousTarget } from "./rendezvous-backend.js";
import {
  loadSchedulerState,
  registerWorkerProfile,
  renderSchedulerDashboard,
  runSchedulerOnce,
  submitTaskAdjudication,
  submitTaskEvaluation,
  submitTaskIntent,
  submitTaskResult,
  type SchedulerRunner,
} from "./scheduler.js";
import { parseSchedulerWorkerPreset, schedulerWorkerPreset, resolveSchedulerWorkerProfile, type SchedulerWorkerPresetName } from "./scheduler-presets.js";
import {
  attachTmuxSession,
  defaultSchedulerWorkerTmuxSession,
  runSchedulerWorkerLoop,
  startTmuxSession,
  stopTmuxSession,
  tmuxSessionStatus,
  type SchedulerWorkerLoopEvent,
} from "./scheduler-worker.js";
import { loadOrCreateNodeSigner } from "./signer-store.js";
import { backupRuntime, doctor, installProduct, setupLocal, startRuntime, stopRuntime, uninstallProduct, type ActionReport } from "./setup.js";
import { continuityStatus, importCheckpoint, readCanon, reconcileCanon, runCheckpoint } from "./workflow.js";
import type { ContinuityConfig, DaemonRuntimeConfig } from "./types.js";
import type { LaneSnapshotPayload, TaskAdjudicationPayload, TaskEvaluationPayload, TaskIntentPayload, TaskResultPayload, WorkerProfilePayload } from "./block.js";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const config = commandConfig(parsed);

  switch (parsed.command) {
    case "setup": {
      if (parsed.options.local !== true) throw new Error("only local setup is supported: use continuity setup --local");
      const result = await setupLocal({
        home: stringOption(parsed, "home"),
        runtime: stringOption(parsed, "runtime") as "docker" | undefined,
        install: parsed.options["no-install"] !== true,
        image: stringOption(parsed, "image"),
        containerName: stringOption(parsed, "container-name"),
        volumeName: stringOption(parsed, "volume-name"),
        host: stringOption(parsed, "host"),
        port: numberOption(parsed, "port"),
        database: stringOption(parsed, "database"),
        user: stringOption(parsed, "user"),
        password: stringOption(parsed, "password"),
        queueName: stringOption(parsed, "queue"),
        checkpointDir: stringOption(parsed, "checkpoint-dir"),
        daemon: parsed.options.daemon === true,
        daemonLaunchd: parsed.options["daemon-launchd"] === true,
        daemonPeerListen: stringOption(parsed, "daemon-peer-listen"),
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, databaseUrl: maskDatabaseUrl(result.databaseUrl) }, null, 2));
      else {
        console.log(`config: ${result.configPath}`);
        console.log(`database: ${maskDatabaseUrl(result.databaseUrl)}`);
        printActions(result.actions);
        console.log("Run `continuity doctor` to verify the installation.");
      }
      return;
    }
    case "checkpoint": {
      const canonFile = stringOption(parsed, "canon-file");
      const input = defaultCheckpointInput({
        taskId: stringOption(parsed, "task-id"),
        timestamp: stringOption(parsed, "timestamp"),
        modelId: stringOption(parsed, "model-id"),
        sessionId: stringOption(parsed, "session-id"),
        status: stringOption(parsed, "status") as never,
        progress: stringOption(parsed, "progress"),
        files: stringOption(parsed, "files"),
        blocking: stringOption(parsed, "blocking"),
        next: stringOption(parsed, "next"),
        canonMarkdown: canonFile ? await readFile(canonFile, "utf8") : stringOption(parsed, "canon"),
        checkpointDir: stringOption(parsed, "checkpoint-dir"),
        source: stringOption(parsed, "source") ?? (parsed.options.daemon === true ? "daemon-cli" : "cli"),
      });
      if (parsed.options.daemon === true) {
        const daemon = daemonRuntimeFromOptions(parsed, config);
        const projectId = await projectIdOption(parsed);
        const result = await runDaemonCheckpoint({
          ...input,
          projectId,
          laneId: stringOption(parsed, "lane-id") ?? "main",
          provider: new LocalDaemonProvider({ socketPath: daemon.socketPath, timeoutMs: numberOption(parsed, "timeout-ms") }),
          stateDir: daemon.stateDir,
          keyFile: stringOption(parsed, "key-file"),
          nodeId: stringOption(parsed, "node-id"),
          actorId: stringOption(parsed, "actor-id"),
          leaseUntil: stringOption(parsed, "lease-until"),
        });
        if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`<checkpoint>
Status: ${result.appended ? "Accepted daemon checkpoint block" : "Daemon checkpoint block already existed"}
Provider: daemon
Project: ${result.projectId}
Task: ${result.taskId}
Lane: ${result.laneId}
Block: ${result.blockId ?? "<none>"}
Tip: ${result.finalTip ?? "<empty>"}
Actor: ${result.actor.nodeId}/${result.actor.actorId}
Summary: ${input.progress}
</checkpoint>`);
        }
        return;
      }

      requireDatabaseConfig(config);
      const result = await runCheckpoint(input, config);
      if (parsed.options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`<checkpoint>
Status: ${result.appended ? "Appended checkpoint entry" : "Checkpoint entry already existed"}
File: ${result.journalPath}
Canon: ${result.canonPath}
Summary: ${input.progress}
</checkpoint>`);
      }
      return;
    }
    case "resume": {
      const taskId = requiredOption(parsed, "task-id");
      if (parsed.options.daemon === true) {
        const daemon = daemonRuntimeFromOptions(parsed, config);
        const provider = new LocalDaemonProvider({ socketPath: daemon.socketPath, timeoutMs: numberOption(parsed, "timeout-ms") });
        const ref = {
          projectId: await projectIdOption(parsed),
          taskId,
          laneId: stringOption(parsed, "lane-id") ?? "main",
        };
        const sync = parsed.options.sync === true ? await provider.syncTrustedPeers(ref) : undefined;
        const result = await readDaemonCanon({
          ...ref,
          provider,
        });
        if (!result.canonMarkdown) throw new Error(`no daemon canon found for ${result.projectId}/${result.taskId}/${result.laneId}`);
        if (parsed.options.json) console.log(JSON.stringify({ ...result, sync }, null, 2));
        else console.log(result.canonMarkdown.endsWith("\n") ? result.canonMarkdown.trimEnd() : result.canonMarkdown);
        return;
      }
      requireDatabaseConfig(config);
      const canon = await readCanon(taskId, config);
      if (!canon) throw new Error(`no canon found for task ${taskId}`);
      console.log(canon.endsWith("\n") ? canon.trimEnd() : canon);
      return;
    }
    case "reconcile": {
      requireDatabaseConfig(config);
      const taskId = requiredOption(parsed, "task-id");
      const canonFile = requiredOption(parsed, "canon-file");
      const result = await reconcileCanon(taskId, await readFile(canonFile, "utf8"), config, stringOption(parsed, "checkpoint-dir"));
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`<checkpoint>
Status: Reconciled canon
File: ${result.journalPath}
Canon: ${result.canonPath}
Summary: ${taskId} reconciled at ${result.lastReconciled}
</checkpoint>`);
      }
      return;
    }
    case "import": {
      requireDatabaseConfig(config);
      const taskId = requiredOption(parsed, "task-id");
      const journalFile = requiredOption(parsed, "journal-file");
      const canonFile = requiredOption(parsed, "canon-file");
      const result = await importCheckpoint(
        taskId,
        await readFile(journalFile, "utf8"),
        await readFile(canonFile, "utf8"),
        config,
        stringOption(parsed, "checkpoint-dir"),
      );
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`<checkpoint>
Status: Imported checkpoint projection
File: ${result.journalPath}
Canon: ${result.canonPath}
Summary: ${taskId} imported ${result.imported} new journal entries
</checkpoint>`);
      }
      return;
    }
    case "status": {
      requireDatabaseConfig(config);
      const status = await continuityStatus(config);
      if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`database: ${maskDatabaseUrl(config.databaseUrl)}`);
        console.log(`queue: ${config.queueName}`);
        console.log(`checkpointDir: ${config.checkpointDir}`);
        console.log(`tasks: ${status.tasks}`);
        console.log(`journalEntries: ${status.journalEntries}`);
        console.log(`canons: ${status.canons}`);
      }
      return;
    }
    case "dashboard": {
      const projectId = requiredOption(parsed, "project-id");
      const taskId = requiredOption(parsed, "task-id");
      const laneId = stringOption(parsed, "lane-id") ?? "main";
      const actorNodeId = stringOption(parsed, "actor-node-id");
      const actorId = stringOption(parsed, "actor-id");
      if ((actorNodeId && !actorId) || (!actorNodeId && actorId)) {
        throw new Error("--actor-node-id and --actor-id must be provided together");
      }

      const recentLimit = numberOption(parsed, "recent");
      if (recentLimit !== undefined && recentLimit <= 0) throw new Error("--recent must be greater than zero");

      const trustedNames = listOption(parsed, "trusted-names");
      const trustedNodeIds = listOption(parsed, "trusted-node-ids");
      const providers = discoveryProviders(parsed);
      const peerPort = numberOption(parsed, "peer-port");
      const discoveryRequested = peerPort !== undefined || trustedNames.length > 0 || trustedNodeIds.length > 0 || providers.length > 0;
      if (discoveryRequested && peerPort === undefined) {
        throw new Error("--peer-port is required when discovery options are provided");
      }
      if (peerPort !== undefined && trustedNames.length === 0 && trustedNodeIds.length === 0) {
        throw new Error("--peer-port requires --trusted-names or --trusted-node-ids");
      }

      const provider = new LocalDaemonProvider({
        socketPath: stringOption(parsed, "socket"),
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      const snapshot = await loadDashboardSnapshot(provider, {
        projectId,
        taskId,
        laneId,
        actor: actorNodeId && actorId ? { nodeId: actorNodeId, actorId } : undefined,
        now: stringOption(parsed, "now"),
        recentLimit,
        discovery:
          peerPort === undefined
            ? undefined
            : {
                port: peerPort,
                providers: providers.length > 0 ? providers : undefined,
                trustedNames: trustedNames.length > 0 ? trustedNames : undefined,
                trustedNodeIds: trustedNodeIds.length > 0 ? trustedNodeIds : undefined,
              },
      });

      if (parsed.options.json) console.log(JSON.stringify(snapshot, null, 2));
      else console.log(renderDashboard(snapshot).trimEnd());
      return;
    }
    case "orient": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await agentLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "agent-cli");
      const result = await orientAgent({
        ...ref,
        provider,
        actor: signer.signer,
        now: stringOption(parsed, "now"),
        syncBeforeOrient: parsed.options.sync === true ? () => provider.syncTrustedPeers(ref) : undefined,
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else console.log(result.prompt);
      return;
    }
    case "claim": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await agentLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "agent-cli");
      if (parsed.options.sync === true) await provider.syncTrustedPeers(ref);
      const result = await claimAgentLane({
        ...ref,
        provider,
        signer: signer.signer,
        now: stringOption(parsed, "now"),
        createdAt: stringOption(parsed, "now"),
        leaseUntil: stringOption(parsed, "lease-until"),
        reason: stringOption(parsed, "reason"),
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`project: ${result.projectId}`);
        console.log(`task: ${result.taskId}`);
        console.log(`lane: ${result.laneId}`);
        console.log(`action: ${result.action}`);
        console.log(`owner: ${result.lane.owner ? `${result.lane.owner.nodeId}/${result.lane.owner.actorId}` : "<none>"}`);
        console.log(`tip: ${result.lane.tip ?? "<empty>"}`);
      }
      return;
    }
    case "save": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await agentLaneRef(parsed);
      if (parsed.options.sync === true) await provider.syncTrustedPeers(ref);
      const canonFile = stringOption(parsed, "canon-file");
      const input = defaultCheckpointInput({
        taskId: ref.taskId,
        timestamp: stringOption(parsed, "timestamp") ?? stringOption(parsed, "now"),
        modelId: stringOption(parsed, "model-id"),
        sessionId: stringOption(parsed, "session-id"),
        status: stringOption(parsed, "status") as never,
        progress: requiredOption(parsed, "progress"),
        files: stringOption(parsed, "files"),
        blocking: stringOption(parsed, "blocking"),
        next: stringOption(parsed, "next"),
        canonMarkdown: canonFile ? await readFile(canonFile, "utf8") : stringOption(parsed, "canon"),
        checkpointDir: stringOption(parsed, "checkpoint-dir"),
        source: stringOption(parsed, "source") ?? "agent-save",
      });
      const result = await runDaemonCheckpoint({
        ...input,
        ...ref,
        provider,
        stateDir: daemonRuntimeFromOptions(parsed, config).stateDir,
        keyFile: stringOption(parsed, "key-file"),
        nodeId: stringOption(parsed, "node-id"),
        actorId: stringOption(parsed, "actor-id"),
        leaseUntil: stringOption(parsed, "lease-until"),
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`saved: ${result.appended ? "yes" : "already-exists"}`);
        console.log(`project: ${result.projectId}`);
        console.log(`task: ${result.taskId}`);
        console.log(`lane: ${result.laneId}`);
        console.log(`block: ${result.blockId ?? "<none>"}`);
        console.log(`tip: ${result.finalTip ?? "<empty>"}`);
      }
      return;
    }
    case "handoff": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await agentLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "agent-cli");
      if (parsed.options.sync === true) await provider.syncTrustedPeers(ref);
      const result = await handoffAgentLane({
        ...ref,
        provider,
        signer: signer.signer,
        now: stringOption(parsed, "now"),
        createdAt: stringOption(parsed, "now"),
        leaseUntil: stringOption(parsed, "lease-until"),
        targetNodeId: stringOption(parsed, "target-node-id"),
        targetActorId: stringOption(parsed, "target-actor-id"),
        releaseReason: stringOption(parsed, "reason"),
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`mode: ${result.mode}`);
        console.log(`accepted: ${result.accepted ? "yes" : "no"}`);
        console.log(`action: ${result.action}`);
        console.log(`block: ${result.block?.blockId ?? "<none>"}`);
        console.log(`owner: ${result.lane.owner ? `${result.lane.owner.nodeId}/${result.lane.owner.actorId}` : "<none>"}`);
        if (result.rejection) console.log(`rejection: ${result.rejection.code}: ${result.rejection.message}`);
      }
      return;
    }
    case "agent-run": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await agentLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "agent-cli");
      const result = await runAgentCommand({
        ...ref,
        provider,
        signer: signer.signer,
        command: requiredOption(parsed, "command"),
        allowedCommands: listOption(parsed, "allowed-commands"),
        cwd: stringOption(parsed, "cwd"),
        now: stringOption(parsed, "now"),
        createdAt: stringOption(parsed, "now"),
        leaseUntil: stringOption(parsed, "lease-until"),
        claimReason: stringOption(parsed, "reason"),
        timeoutMs: numberOption(parsed, "timeout-ms"),
        syncBeforeOrient: parsed.options.sync === true ? () => provider.syncTrustedPeers(ref) : undefined,
        checkpoint: {
          enabled: parsed.options["no-checkpoint"] !== true,
          stateDir: daemonRuntimeFromOptions(parsed, config).stateDir,
          keyFile: stringOption(parsed, "key-file"),
          timestamp: stringOption(parsed, "timestamp") ?? stringOption(parsed, "now"),
          modelId: stringOption(parsed, "model-id"),
          sessionId: stringOption(parsed, "session-id"),
          source: stringOption(parsed, "source") ?? "agent-run",
          next: stringOption(parsed, "next"),
        },
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`exitCode: ${result.exitCode}`);
        if (result.stdout.trim()) console.log(`stdout:\n${result.stdout.trimEnd()}`);
        if (result.stderr.trim()) console.log(`stderr:\n${result.stderr.trimEnd()}`);
        if (result.checkpoint) console.log(`checkpoint: ${result.checkpoint.blockId ?? "<none>"}`);
      }
      process.exitCode = result.exitCode === 0 ? 0 : result.exitCode;
      return;
    }
    case "scheduler-dashboard": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const sync = parsed.options.sync === true ? await provider.syncTrustedPeers(ref) : undefined;
      const state = await loadSchedulerState(provider, ref);
      if (parsed.options.json) console.log(JSON.stringify({ ...state, sync }, null, 2));
      else {
        if (sync) console.log(`sync: inserted ${sync.insertedBlocks}, rejected ${sync.rejectedBlocks}`);
        console.log(renderSchedulerDashboard(state).trimEnd());
      }
      return;
    }
    case "scheduler-worker-register": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-worker-cli");
      const block = await registerWorkerProfile({
        ...ref,
        provider,
        signer: signer.signer,
        createdAt: stringOption(parsed, "now"),
        payload: workerProfilePayload(parsed, signer.signer.nodeId),
      });
      const output = { block, keyPath: signer.keyPath, keyCreated: signer.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`worker: ${block.payload.workerId}`);
        console.log(`agent: ${block.payload.agent}`);
        console.log(`block: ${block.blockId}`);
        console.log(`tip: ${block.blockId}`);
        if (block.payload.tmuxSession) console.log(`tmux: ${block.payload.tmuxSession}`);
      }
      return;
    }
    case "scheduler-task-submit": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-orchestrator-cli");
      const instructions = await instructionsOption(parsed);
      const block = await submitTaskIntent({
        ...ref,
        provider,
        signer: signer.signer,
        createdAt: stringOption(parsed, "now"),
        payload: {
          title: requiredOption(parsed, "title"),
          instructions,
          targetLaneId: stringOption(parsed, "target-lane-id"),
          policy: schedulerPolicyOption(parsed),
          priority: numberOption(parsed, "priority"),
          requirements: schedulerRequirementsOption(parsed),
          evaluation: schedulerEvaluationSpecOption(parsed),
          idempotencyKey: stringOption(parsed, "idempotency-key"),
        },
      });
      const output = { block, keyPath: signer.keyPath, keyCreated: signer.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`task: ${block.payload.title}`);
        console.log(`block: ${block.blockId}`);
        console.log(`policy: ${block.payload.policy ?? "exclusive"}`);
        console.log(`tip: ${block.blockId}`);
      }
      return;
    }
    case "scheduler-run-once": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const sync = parsed.options.sync === true ? await provider.syncTrustedPeers(ref) : undefined;
      const signer = await signerFromOptions(parsed, config, "scheduler-worker-cli");
      const result = await runSchedulerOnce({
        ...ref,
        provider,
        signer: signer.signer,
        worker: workerProfilePayload(parsed, signer.signer.nodeId),
        runner: schedulerRunnerOption(parsed, schedulerWorkerPresetOption(parsed)?.runner),
        command: schedulerWorkerCommandOption(parsed),
        tmuxSession: stringOption(parsed, "tmux-session"),
        keepTmuxSession: parsed.options["kill-tmux-session"] === true ? false : undefined,
        runnerTimeoutMs: numberOption(parsed, "runner-timeout-ms"),
        now: stringOption(parsed, "now"),
        leaseMs: numberOption(parsed, "lease-ms"),
        worktreeRoot: stringOption(parsed, "worktree-root"),
      });
      const output = { ...result, sync, keyPath: signer.keyPath, keyCreated: signer.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        if (sync) console.log(`sync: inserted ${sync.insertedBlocks}, rejected ${sync.rejectedBlocks}`);
        console.log(`worker: ${result.workerId}`);
        console.log(`status: ${result.status}`);
        if (result.intent) console.log(`intent: ${result.intent.blockId} (${result.intent.payload.title})`);
        if (result.assignmentBlock) console.log(`assignment: ${result.assignmentBlock.blockId}`);
        if (result.resultBlock) console.log(`result: ${result.resultBlock.blockId}`);
        console.log(`summary: ${result.summary}`);
      }
      return;
    }
    case "scheduler-worker-loop": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-worker-cli");
      const events: SchedulerWorkerLoopEvent[] = [];
      const json = parsed.options.json === true;
      const summary = await runSchedulerWorkerLoop({
        ...ref,
        provider,
        signer: signer.signer,
        worker: workerProfilePayload(parsed, signer.signer.nodeId),
        runner: schedulerRunnerOption(parsed, schedulerWorkerPresetOption(parsed)?.runner),
        command: schedulerWorkerCommandOption(parsed),
        tmuxSession: stringOption(parsed, "tmux-session"),
        keepTmuxSession: parsed.options["kill-tmux-session"] === true ? false : undefined,
        runnerTimeoutMs: numberOption(parsed, "runner-timeout-ms"),
        leaseMs: numberOption(parsed, "lease-ms"),
        allowedProjectIds: listOptions(parsed, "allowed-project-ids", "allow-project-ids"),
        allowedCommands: listOption(parsed, "allowed-commands"),
        maxRunnerTimeoutMs: numberOption(parsed, "max-runner-timeout-ms"),
        worktreeRoot: stringOption(parsed, "worktree-root"),
        intervalMs: numberOption(parsed, "interval-ms"),
        maxRuns: numberOption(parsed, "max-runs"),
        idleLimit: numberOption(parsed, "idle-limit"),
        durationMs: numberOption(parsed, "duration-ms"),
        maxErrors: numberOption(parsed, "max-errors"),
        syncBeforeRun: parsed.options.sync === true ? () => provider.syncTrustedPeers(ref) : undefined,
        onEvent: (event) => {
          if (json) events.push(event);
          else printSchedulerWorkerLoopEvent(event);
        },
      });
      const output = { summary, events, keyPath: signer.keyPath, keyCreated: signer.created };
      if (json) console.log(JSON.stringify(output, null, 2));
      else printSchedulerWorkerLoopSummary(summary);
      return;
    }
    case "scheduler-worker-start": {
      const { status, command } = await startSchedulerWorkerFromParsed(parsed, config);
      if (parsed.options.json) console.log(JSON.stringify({ ...status, command }, null, 2));
      else {
        console.log(`session: ${status.session}`);
        console.log(`running: ${status.running ? "yes" : "no"}`);
        console.log(`attach: continuity scheduler-worker-attach --manager-tmux-session ${status.session}`);
      }
      return;
    }
    case "scheduler-worker-status": {
      const session = schedulerManagerTmuxSession(parsed, stringOption(parsed, "worker-id"));
      const status = await tmuxSessionStatus({ session, tailLines: numberOption(parsed, "tail-lines") });
      if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`session: ${status.session}`);
        console.log(`running: ${status.running ? "yes" : "no"}`);
        if (status.tail) console.log(`tail:\n${status.tail}`);
      }
      return;
    }
    case "scheduler-worker-stop": {
      const session = schedulerManagerTmuxSession(parsed, stringOption(parsed, "worker-id"));
      const status = await stopTmuxSession({ session });
      if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`session: ${status.session}`);
        console.log("running: no");
      }
      return;
    }
    case "scheduler-worker-attach": {
      const session = schedulerManagerTmuxSession(parsed, stringOption(parsed, "worker-id"));
      const code = await attachTmuxSession({ session });
      process.exitCode = code;
      return;
    }
    case "scheduler-result": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-worker-cli");
      const block = await submitTaskResult({
        ...ref,
        provider,
        signer: signer.signer,
        createdAt: stringOption(parsed, "now"),
        payload: {
          intentBlockId: requiredOption(parsed, "intent-block-id"),
          assignmentBlockId: stringOption(parsed, "assignment-block-id"),
          workerId: requiredOption(parsed, "worker-id"),
          status: schedulerResultStatusOption(parsed),
          summary: requiredOption(parsed, "summary"),
          artifacts: listOrUndefined(parsed, "artifacts"),
          exitCode: numberOption(parsed, "exit-code"),
          tmuxSession: stringOption(parsed, "tmux-session"),
        },
      });
      if (parsed.options.json) console.log(JSON.stringify({ block, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`worker: ${block.payload.workerId}`);
        console.log(`status: ${block.payload.status}`);
        console.log(`result: ${block.blockId}`);
        console.log(`summary: ${block.payload.summary}`);
      }
      return;
    }
    case "scheduler-evaluate": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-evaluator-cli");
      const status = await provider.status(ref);
      const resultBlockIds = listOption(parsed, "result-block-ids");
      const recommendedWinnerResultBlockId = stringOption(parsed, "recommended-winner-result-block-id");
      if (resultBlockIds.length === 0) throw new Error("--result-block-ids is required");
      if (recommendedWinnerResultBlockId && !resultBlockIds.includes(recommendedWinnerResultBlockId)) {
        throw new Error("--recommended-winner-result-block-id must be one of --result-block-ids");
      }
      const parentTips = listOption(parsed, "parent-tips");
      const block = await submitTaskEvaluation({
        ...ref,
        provider,
        signer: signer.signer,
        parentTips: parentTips.length > 0 ? parentTips : status.lane.heads ?? (status.lane.tip ? [status.lane.tip] : []),
        createdAt: stringOption(parsed, "now"),
        payload: {
          intentBlockId: requiredOption(parsed, "intent-block-id"),
          resultBlockIds,
          recommendedWinnerResultBlockId,
          confidence: evaluationConfidenceOption(parsed, "confidence"),
          scores: jsonOption<TaskEvaluationPayload["scores"]>(parsed, "scores-json"),
          requiredChecks: jsonOption<TaskEvaluationPayload["requiredChecks"]>(parsed, "required-checks-json"),
          useCases: jsonOption<TaskEvaluationPayload["useCases"]>(parsed, "use-cases-json"),
          risks: listOrUndefined(parsed, "risks"),
          autoAdjudicateEligible: parsed.options["auto-adjudicate-eligible"] === true ? true : undefined,
          summary: requiredOption(parsed, "summary"),
        } satisfies TaskEvaluationPayload,
      });
      const output = { block, headsBefore: status.lane.heads ?? (status.lane.tip ? [status.lane.tip] : []), keyPath: signer.keyPath, keyCreated: signer.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`evaluation: ${block.blockId}`);
        console.log(`intent: ${block.payload.intentBlockId}`);
        if (block.payload.recommendedWinnerResultBlockId) console.log(`recommended: ${block.payload.recommendedWinnerResultBlockId}`);
        if (block.payload.confidence) console.log(`confidence: ${block.payload.confidence}`);
        console.log(`results: ${block.payload.resultBlockIds.join(",")}`);
        console.log(`summary: ${block.payload.summary}`);
        console.log(`tip: ${block.blockId}`);
      }
      return;
    }
    case "scheduler-adjudicate": {
      const provider = localDaemonProvider(parsed, config);
      const ref = await schedulerLaneRef(parsed);
      const signer = await signerFromOptions(parsed, config, "scheduler-orchestrator-cli");
      const status = await provider.status(ref);
      const resultBlockIds = listOption(parsed, "result-block-ids");
      const winnerResultBlockId = stringOption(parsed, "winner-result-block-id");
      if (resultBlockIds.length === 0) throw new Error("--result-block-ids is required");
      if (winnerResultBlockId && !resultBlockIds.includes(winnerResultBlockId)) {
        throw new Error("--winner-result-block-id must be one of --result-block-ids");
      }
      const parentTips = listOption(parsed, "parent-tips");
      const block = await submitTaskAdjudication({
        ...ref,
        provider,
        signer: signer.signer,
        parentTips: parentTips.length > 0 ? parentTips : status.lane.heads ?? (status.lane.tip ? [status.lane.tip] : []),
        createdAt: stringOption(parsed, "now"),
        payload: {
          intentBlockId: requiredOption(parsed, "intent-block-id"),
          resultBlockIds,
          winnerResultBlockId,
          summary: requiredOption(parsed, "summary"),
        } satisfies TaskAdjudicationPayload,
      });
      const output = { block, headsBefore: status.lane.heads ?? (status.lane.tip ? [status.lane.tip] : []), keyPath: signer.keyPath, keyCreated: signer.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`adjudication: ${block.blockId}`);
        console.log(`intent: ${block.payload.intentBlockId}`);
        if (block.payload.winnerResultBlockId) console.log(`winner: ${block.payload.winnerResultBlockId}`);
        console.log(`results: ${block.payload.resultBlockIds.join(",")}`);
        console.log(`tip: ${block.blockId}`);
      }
      return;
    }
    case "peer-add": {
      const provider = localDaemonProvider(parsed, config);
      const peer = await provider.trustPeer({
        endpoint: requiredOption(parsed, "endpoint"),
        nodeId: stringOption(parsed, "node-id"),
        name: stringOption(parsed, "name"),
        publicKey: stringOption(parsed, "public-key"),
        provider: stringOption(parsed, "provider"),
        enabled: parsed.options.disabled === true ? false : true,
        now: stringOption(parsed, "now"),
      });
      if (parsed.options.json) console.log(JSON.stringify(peer, null, 2));
      else {
        console.log(`peer: ${peer.endpoint}`);
        console.log(`status: ${peer.enabled ? "enabled" : "disabled"}`);
        if (peer.name) console.log(`name: ${peer.name}`);
        if (peer.nodeId) console.log(`nodeId: ${peer.nodeId}`);
        if (peer.provider) console.log(`provider: ${peer.provider}`);
      }
      return;
    }
    case "peer-list": {
      const result = await localDaemonProvider(parsed, config).listTrustedPeers({
        includeDisabled: parsed.options["include-disabled"] === true,
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else if (result.peers.length === 0) console.log("trusted peers: none");
      else {
        for (const peer of result.peers) {
          const labels = [peer.enabled ? "enabled" : "disabled", peer.provider, peer.name, peer.nodeId].filter(Boolean).join(", ");
          console.log(`${peer.endpoint}${labels ? ` (${labels})` : ""}`);
        }
      }
      return;
    }
    case "peer-remove": {
      const result = await localDaemonProvider(parsed, config).removeTrustedPeer({
        endpoint: requiredOption(parsed, "endpoint"),
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`peer: ${result.removed ? "removed" : "missing"} (${result.endpoint})`);
      return;
    }
    case "peer-sync": {
      const result = await localDaemonProvider(parsed, config).syncTrustedPeers({
        projectId: await projectIdOption(parsed),
        taskId: requiredOption(parsed, "task-id"),
        laneId: stringOption(parsed, "lane-id") ?? "main",
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else printPeerSyncResult(result);
      return;
    }
    case "lane-inventory": {
      const provider = localDaemonProvider(parsed, config);
      const projectId = await projectIdOption(parsed);
      const taskId = stringOption(parsed, "task-id");
      const laneId = stringOption(parsed, "lane-id");
      if (taskId && laneId) {
        const inventory = await provider.laneInventory({ projectId, taskId, laneId });
        if (parsed.options.json) console.log(JSON.stringify(inventory, null, 2));
        else printLaneInventory(inventory);
        return;
      }
      const inventory = await provider.projectInventory({ projectId, taskId, laneId });
      if (parsed.options.json) console.log(JSON.stringify(inventory, null, 2));
      else printProjectInventory(inventory);
      return;
    }
    case "lane-snapshot": {
      const provider = localDaemonProvider(parsed, config);
      const ref = {
        projectId: await projectIdOption(parsed),
        taskId: requiredOption(parsed, "task-id"),
        laneId: stringOption(parsed, "lane-id") ?? "main",
      };
      const signer = await signerFromOptions(parsed, config, "snapshot-cli");
      const status = await provider.status({ ...ref, actor: signer.signer, now: stringOption(parsed, "now") });
      if (!status.lane.tip) throw new Error(`cannot snapshot empty lane ${ref.projectId}/${ref.taskId}/${ref.laneId}`);
      if (status.action === "pause") throw new Error(status.reason ?? "lane is owned by another actor");
      const blocks = await provider.blocks(ref);
      if (blocks.length === 0) throw new Error(`cannot snapshot lane ${ref.projectId}/${ref.taskId}/${ref.laneId}: no active blocks`);
      const payload: LaneSnapshotPayload = {
        summary: stringOption(parsed, "summary") ?? `Snapshot ${ref.projectId}/${ref.taskId}/${ref.laneId}`,
        baseBlockIds: blocks.map((block) => block.blockId),
        compactedBlockCount: blocks.length,
        canonMarkdown: status.lane.canonMarkdown,
        inventoryMarkdown: status.lane.inventoryMarkdown,
        checkpoint: status.lane.checkpoint as LaneSnapshotPayload["checkpoint"],
        owner: status.lane.owner,
      };
      const result = await provider.snapshot({
        ...ref,
        signer: signer.signer,
        expectedTip: status.lane.tip,
        createdAt: stringOption(parsed, "now"),
        payload,
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`snapshot: ${result.accepted ? "accepted" : "rejected"}`);
        console.log(`project: ${ref.projectId}`);
        console.log(`task: ${ref.taskId}`);
        console.log(`lane: ${ref.laneId}`);
        console.log(`baseBlocks: ${payload.baseBlockIds.length}`);
        console.log(`block: ${result.block?.blockId ?? "<none>"}`);
        console.log(`tip: ${result.lane.tip ?? "<empty>"}`);
        if (result.rejection) console.log(`rejection: ${result.rejection.code}: ${result.rejection.message}`);
      }
      return;
    }
    case "lane-retain": {
      const result = await localDaemonProvider(parsed, config).applyRetention({
        projectId: await projectIdOption(parsed),
        taskId: requiredOption(parsed, "task-id"),
        laneId: stringOption(parsed, "lane-id") ?? "main",
        keepRecent: numberOption(parsed, "keep-recent") ?? 20,
        requireSnapshot: true,
        allowWithoutSnapshot: parsed.options["allow-without-snapshot"] === true,
        reason: stringOption(parsed, "reason") ?? "retention policy",
        now: stringOption(parsed, "now"),
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`project: ${result.projectId}`);
        console.log(`task: ${result.taskId}`);
        console.log(`lane: ${result.laneId}`);
        console.log(`archivedBlocks: ${result.archivedBlocks}`);
        console.log(`activeBlocks: ${result.activeBlocks}`);
        console.log(`latestSnapshot: ${result.latestSnapshot ?? "<none>"}`);
        if (result.archivedAt) console.log(`archivedAt: ${result.archivedAt}`);
      }
      return;
    }
    case "blob-get": {
      const result = await localDaemonProvider(parsed, config).blob(requiredOption(parsed, "digest"));
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else if (parsed.options["base64"] === true) console.log(result.contentBase64);
      else process.stdout.write(Buffer.from(result.contentBase64, "base64").toString("utf8"));
      return;
    }
    case "peer-invite-create": {
      const signer = await signerFromOptions(parsed, config, "peer-invite-cli");
      const invite = await createPeerInvite(
        {
          endpoint: requiredOption(parsed, "endpoint"),
          provider: stringOption(parsed, "provider"),
          name: stringOption(parsed, "name") ?? defaultPresenceName(),
          projects: projectListOption(parsed),
          expiresAt: stringOption(parsed, "expires-at"),
          createdAt: stringOption(parsed, "now"),
        },
        signer.signer,
      );
      const url = encodePeerInvite(invite);
      if (parsed.options.json) console.log(JSON.stringify({ invite, url, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else console.log(url);
      return;
    }
    case "peer-invite-accept": {
      const invite = decodePeerInvite(requiredOption(parsed, "invite"));
      const trusted = await localDaemonProvider(parsed, config).trustPeer(peerTrustInputFromInvite(invite));
      if (parsed.options.json) console.log(JSON.stringify({ invite, trusted }, null, 2));
      else {
        console.log(`peer: ${trusted.endpoint}`);
        console.log(`nodeId: ${trusted.nodeId ?? invite.nodeId}`);
        if (trusted.name) console.log(`name: ${trusted.name}`);
        console.log(`provider: ${trusted.provider ?? invite.provider ?? "invite"}`);
      }
      return;
    }
    case "presence-publish": {
      const signer = await signerFromOptions(parsed, config, "presence-cli");
      const presence = await createPeerPresence(
        {
          endpoints: publishEndpointListOption(parsed).map((endpoint) => ({ endpoint, provider: stringOption(parsed, "provider") })),
          name: stringOption(parsed, "name") ?? defaultPresenceName(),
          projects: projectListOption(parsed),
          expiresAt: stringOption(parsed, "expires-at"),
          updatedAt: stringOption(parsed, "now"),
        },
        signer.signer,
      );
      const file = await publishRendezvousPresence({ rendezvous: requiredOption(parsed, "rendezvous"), presence });
      if (parsed.options.json) console.log(JSON.stringify({ file, presence, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`presence: ${file}`);
        console.log(`nodeId: ${presence.nodeId}`);
        for (const endpoint of presence.endpoints) console.log(`endpoint: ${endpoint.endpoint}${endpoint.provider ? ` (${endpoint.provider})` : ""}`);
      }
      return;
    }
    case "presence-discover": {
      const filter = discoveryFilterOption(parsed);
      if (parsed.options.add === true) requireTrustedFilterForAdd(filter);
      const result = await discoverRendezvousPeers({
        rendezvous: requiredOption(parsed, "rendezvous"),
        filter,
      });
      const trusted = parsed.options.add === true ? await trustDiscoveredPeers(parsed, config, result.peers) : [];
      if (parsed.options.json) console.log(JSON.stringify({ ...result, trusted }, null, 2));
      else printOnboardingDiscovery("rendezvous", result.peers, result.warnings, trusted.length);
      return;
    }
    case "rendezvous-publish": {
      const signer = await signerFromOptions(parsed, config, "rendezvous-cli");
      const presence = await createPeerPresence(
        {
          endpoints: publishEndpointListOption(parsed).map((endpoint) => ({ endpoint, provider: stringOption(parsed, "provider") })),
          name: stringOption(parsed, "name") ?? defaultPresenceName(),
          projects: projectListOption(parsed),
          expiresAt: stringOption(parsed, "expires-at"),
          updatedAt: stringOption(parsed, "now"),
        },
        signer.signer,
      );
      const result = await publishRendezvousPresenceToTarget({
        target: rendezvousTargetOption(parsed, config),
        presence,
      });
      if (parsed.options.json) console.log(JSON.stringify({ ...result, presence, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
      else {
        console.log(`rendezvous: ${result.backend}`);
        if (result.file) console.log(`file: ${result.file}`);
        if (result.url) console.log(`url: ${result.url}`);
        if (result.worktree) console.log(`worktree: ${result.worktree}`);
        if (result.branch) console.log(`branch: ${result.branch}`);
        if (result.message) console.log(`message: ${result.message}`);
        for (const endpoint of presence.endpoints) console.log(`endpoint: ${endpoint.endpoint}${endpoint.provider ? ` (${endpoint.provider})` : ""}`);
      }
      return;
    }
    case "rendezvous-discover": {
      const filter = discoveryFilterOption(parsed);
      if (parsed.options.add === true) requireTrustedFilterForAdd(filter);
      const result = await discoverRendezvousPeersFromTarget({
        target: rendezvousTargetOption(parsed, config),
        filter,
      });
      const trusted = parsed.options.add === true ? await trustDiscoveredPeers(parsed, config, result.peers) : [];
      if (parsed.options.json) console.log(JSON.stringify({ ...result, trusted }, null, 2));
      else {
        printOnboardingDiscovery(`rendezvous:${result.backend}`, result.peers, result.warnings, trusted.length);
        if (result.worktree) console.log(`worktree: ${result.worktree}`);
      }
      return;
    }
    case "node-init": {
      const launchd = parsed.options.launchd === true;
      if (launchd && process.platform !== "darwin") throw new Error("--launchd is only supported on macOS");

      const peerListen = nodeInitPeerListenOption(parsed);
      const installResult = parsed.options["no-daemon-install"] === true
        ? undefined
        : await installDaemonRuntime({
            home: stringOption(parsed, "home"),
            packageRoot: stringOption(parsed, "package-root"),
            binaryPath: stringOption(parsed, "binary") ?? stringOption(parsed, "output"),
            stateDir: stringOption(parsed, "state-dir"),
            socketPath: stringOption(parsed, "socket"),
            dbPath: stringOption(parsed, "db"),
            launchd,
            launchdLabel: stringOption(parsed, "launchd-label"),
            launchdPlistPath: stringOption(parsed, "launchd-plist"),
            peerListen,
          });
      const daemon = installResult ? daemonConfigFromInstallResult(installResult, stringOption(parsed, "launchd-label")) : daemonRuntimeFromOptions(parsed, config);
      const startActions = parsed.options["no-start"] === true
        ? []
        : await startDaemon({
            daemon,
            launchd,
            peerListen,
            timeoutMs: numberOption(parsed, "timeout-ms"),
          });
      const signer = await signerFromOptions(parsed, config, "node-init-cli");
      const name = stringOption(parsed, "name") ?? defaultPresenceName();
      const endpoint = nodeInitEndpointOption(parsed, peerListen, name);
      const shouldAdvertise = parsed.options["no-advertise"] !== true;
      const filter = discoveryFilterOption(parsed);
      const shouldDiscover = parsed.options.discover === true || discoveryFilterHasTrust(filter);

      const presence = shouldAdvertise
        ? await createPeerPresence(
            {
              endpoints: [{ endpoint, provider: stringOption(parsed, "provider") ?? "rendezvous" }],
              name,
              projects: projectListOption(parsed),
              expiresAt: stringOption(parsed, "expires-at"),
              updatedAt: stringOption(parsed, "now"),
            },
            signer.signer,
          )
        : undefined;
      const publish = presence
        ? await publishRendezvousPresenceToTarget({
            target: rendezvousTargetOption(parsed, config),
            presence,
          })
        : undefined;

      let discovery: Awaited<ReturnType<typeof discoverRendezvousPeersFromTarget>> | undefined;
      let trusted: Awaited<ReturnType<LocalDaemonProvider["trustPeer"]>>[] = [];
      if (shouldDiscover) {
        if (!discoveryFilterHasTrust(filter)) throw new Error("node-init --discover requires --trusted-names, --trust-names, or --trusted-node-ids");
        const rawDiscovery = await discoverRendezvousPeersFromTarget({
          target: rendezvousTargetOption(parsed, config),
          filter,
        });
        discovery = {
          ...rawDiscovery,
          peers: rawDiscovery.peers.filter((peer) => peer.nodeId !== signer.signer.nodeId),
        };
        const provider = new LocalDaemonProvider({ socketPath: daemon.socketPath, timeoutMs: numberOption(parsed, "timeout-ms") });
        trusted = await trustDiscoveredPeersWithProvider(provider, discovery.peers);
      }

      const output = {
        daemon,
        actions: [...(installResult?.actions ?? []), ...startActions],
        keyPath: signer.keyPath,
        keyCreated: signer.created,
        presence,
        publish,
        discovery,
        trusted,
      };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`node: ${name}`);
        console.log(`socket: ${daemon.socketPath}`);
        if (peerListen) console.log(`peerListen: ${peerListen}`);
        if (presence) console.log(`endpoint: ${endpoint}`);
        printActions(output.actions);
        if (publish) {
          console.log(`rendezvous: ${publish.backend}`);
          if (publish.file) console.log(`file: ${publish.file}`);
          if (publish.url) console.log(`url: ${publish.url}`);
          if (publish.worktree) console.log(`worktree: ${publish.worktree}`);
          if (publish.branch) console.log(`branch: ${publish.branch}`);
          if (publish.message) console.log(`message: ${publish.message}`);
        }
        if (discovery) {
          printOnboardingDiscovery(`rendezvous:${discovery.backend}`, discovery.peers, discovery.warnings, trusted.length);
          if (discovery.worktree) console.log(`worktree: ${discovery.worktree}`);
        }
      }
      return;
    }
    case "mdns-advertise": {
      const signer = await signerFromOptions(parsed, config, "mdns-cli");
      const presence = await createPeerPresence(
        {
          endpoints: [{ endpoint: mdnsEndpointOption(parsed), provider: stringOption(parsed, "provider") ?? "mdns" }],
          name: stringOption(parsed, "name") ?? defaultPresenceName(),
          projects: projectListOption(parsed),
          expiresAt: stringOption(parsed, "expires-at"),
          updatedAt: stringOption(parsed, "now"),
        },
        signer.signer,
      );
      const durationMs = numberOption(parsed, "duration-ms");
      if (parsed.options.daemon === true) {
        if (durationMs !== undefined) throw new Error("--daemon cannot be combined with --duration-ms; stop it with mdns-advertise-stop --daemon");
        const endpoint = presence.endpoints[0];
        const state = await localDaemonProvider(parsed, config).startMdnsAdvertiser({
          name: presence.name ?? presence.nodeId,
          port: tcpEndpointPort(endpoint.endpoint),
          txt: mdnsTxtForPresence(presence),
          endpoint: endpoint.endpoint,
          nodeId: presence.nodeId,
          provider: endpoint.provider,
          projects: presence.projects,
          now: stringOption(parsed, "now"),
        });
        if (parsed.options.json) console.log(JSON.stringify({ state, presence, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
        else {
          console.log("mDNS advertiser: started");
          console.log("manager: daemon");
          console.log(`name: ${state.name}`);
          console.log(`endpoint: ${state.endpoint}`);
        }
        return;
      }
      if (parsed.options.background === true) {
        if (durationMs !== undefined) throw new Error("--background cannot be combined with --duration-ms; stop it with mdns-advertise-stop");
        const state = await startMdnsAdvertiser({
          presence,
          stateDir: daemonRuntimeFromOptions(parsed, config).stateDir,
          now: stringOption(parsed, "now"),
        });
        if (parsed.options.json) console.log(JSON.stringify({ state, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
        else {
          console.log("mDNS advertiser: started");
          console.log(`pid: ${state.pid}`);
          console.log(`name: ${state.name}`);
          console.log(`endpoint: ${state.endpoint}`);
          console.log(`state: ${state.stateFile}`);
        }
        return;
      }
      if (parsed.options.json) {
        console.log(JSON.stringify({ presence, keyPath: signer.keyPath, keyCreated: signer.created }, null, 2));
        return;
      }
      await advertiseMdnsPresence({ presence, durationMs });
      return;
    }
    case "mdns-advertise-status": {
      if (parsed.options.daemon === true) {
        const status = await localDaemonProvider(parsed, config).mdnsAdvertiserStatus();
        if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
        else printDaemonMdnsAdvertiserStatus(status);
        return;
      }
      const status = await readMdnsAdvertiserStatus({ stateDir: daemonRuntimeFromOptions(parsed, config).stateDir });
      if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
      else printMdnsAdvertiserStatus(status);
      return;
    }
    case "mdns-advertise-stop": {
      if (parsed.options.daemon === true) {
        const result = await localDaemonProvider(parsed, config).stopMdnsAdvertiser();
        if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`mDNS advertiser: ${result.stopped ? "stopped" : "not running"}`);
        return;
      }
      const result = await stopMdnsAdvertiser({ stateDir: daemonRuntimeFromOptions(parsed, config).stateDir });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`mDNS advertiser: ${result.stopped ? "stopped" : "not running"}`);
        if (result.pid) console.log(`pid: ${result.pid}`);
        if (result.reason) console.log(`reason: ${result.reason}`);
      }
      return;
    }
    case "mdns-discover": {
      const filter = discoveryFilterOption(parsed);
      if (parsed.options.add === true) requireTrustedFilterForAdd(filter);
      const result = await discoverMdnsPeers({
        timeoutMs: numberOption(parsed, "timeout-ms"),
        filter,
      });
      const trusted = parsed.options.add === true ? await trustDiscoveredPeers(parsed, config, result.peers) : [];
      if (parsed.options.json) console.log(JSON.stringify({ ...result, trusted }, null, 2));
      else printOnboardingDiscovery("mDNS", result.peers, result.warnings, trusted.length);
      return;
    }
    case "peer-discover": {
      const peerPort = numberOption(parsed, "peer-port");
      if (peerPort === undefined) throw new Error("--peer-port is required");
      const trustedNames = listOption(parsed, "trusted-names");
      const trustedNodeIds = listOption(parsed, "trusted-node-ids");
      if (trustedNames.length === 0 && trustedNodeIds.length === 0) {
        throw new Error("--peer-port requires --trusted-names or --trusted-node-ids");
      }
      const providers = discoveryProviders(parsed);
      const provider = localDaemonProvider(parsed, config);
      const discovery = await provider.discoverPeers({
        port: peerPort,
        providers: providers.length > 0 ? providers : undefined,
        trustedNames: trustedNames.length > 0 ? trustedNames : undefined,
        trustedNodeIds: trustedNodeIds.length > 0 ? trustedNodeIds : undefined,
      });
      const trusted = parsed.options.add === true
        ? await Promise.all(discovery.peers.map((peer) => provider.trustPeer({
            endpoint: peer.endpoint,
            nodeId: peer.nodeId,
            name: peer.name,
            provider: peer.provider,
          })))
        : [];
      if (parsed.options.json) console.log(JSON.stringify({ ...discovery, trusted }, null, 2));
      else {
        if (discovery.peers.length === 0) console.log("discovered peers: none");
        for (const peer of discovery.peers) {
          const labels = [peer.provider, peer.name, peer.nodeId, peer.online ? "online" : "offline"].filter(Boolean).join(", ");
          console.log(`${peer.endpoint}${labels ? ` (${labels})` : ""}`);
        }
        for (const warning of discovery.warnings ?? []) console.log(`warning: ${warning}`);
        if (trusted.length > 0) console.log(`trusted: ${trusted.length}`);
      }
      return;
    }
    case "daemon-install": {
      const launchd = parsed.options.launchd === true;
      const peerListen = stringOption(parsed, "peer-listen");
      if (launchd && process.platform !== "darwin") throw new Error("--launchd is only supported on macOS");
      if (peerListen && !launchd) throw new Error("--peer-listen requires --launchd");

      const result = await installDaemonRuntime({
        home: stringOption(parsed, "home"),
        packageRoot: stringOption(parsed, "package-root"),
        binaryPath: stringOption(parsed, "output"),
        stateDir: stringOption(parsed, "state-dir"),
        socketPath: stringOption(parsed, "socket"),
        dbPath: stringOption(parsed, "db"),
        launchd,
        launchdLabel: stringOption(parsed, "launchd-label"),
        launchdPlistPath: stringOption(parsed, "launchd-plist"),
        peerListen,
        dryRun: parsed.options["dry-run"] === true,
      });

      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`binary: ${result.binaryPath}`);
        console.log(`stateDir: ${result.stateDir}`);
        console.log(`socket: ${result.socketPath}`);
        console.log(`database: ${result.dbPath}`);
        if (result.launchdPlistPath) console.log(`launchd: ${result.launchdPlistPath}`);
        printActions(result.actions);
      }
      return;
    }
    case "daemon-status": {
      const actions = await daemonStatus({
        daemon: daemonRuntimeFromOptions(parsed, config),
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "daemon-start": {
      const actions = await startDaemon({
        daemon: daemonRuntimeFromOptions(parsed, config),
        launchd: parsed.options.launchd === true,
        peerListen: stringOption(parsed, "peer-listen"),
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "daemon-stop": {
      const actions = await stopDaemon({
        daemon: daemonRuntimeFromOptions(parsed, config),
        launchd: parsed.options.launchd === true,
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "daemon-migrate": {
      requireDatabaseConfig(config);
      const projectId = requiredOption(parsed, "project-id");
      const taskId = requiredOption(parsed, "task-id");
      const laneId = stringOption(parsed, "lane-id") ?? "main";
      const daemon = daemonRuntimeFromOptions(parsed, config);
      const signerState = await loadOrCreateNodeSigner({
        keyPath: stringOption(parsed, "key-file"),
        stateDir: daemon.stateDir,
        nodeId: stringOption(parsed, "node-id"),
        actorId: stringOption(parsed, "actor-id") ?? "migration-cli",
      });
      const provider = new LocalDaemonProvider({
        socketPath: daemon.socketPath,
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      const result = await migratePostgresTaskToProvider({
        projectId,
        taskId,
        laneId,
        provider,
        signer: signerState.signer,
        config,
      });
      const output = { ...result, keyPath: signerState.keyPath, keyCreated: signerState.created };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`task: ${result.taskId}`);
        console.log(`lane: ${result.laneId}`);
        console.log(`migrated: ${result.migrated}`);
        if (result.reason) console.log(`reason: ${result.reason}`);
        console.log(`journalEntries: ${result.journalEntries}`);
        console.log(`acceptedBlocks: ${result.acceptedBlocks}`);
        console.log(`finalTip: ${result.finalTip ?? "<empty>"}`);
        console.log(`nodeKey: ${signerState.keyPath}${signerState.created ? " (created)" : ""}`);
      }
      return;
    }
    case "doctor": {
      const result = await doctor(config);
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        printActions(result.checks);
        console.log(result.ok ? "doctor: ok" : "doctor: failed");
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "start": {
      requireDatabaseConfig(config);
      const actions = await startRuntime(config);
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "stop": {
      requireDatabaseConfig(config);
      const actions = await stopRuntime(config);
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "backup": {
      requireDatabaseConfig(config);
      const actions = await backupRuntime(config, stringOption(parsed, "output"));
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else printActions(actions);
      return;
    }
    case "uninstall": {
      const actions = await uninstallProduct(config, {
        deleteData: Boolean(parsed.options["delete-data"]),
        keepIntegrations: Boolean(parsed.options["keep-integrations"]),
        keepDaemonBinary: Boolean(parsed.options["keep-daemon-binary"]),
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else {
        printActions(actions);
        if (!parsed.options["delete-data"]) console.log("Data was kept. Re-run with --delete-data to remove Docker volume and daemon state.");
      }
      return;
    }
    case "install": {
      const target = installTargetOption(parsed);
      if (target) {
        const result = await installAgentContinuity({
          target,
          home: stringOption(parsed, "home"),
          dryRun: Boolean(parsed.options["dry-run"]),
        });
        if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`target: ${result.target}`);
          for (const path of result.wrote) console.log(`wrote: ${path}`);
          for (const path of result.removed) console.log(`removed: ${path}`);
          for (const path of result.skipped) console.log(`skipped: ${path}`);
          for (const message of result.messages) console.log(message);
          console.log("Restart OpenCode/Claude for integration changes to load.");
        }
        return;
      }
      if (parsed.options["dry-run"] === true) {
        throw new Error("--dry-run is only supported with install --target all|opencode|claude");
      }

      const result = await installProduct({
        home: stringOption(parsed, "home"),
        runtime: stringOption(parsed, "runtime") as "docker" | undefined,
        install: parsed.options["no-integrations"] !== true,
        image: stringOption(parsed, "image"),
        containerName: stringOption(parsed, "container-name"),
        volumeName: stringOption(parsed, "volume-name"),
        host: stringOption(parsed, "host"),
        port: numberOption(parsed, "port"),
        database: stringOption(parsed, "database"),
        user: stringOption(parsed, "user"),
        password: stringOption(parsed, "password"),
        queueName: stringOption(parsed, "queue"),
        checkpointDir: stringOption(parsed, "checkpoint-dir"),
        daemon: parsed.options["no-daemon"] !== true,
        daemonLaunchd: parsed.options.launchd === true,
        daemonPeerListen: stringOption(parsed, "peer-listen"),
        startDaemon: parsed.options["no-start"] !== true,
        projectId: stringOption(parsed, "project-id"),
        taskId: stringOption(parsed, "task-id"),
        laneId: stringOption(parsed, "lane-id"),
        actorId: stringOption(parsed, "actor-id"),
        nodeId: stringOption(parsed, "node-id"),
        keyFile: stringOption(parsed, "key-file"),
        timeoutMs: numberOption(parsed, "timeout-ms"),
      });
      const workerStart = parsed.options["start-worker"] === true
        ? await startSchedulerWorkerFromParsed(installWorkerParsed(parsed), commandConfig(parsed))
        : undefined;
      const output = { ...result, databaseUrl: maskDatabaseUrl(result.databaseUrl), workerStart };
      if (parsed.options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log("install: complete");
        console.log(`config: ${result.configPath}`);
        console.log(`database: ${maskDatabaseUrl(result.databaseUrl)}`);
        printActions(result.actions);
        console.log("doctor:");
        printActions(result.doctor.checks);
        if (result.migration) {
          console.log(`migration: ${result.migration.migrated ? "migrated" : "skipped"}`);
          if (result.migration.reason) console.log(`migrationReason: ${result.migration.reason}`);
          console.log(`migrationBlocks: ${result.migration.acceptedBlocks}`);
          console.log(`nodeKey: ${result.migration.keyPath}${result.migration.keyCreated ? " (created)" : ""}`);
        }
        if (workerStart) {
          console.log("worker:");
          console.log(`session: ${workerStart.status.session}`);
          console.log(`running: ${workerStart.status.running ? "yes" : "no"}`);
          console.log(`attach: continuity scheduler-worker-attach --manager-tmux-session ${workerStart.status.session}`);
        }
        if (!result.doctor.ok) process.exitCode = 1;
      }
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      return;
    default:
      throw new Error(`unknown command: ${parsed.command}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { command, options };
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (typeof value === "boolean") return undefined;
  return value;
}

function numberOption(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return undefined;
  const parsedNumber = Number(value);
  if (!Number.isInteger(parsedNumber)) throw new Error(`--${name} must be an integer`);
  return parsedNumber;
}

function listOption(parsed: ParsedArgs, name: string): string[] {
  const value = stringOption(parsed, name);
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function listOptions(parsed: ParsedArgs, ...names: string[]): string[] {
  return [...new Set(names.flatMap((name) => listOption(parsed, name)))];
}

function jsonOption<T>(parsed: ParsedArgs, name: string): T | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoveryProviders(parsed: ParsedArgs): OverlayDiscoveryProvider[] {
  const providers = listOption(parsed, "providers");
  for (const provider of providers) {
    if (provider !== "tailscale" && provider !== "zerotier") {
      throw new Error(`unsupported --providers entry ${provider}; expected tailscale or zerotier`);
    }
  }
  return providers as OverlayDiscoveryProvider[];
}

function installTargetOption(parsed: ParsedArgs): InstallTarget | undefined {
  const target = stringOption(parsed, "target");
  if (target === undefined) return undefined;
  if (target === "all" || target === "opencode" || target === "claude") return target;
  throw new Error(`unsupported --target ${target}; expected all, opencode, or claude`);
}

async function projectIdOption(parsed: ParsedArgs): Promise<string> {
  return stringOption(parsed, "project-id") ?? inferProjectId();
}

function daemonRuntimeFromOptions(parsed: ParsedArgs, config: ContinuityConfig): DaemonRuntimeConfig {
  const base = config.daemon ?? defaultDaemonRuntimeConfig(config.home);
  return {
    ...base,
    binaryPath: stringOption(parsed, "binary") ?? base.binaryPath,
    stateDir: stringOption(parsed, "state-dir") ?? base.stateDir,
    socketPath: stringOption(parsed, "socket") ?? base.socketPath,
    dbPath: stringOption(parsed, "db") ?? base.dbPath,
    launchdPlistPath: stringOption(parsed, "launchd-plist") ?? base.launchdPlistPath,
  };
}

function localDaemonProvider(parsed: ParsedArgs, config: ContinuityConfig): LocalDaemonProvider {
  const daemon = daemonRuntimeFromOptions(parsed, config);
  return new LocalDaemonProvider({ socketPath: daemon.socketPath, timeoutMs: numberOption(parsed, "timeout-ms") });
}

async function schedulerLaneRef(parsed: ParsedArgs): Promise<{ projectId: string; taskId: string; laneId: string }> {
  return {
    projectId: await projectIdOption(parsed),
    taskId: requiredOption(parsed, "task-id"),
    laneId: stringOption(parsed, "lane-id") ?? "scheduler",
  };
}

async function agentLaneRef(parsed: ParsedArgs): Promise<{ projectId: string; taskId: string; laneId: string }> {
  return {
    projectId: await projectIdOption(parsed),
    taskId: requiredOption(parsed, "task-id"),
    laneId: stringOption(parsed, "lane-id") ?? "main",
  };
}

async function signerFromOptions(parsed: ParsedArgs, config: ContinuityConfig, actorId: string): Promise<Awaited<ReturnType<typeof loadOrCreateNodeSigner>>> {
  const daemon = daemonRuntimeFromOptions(parsed, config);
  return loadOrCreateNodeSigner({
    keyPath: stringOption(parsed, "key-file"),
    stateDir: daemon.stateDir,
    nodeId: stringOption(parsed, "node-id"),
    actorId: stringOption(parsed, "actor-id") ?? actorId,
  });
}

function workerProfilePayload(parsed: ParsedArgs, nodeId?: string): WorkerProfilePayload {
  return resolveSchedulerWorkerProfile({
    preset: schedulerWorkerPresetNameOption(parsed),
    nodeId,
    workerId: stringOption(parsed, "worker-id"),
    agent: stringOption(parsed, "agent"),
    modelFamilies: listOrUndefined(parsed, "model-families"),
    models: listOrUndefined(parsed, "models"),
    tools: listOrUndefined(parsed, "tools"),
    maxConcurrent: numberOption(parsed, "max-concurrent"),
    tmuxSession: stringOption(parsed, "tmux-session"),
    endpoint: stringOption(parsed, "endpoint"),
    enabled: parsed.options.disabled === true ? false : true,
  });
}

function schedulerWorkerPresetNameOption(parsed: ParsedArgs): SchedulerWorkerPresetName | undefined {
  return parseSchedulerWorkerPreset(stringOption(parsed, "preset"));
}

function schedulerWorkerPresetOption(parsed: ParsedArgs): ReturnType<typeof schedulerWorkerPreset> | undefined {
  const preset = schedulerWorkerPresetNameOption(parsed);
  return preset ? schedulerWorkerPreset(preset) : undefined;
}

function schedulerWorkerCommandOption(parsed: ParsedArgs): string | undefined {
  return stringOption(parsed, "command") ?? schedulerWorkerPresetOption(parsed)?.command;
}

async function startSchedulerWorkerFromParsed(parsed: ParsedArgs, config: ContinuityConfig): Promise<{ status: Awaited<ReturnType<typeof startTmuxSession>>; command: string }> {
  const signer = await signerFromOptions(parsed, config, "scheduler-worker-cli");
  const worker = workerProfilePayload(parsed, signer.signer.nodeId);
  const session = schedulerManagerTmuxSession(parsed, worker.workerId);
  const command = schedulerWorkerLoopCommand(parsed, { "worker-id": worker.workerId });
  const status = await startTmuxSession({ session, command, cwd: process.cwd() });
  return { status, command };
}

function installWorkerParsed(parsed: ParsedArgs): ParsedArgs {
  const projectId = stringOption(parsed, "worker-project-id") ?? stringOption(parsed, "project-id");
  const taskId = stringOption(parsed, "worker-task-id") ?? stringOption(parsed, "task-id");
  if (!projectId || !taskId) throw new Error("--start-worker requires --worker-project-id and --worker-task-id, or install --project-id and --task-id");

  const options: ParsedArgs["options"] = {
    "project-id": projectId,
    "task-id": taskId,
    "lane-id": stringOption(parsed, "worker-lane-id") ?? "scheduler",
    preset: stringOption(parsed, "worker-preset") ?? stringOption(parsed, "preset") ?? "codex",
    sync: parsed.options["no-worker-sync"] === true ? false : true,
  };
  copyOption(parsed, options, "home");
  copyOption(parsed, options, "socket");
  copyOption(parsed, options, "state-dir");
  copyOption(parsed, options, "db");
  copyOption(parsed, options, "timeout-ms");
  copyOption(parsed, options, "node-id", "worker-node-id");
  copyOption(parsed, options, "actor-id", "worker-actor-id");
  copyOption(parsed, options, "key-file", "worker-key-file");
  copyOption(parsed, options, "worker-id");
  copyOption(parsed, options, "agent", "worker-agent");
  copyOption(parsed, options, "model-families", "worker-model-families");
  copyOption(parsed, options, "models", "worker-models");
  copyOption(parsed, options, "tools", "worker-tools");
  copyOption(parsed, options, "runner", "worker-runner");
  copyOption(parsed, options, "command", "worker-command");
  copyOption(parsed, options, "runner-timeout-ms", "worker-runner-timeout-ms");
  copyOption(parsed, options, "max-runner-timeout-ms", "worker-max-runner-timeout-ms");
  copyOption(parsed, options, "allowed-project-ids", "worker-allowed-project-ids");
  copyOption(parsed, options, "allowed-commands", "worker-allowed-commands");
  copyOption(parsed, options, "worktree-root", "worker-worktree-root");
  copyOption(parsed, options, "interval-ms", "worker-interval-ms");
  copyOption(parsed, options, "max-errors", "worker-max-errors");
  copyOption(parsed, options, "manager-tmux-session", "worker-manager-tmux-session");
  return { command: "scheduler-worker-start", options };
}

function copyOption(source: ParsedArgs, target: ParsedArgs["options"], targetName: string, sourceName = targetName): void {
  const value = source.options[sourceName];
  if (value !== undefined) target[targetName] = value;
}

function schedulerManagerTmuxSession(parsed: ParsedArgs, workerId: string | undefined): string {
  const session = stringOption(parsed, "manager-tmux-session");
  if (session) return session;
  if (!workerId) throw new Error("missing required option --worker-id or --manager-tmux-session");
  return defaultSchedulerWorkerTmuxSession(workerId);
}

function schedulerWorkerLoopCommand(parsed: ParsedArgs, overrides: Record<string, string | boolean | undefined> = {}): string {
  const cli = process.argv[1];
  if (!cli) throw new Error("cannot locate current continuity CLI entrypoint");
  const args = ["scheduler-worker-loop"];
  for (const name of schedulerWorkerLoopOptionNames()) {
    const value = overrides[name] ?? parsed.options[name];
    if (value === undefined) continue;
    if (value === true) args.push(`--${name}`);
    else if (value !== false) args.push(`--${name}`, value);
  }
  return shellJoin([process.execPath, cli, ...args]);
}

function schedulerWorkerLoopOptionNames(): string[] {
  return [
    "home",
    "socket",
    "state-dir",
    "db",
    "timeout-ms",
    "project-id",
    "task-id",
    "lane-id",
    "key-file",
    "node-id",
    "actor-id",
    "preset",
    "worker-id",
    "agent",
    "model-families",
    "models",
    "tools",
    "max-concurrent",
    "endpoint",
    "disabled",
    "runner",
    "command",
    "tmux-session",
    "kill-tmux-session",
    "runner-timeout-ms",
    "max-runner-timeout-ms",
    "allowed-project-ids",
    "allow-project-ids",
    "allowed-commands",
    "worktree-root",
    "lease-ms",
    "interval-ms",
    "max-runs",
    "idle-limit",
    "duration-ms",
    "max-errors",
    "sync",
  ];
}

function printSchedulerWorkerLoopEvent(event: SchedulerWorkerLoopEvent): void {
  if (event.type === "sync" && event.sync) {
    console.log(`[${event.at}] sync inserted=${event.sync.insertedBlocks} rejected=${event.sync.rejectedBlocks}`);
  } else if (event.type === "result" && event.result) {
    const intent = event.result.intent ? ` intent=${event.result.intent.blockId}` : "";
    const result = event.result.resultBlock ? ` result=${event.result.resultBlock.blockId}` : "";
    console.log(`[${event.at}] worker=${event.result.workerId} status=${event.result.status}${intent}${result} summary=${event.result.summary}`);
  } else if (event.type === "error") {
    console.log(`[${event.at}] error=${event.error ?? "unknown"}`);
  } else if (event.type === "stop") {
    console.log(`[${event.at}] stop=${event.stopReason ?? "unknown"}`);
  }
}

function printSchedulerWorkerLoopSummary(summary: Awaited<ReturnType<typeof runSchedulerWorkerLoop>>): void {
  console.log(`worker: ${summary.workerId}`);
  console.log(`project: ${summary.projectId}`);
  console.log(`task: ${summary.taskId}`);
  console.log(`lane: ${summary.laneId}`);
  console.log(`stop: ${summary.stopReason}`);
  console.log(`iterations: ${summary.iterations}`);
  console.log(`runs: ${summary.runs}`);
  console.log(`idle: ${summary.idle}`);
  console.log(`completed: ${summary.completed}`);
  console.log(`failed: ${summary.failed}`);
  console.log(`blocked: ${summary.blocked}`);
  console.log(`cancelled: ${summary.cancelled}`);
  console.log(`errors: ${summary.errors}`);
}

async function instructionsOption(parsed: ParsedArgs): Promise<string> {
  const instructions = stringOption(parsed, "instructions");
  const instructionsFile = stringOption(parsed, "instructions-file");
  if (instructions && instructionsFile) throw new Error("--instructions and --instructions-file cannot be combined");
  const value = instructionsFile ? await readFile(instructionsFile, "utf8") : instructions;
  if (!value?.trim()) throw new Error("missing required option --instructions or --instructions-file");
  return value;
}

function schedulerRequirementsOption(parsed: ParsedArgs): TaskIntentPayload["requirements"] | undefined {
  const requirements = {
    agents: listOrUndefined(parsed, "requires-agents"),
    modelFamilies: listOrUndefined(parsed, "requires-model-families"),
    models: listOrUndefined(parsed, "requires-models"),
    tools: listOrUndefined(parsed, "requires-tools"),
  };
  return Object.values(requirements).some(Boolean) ? requirements : undefined;
}

function schedulerEvaluationSpecOption(parsed: ParsedArgs): TaskIntentPayload["evaluation"] | undefined {
  const evaluation = {
    mode: evaluationModeOption(parsed),
    autoAdjudicate: parsed.options["auto-adjudicate"] === true ? true : undefined,
    confidenceThreshold: evaluationConfidenceOption(parsed, "evaluation-confidence-threshold"),
    requiredChecks: listOrUndefined(parsed, "evaluation-required-checks"),
    rubric: jsonOption<NonNullable<TaskIntentPayload["evaluation"]>["rubric"]>(parsed, "evaluation-rubric-json"),
    useCases: jsonOption<NonNullable<TaskIntentPayload["evaluation"]>["useCases"]>(parsed, "evaluation-use-cases-json"),
  };
  return Object.values(evaluation).some((value) => value !== undefined) ? evaluation : undefined;
}

function evaluationModeOption(parsed: ParsedArgs): NonNullable<TaskIntentPayload["evaluation"]>["mode"] | undefined {
  const mode = stringOption(parsed, "evaluation-mode");
  if (mode === undefined) return undefined;
  if (mode === "manual" || mode === "agent" || mode === "deterministic") return mode;
  throw new Error(`unsupported --evaluation-mode ${mode}; expected manual, agent, or deterministic`);
}

function evaluationConfidenceOption(parsed: ParsedArgs, name: string): "low" | "medium" | "high" | undefined {
  const confidence = stringOption(parsed, name);
  if (confidence === undefined) return undefined;
  if (confidence === "low" || confidence === "medium" || confidence === "high") return confidence;
  throw new Error(`unsupported --${name} ${confidence}; expected low, medium, or high`);
}

function schedulerPolicyOption(parsed: ParsedArgs): TaskIntentPayload["policy"] | undefined {
  const policy = stringOption(parsed, "policy");
  if (policy === undefined) return undefined;
  if (policy === "exclusive" || policy === "speculative") return policy;
  throw new Error(`unsupported --policy ${policy}; expected exclusive or speculative`);
}

function schedulerRunnerOption(parsed: ParsedArgs, fallback?: SchedulerRunner): SchedulerRunner {
  const runner = stringOption(parsed, "runner") ?? fallback ?? "fake";
  if (runner === "fake" || runner === "command" || runner === "tmux") return runner;
  throw new Error(`unsupported --runner ${runner}; expected fake, command, or tmux`);
}

function schedulerResultStatusOption(parsed: ParsedArgs): TaskResultPayload["status"] {
  const status = stringOption(parsed, "status") ?? "completed";
  if (status === "completed" || status === "failed" || status === "blocked" || status === "cancelled") return status;
  throw new Error(`unsupported --status ${status}; expected completed, failed, blocked, or cancelled`);
}

function listOrUndefined(parsed: ParsedArgs, name: string): string[] | undefined {
  const values = listOption(parsed, name);
  return values.length > 0 ? values : undefined;
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = stringOption(parsed, name);
  if (!value) throw new Error(`missing required option --${name}`);
  return value;
}

function publishEndpointListOption(parsed: ParsedArgs): string[] {
  const endpoints = listOption(parsed, "endpoints");
  const endpoint = stringOption(parsed, "endpoint");
  if (endpoint) endpoints.unshift(endpoint);
  if (endpoints.length > 0) return endpoints;
  const port = numberOption(parsed, "port");
  if (port !== undefined) return [defaultMdnsEndpoint(port, stringOption(parsed, "host"))];
  throw new Error("missing required option --endpoint or --port");
}

function mdnsEndpointOption(parsed: ParsedArgs): string {
  const endpoint = stringOption(parsed, "endpoint");
  if (endpoint) return endpoint;
  const port = numberOption(parsed, "port");
  if (port === undefined) throw new Error("missing required option --endpoint or --port");
  return defaultMdnsEndpoint(port, stringOption(parsed, "host"));
}

function nodeInitPeerListenOption(parsed: ParsedArgs): string | undefined {
  const peerListen = stringOption(parsed, "peer-listen");
  if (peerListen) return peerListen;
  const port = numberOption(parsed, "port");
  return port === undefined ? undefined : `:${port}`;
}

function nodeInitEndpointOption(parsed: ParsedArgs, peerListen: string | undefined, defaultHost: string): string {
  const endpoint = stringOption(parsed, "endpoint");
  if (endpoint) return endpoint;
  const port = numberOption(parsed, "port") ?? portFromPeerListen(peerListen);
  if (port === undefined) throw new Error("missing required option --endpoint, --port, or --peer-listen");
  const host = stringOption(parsed, "host") ?? defaultHost;
  return `tcp://${host}:${port}`;
}

function portFromPeerListen(peerListen: string | undefined): number | undefined {
  if (!peerListen) return undefined;
  const match = peerListen.match(/(?::|^)(\d+)$/);
  if (!match) throw new Error(`cannot infer endpoint port from --peer-listen ${peerListen}`);
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid --peer-listen port in ${peerListen}`);
  return port;
}

function tcpEndpointPort(endpoint: string): number {
  const url = new URL(endpoint);
  if (url.protocol !== "tcp:" || !url.port) throw new Error(`expected tcp:// endpoint, got ${endpoint}`);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid endpoint port in ${endpoint}`);
  return port;
}

function projectListOption(parsed: ParsedArgs): string[] | undefined {
  const projects = listOption(parsed, "project-ids");
  const project = stringOption(parsed, "project-id");
  if (project) projects.unshift(project);
  return projects.length > 0 ? projects : undefined;
}

function discoveryFilterOption(parsed: ParsedArgs): DiscoveryFilter {
  return {
    projectId: stringOption(parsed, "project-id"),
    trustedNames: listOptions(parsed, "trusted-names", "trust-names"),
    trustedNodeIds: listOptions(parsed, "trusted-node-ids", "trust-node-ids"),
  };
}

function discoveryFilterHasTrust(filter: DiscoveryFilter): boolean {
  return Boolean(filter.trustedNames?.length || filter.trustedNodeIds?.length);
}

function rendezvousTargetOption(parsed: ParsedArgs, config: ContinuityConfig): RendezvousTarget {
  const backend = (stringOption(parsed, "backend") ?? "file") as RendezvousTarget["backend"];
  if (backend !== "file" && backend !== "git" && backend !== "s3" && backend !== "https") {
    throw new Error(`unsupported --backend ${backend}; expected file, git, s3, or https`);
  }
  return {
    backend,
    dir: stringOption(parsed, "dir") ?? stringOption(parsed, "rendezvous"),
    repo: stringOption(parsed, "repo"),
    branch: stringOption(parsed, "branch"),
    worktree: stringOption(parsed, "worktree"),
    url: stringOption(parsed, "url"),
    stateDir: daemonRuntimeFromOptions(parsed, config).stateDir,
    awsBin: stringOption(parsed, "aws-bin"),
    s3EndpointUrl: stringOption(parsed, "s3-endpoint-url"),
    s3Profile: stringOption(parsed, "s3-profile"),
    httpToken: stringOption(parsed, "http-token"),
  };
}

async function trustDiscoveredPeers(parsed: ParsedArgs, config: ContinuityConfig, peers: DiscoveredOnboardingPeer[]): Promise<Awaited<ReturnType<LocalDaemonProvider["trustPeer"]>>[]> {
  const provider = localDaemonProvider(parsed, config);
  return trustDiscoveredPeersWithProvider(provider, peers);
}

async function trustDiscoveredPeersWithProvider(provider: LocalDaemonProvider, peers: DiscoveredOnboardingPeer[]): Promise<Awaited<ReturnType<LocalDaemonProvider["trustPeer"]>>[]> {
  const trusted: Awaited<ReturnType<LocalDaemonProvider["trustPeer"]>>[] = [];
  for (const peer of peers) {
    trusted.push(await provider.trustPeer(peerTrustInputFromDiscovery(peer)));
  }
  return trusted;
}

function printPeerSyncResult(result: Awaited<ReturnType<LocalDaemonProvider["syncTrustedPeers"]>>): void {
  console.log(`project: ${result.projectId}`);
  console.log(`task: ${result.taskId}`);
  console.log(`lane: ${result.laneId}`);
  console.log(`trustedPeers: ${result.peers.length}`);
  console.log(`advertisedBlocks: ${result.advertisedBlocks}`);
  console.log(`missingBlocks: ${result.missingBlocks}`);
  console.log(`fetchedBlocks: ${result.fetchedBlocks}`);
  console.log(`acceptedBlocks: ${result.acceptedBlocks}`);
  console.log(`insertedBlocks: ${result.insertedBlocks}`);
  console.log(`rejectedBlocks: ${result.rejectedBlocks}`);
  console.log(`finalTip: ${result.finalTip ?? "<empty>"}`);
  for (const peer of result.peers) {
    const status = peer.error ? `error: ${peer.error}` : `${peer.inserted}/${peer.missing} inserted, ${peer.advertised} advertised`;
    console.log(`peer: ${peer.endpoint} (${status})`);
  }
}

function printLaneInventory(inventory: Awaited<ReturnType<LocalDaemonProvider["laneInventory"]>>): void {
  console.log(`project: ${inventory.projectId}`);
  console.log(`task: ${inventory.taskId}`);
  console.log(`lane: ${inventory.laneId}`);
  console.log(`tip: ${inventory.tip ?? "<empty>"}`);
  console.log(`heads: ${(inventory.heads ?? []).join(",") || "<none>"}`);
  console.log(`activeBlocks: ${inventory.blockCount}`);
  console.log(`archivedBlocks: ${inventory.archivedCount}`);
  for (const block of inventory.blocks) {
    const blobs = block.blobDigests?.length ? ` blobs=${block.blobDigests.length}` : "";
    console.log(`${block.sequence} ${block.blockId} ${block.kind} parents=${block.parentTips.length} bytes=${block.sizeBytes}${blobs}`);
  }
}

function printProjectInventory(inventory: Awaited<ReturnType<LocalDaemonProvider["projectInventory"]>>): void {
  console.log(`project: ${inventory.projectId}`);
  if (inventory.taskId) console.log(`task: ${inventory.taskId}`);
  if (inventory.laneId) console.log(`lane: ${inventory.laneId}`);
  console.log(`lanes: ${inventory.lanes.length}`);
  for (const lane of inventory.lanes) {
    const heads = lane.heads?.length ? ` heads=${lane.heads.length}` : "";
    const updated = lane.updatedAt ? ` updated=${lane.updatedAt}` : "";
    console.log(`${lane.taskId}/${lane.laneId} active=${lane.blockCount} archived=${lane.archivedCount} epoch=${lane.leaseEpoch}${heads}${updated} tip=${lane.tip ?? "<empty>"}`);
  }
}

function printOnboardingDiscovery(source: string, peers: DiscoveredOnboardingPeer[], warnings: string[], trustedCount: number): void {
  if (peers.length === 0) console.log(`${source} peers: none`);
  for (const peer of peers) {
    const labels = [peer.name, peer.nodeId, peer.provider, peer.projects?.length ? `projects=${peer.projects.join(",")}` : undefined].filter(Boolean).join(", ");
    console.log(`${peer.endpoint}${labels ? ` (${labels})` : ""}`);
  }
  for (const warning of warnings) console.log(`warning: ${warning}`);
  if (trustedCount > 0) console.log(`trusted: ${trustedCount}`);
}

function printMdnsAdvertiserStatus(status: Awaited<ReturnType<typeof readMdnsAdvertiserStatus>>): void {
  console.log(`mDNS advertiser: ${status.running ? "running" : "stopped"}`);
  console.log(`state: ${status.stateFile}`);
  if (status.state) {
    console.log(`pid: ${status.state.pid}`);
    console.log(`name: ${status.state.name}`);
    console.log(`endpoint: ${status.state.endpoint}`);
  }
  if (status.reason) console.log(`reason: ${status.reason}`);
}

function printDaemonMdnsAdvertiserStatus(status: Awaited<ReturnType<LocalDaemonProvider["mdnsAdvertiserStatus"]>>): void {
  console.log(`mDNS advertiser: ${status.running ? "running" : "stopped"}`);
  console.log("manager: daemon");
  if (status.name) console.log(`name: ${status.name}`);
  if (status.endpoint) console.log(`endpoint: ${status.endpoint}`);
  if (status.startedAt) console.log(`startedAt: ${status.startedAt}`);
}

function printHelp(): void {
  console.log(`continuity <command>

Commands:
  install     Install local runtime, integrations, daemon, and optional task migration
  uninstall   Remove local install artifacts; keeps data unless --delete-data
  setup       Low-level local Postgres, Absurd, schema, integrations, and daemon setup
  checkpoint  Append a journal entry and rewrite canon through Absurd
  doctor      Verify CLI, runtime, database schemas, queue, and integrations
  dashboard   Render a tmux-friendly continuityd lane dashboard
  orient      Sync optionally and print an agent-native daemon orientation packet
  claim       Claim or initialize an interactive agent lane
  save        Agent-native shorthand for daemon checkpoint
  handoff     Release a lane or hand it to another actor
  agent-run   Orient, run a local command with continuity env, and checkpoint result
  scheduler-dashboard Render scheduler queue, workers, assignments, and results
  scheduler-task-submit Submit a task intent into a scheduler lane
  scheduler-worker-register Register a worker profile in a scheduler lane
  scheduler-run-once Sync optionally, claim one runnable task, and publish a result
  scheduler-worker-loop Run a continuous scheduler worker loop
  scheduler-worker-start Start a scheduler worker loop in tmux
  scheduler-worker-status Show scheduler worker tmux status and tail
  scheduler-worker-stop Stop a scheduler worker tmux loop
  scheduler-worker-attach Attach to a scheduler worker tmux loop
  scheduler-result Publish a manual task result for an assignment
  scheduler-evaluate Publish evaluator evidence for speculative candidate results
  scheduler-adjudicate Select/record a winning result and merge scheduler heads
  daemon-install Build/install the local continuityd daemon binary
  daemon-start Start continuityd from configured or default daemon paths
  daemon-stop Stop continuityd from configured or default daemon paths
  daemon-status Check local continuityd health
  daemon-migrate Migrate PostgreSQL continuity state into continuityd blocks
  peer-add   Trust a daemon peer endpoint for sync
  peer-list  List trusted daemon peer endpoints
  peer-remove Remove a trusted daemon peer endpoint
  peer-sync  Sync a task/lane from trusted daemon peers
  lane-inventory Show project/task/lane heads, active blocks, archived blocks, and blob refs
  lane-snapshot Create a compacting snapshot block for a lane
  lane-retain Archive cold active blocks after a snapshot
  blob-get   Read a content-addressed daemon blob
  peer-invite-create Create a signed peer invite URL
  peer-invite-accept Trust a signed peer invite URL
  presence-publish Publish signed presence to a rendezvous directory
  presence-discover Discover signed peers from a rendezvous directory
  rendezvous-publish Publish signed presence through file/git/s3/https rendezvous
  rendezvous-discover Discover signed peers through file/git/s3/https rendezvous
  node-init  Install/start daemon, publish presence, discover, and trust peers
  mdns-advertise Advertise signed peer presence with local DNS-SD
  mdns-advertise-status Show mDNS advertiser status
  mdns-advertise-stop Stop mDNS advertiser
  mdns-discover Discover signed peer presence with local DNS-SD
  peer-discover Optional provider discovery for Tailscale/ZeroTier peers
  start       Start the configured local runtime
  stop        Stop the configured local runtime
  backup      Dump the configured local Postgres database
  import      Import existing markdown projection into PostgreSQL through Absurd
  install --target all|opencode|claude
              Install only agent integrations
  reconcile   Rewrite canon from --canon-file through Absurd
  resume      Print the canon for a task from PostgreSQL
  status      Show database-backed continuity state

Examples:
  continuity install
  continuity install --project-id PROJECT --task-id TASK --lane-id main
  continuity install --start-worker --worker-project-id PROJECT --worker-task-id TASK --worker-preset codex
  continuity install --target all
  continuity uninstall
  continuity uninstall --delete-data
  continuity setup --local --daemon
  continuity doctor
  continuity checkpoint --task-id TASK --status completed --progress "Done" --next "Ship"
  continuity checkpoint --daemon --task-id TASK --status completed --progress "Done" --next "Ship"
  continuity import --task-id TASK --journal-file ~/.config/opencode/checkpoints/TASK.md --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity reconcile --task-id TASK --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity resume --task-id TASK
  continuity resume --daemon --task-id TASK
  continuity resume --daemon --sync --task-id TASK
  continuity status --json
  continuity dashboard --project-id PROJECT --task-id TASK --lane-id main
  continuity orient --project-id PROJECT --task-id TASK --sync
  continuity claim --project-id PROJECT --task-id TASK --reason "starting work"
  continuity save --project-id PROJECT --task-id TASK --status in_progress --progress "Implemented X" --next "Test Y"
  continuity handoff --project-id PROJECT --task-id TASK --target-actor-id claude-session-2
  continuity agent-run --project-id PROJECT --task-id TASK --command 'printf ok' --allowed-commands printf
  continuity scheduler-task-submit --project-id PROJECT --task-id TASK --title "Run smoke" --instructions "Run tests" --requires-tools shell,git
  continuity scheduler-worker-register --project-id PROJECT --task-id TASK --preset codex --node-id a0263
  continuity scheduler-run-once --project-id PROJECT --task-id TASK --worker-id a0263-codex --agent codex --model-families gpt --tools shell,git
  continuity scheduler-worker-loop --project-id PROJECT --task-id TASK --preset codex --node-id a0263 --sync --allowed-project-ids PROJECT --allowed-commands codex
  continuity scheduler-worker-start --project-id PROJECT --task-id TASK --preset codex --node-id a0263 --sync --allowed-project-ids PROJECT --allowed-commands codex
  continuity scheduler-worker-attach --worker-id a0263-codex
  continuity scheduler-evaluate --project-id PROJECT --task-id TASK --intent-block-id INTENT --result-block-ids RESULT_A,RESULT_B --recommended-winner-result-block-id RESULT_A --confidence high --summary "A passed the UX use cases"
  continuity scheduler-adjudicate --project-id PROJECT --task-id TASK --intent-block-id INTENT --result-block-ids RESULT_A,RESULT_B --winner-result-block-id RESULT_A --summary "Selected best output"
  continuity scheduler-dashboard --project-id PROJECT --task-id TASK --sync
  continuity peer-invite-create --endpoint tcp://10.44.110.222:9987
  continuity peer-invite-accept --invite 'continuity://peer?...'
  continuity presence-publish --rendezvous /shared/continuity --port 9987 --project-id PROJECT
  continuity presence-discover --rendezvous /shared/continuity --trusted-node-ids NODE --add
  continuity rendezvous-publish --backend git --repo git@github.com:OWNER/REPO.git --branch continuity-rendezvous --dir rendezvous --port 9987
  continuity rendezvous-discover --backend s3 --url s3://bucket/continuity --trusted-names macbook --add
  continuity rendezvous-discover --backend https --url https://rendezvous.example/continuity --trusted-names macbook
  continuity node-init --name macbook --project-id PROJECT --peer-listen :9987 --backend file --dir /shared/continuity --trust-names macbook,studio
  continuity node-init --name worker-a --peer-listen :9987 --endpoint tcp://worker-a:9987 --backend git --repo git@github.com:OWNER/REPO.git --branch continuity-rendezvous --trust-names orchestrator,worker-a
  continuity mdns-advertise --port 9987
  continuity mdns-advertise --daemon --port 9987
  continuity mdns-advertise --port 9987 --background
  continuity mdns-advertise-status
  continuity mdns-advertise-status --daemon
  continuity mdns-advertise-stop
  continuity mdns-advertise-stop --daemon
  continuity mdns-discover --trusted-names macbook --add
  continuity peer-add --endpoint tcp://100.64.0.2:9987 --name workstation
  continuity peer-sync --project-id PROJECT --task-id TASK
  continuity lane-inventory --project-id PROJECT --task-id TASK --lane-id main
  continuity lane-snapshot --project-id PROJECT --task-id TASK --lane-id main --summary "Compacted replay history"
  continuity lane-retain --project-id PROJECT --task-id TASK --lane-id main --keep-recent 20
  continuity blob-get --digest sha256:...
  continuity daemon-install --dry-run --launchd
  continuity daemon-start
  continuity daemon-migrate --project-id PROJECT --task-id TASK`);
}

function commandConfig(parsed: ParsedArgs): ContinuityConfig {
  const home = stringOption(parsed, "home");
  return loadConfig(home ? { ...process.env, CONTINUITY_HOME: home } : process.env);
}

function requireDatabaseConfig(config: ContinuityConfig): void {
  if (!config.databaseConfigured) {
    throw new Error("no continuity database configured; run continuity setup --local or set CONTINUITY_DATABASE_URL");
  }
}

function printActions(actions: ActionReport[]): void {
  for (const action of actions) {
    console.log(`${action.name}: ${action.status}${action.detail ? ` (${action.detail})` : ""}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
