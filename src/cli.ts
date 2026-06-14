#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultCheckpointInput, loadConfig, maskDatabaseUrl } from "./config.js";
import { installAgentContinuity, type InstallTarget } from "./install.js";
import { backupRuntime, doctor, setupLocal, startRuntime, stopRuntime, uninstallRuntime, type ActionReport } from "./setup.js";
import { continuityStatus, importCheckpoint, readCanon, reconcileCanon, runCheckpoint } from "./workflow.js";
import type { ContinuityConfig } from "./types.js";

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
        runtime: (stringOption(parsed, "runtime") as "docker" | undefined) ?? "docker",
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
      requireDatabaseConfig(config);
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
        source: stringOption(parsed, "source") ?? "cli",
      });
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
      requireDatabaseConfig(config);
      const taskId = requiredOption(parsed, "task-id");
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
      requireDatabaseConfig(config);
      const actions = await uninstallRuntime(config, { deleteData: Boolean(parsed.options["delete-data"]) });
      if (parsed.options.json) console.log(JSON.stringify(actions, null, 2));
      else {
        printActions(actions);
        if (!parsed.options["delete-data"]) console.log("Data volume was kept. Re-run with --delete-data to remove it.");
      }
      return;
    }
    case "install": {
      const result = await installAgentContinuity({
        target: (stringOption(parsed, "target") as InstallTarget | undefined) ?? "all",
        home: stringOption(parsed, "home"),
        dryRun: Boolean(parsed.options["dry-run"]),
      });
      if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`target: ${result.target}`);
        for (const path of result.wrote) console.log(`wrote: ${path}`);
        for (const path of result.skipped) console.log(`skipped: ${path}`);
        for (const message of result.messages) console.log(message);
        console.log("Restart OpenCode/Claude for integration changes to load.");
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

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = stringOption(parsed, name);
  if (!value) throw new Error(`missing required option --${name}`);
  return value;
}

function printHelp(): void {
  console.log(`continuity <command>

Commands:
  setup       Set up local Postgres, Absurd, continuity schema, and integrations
  checkpoint  Append a journal entry and rewrite canon through Absurd
  doctor      Verify CLI, runtime, database schemas, queue, and integrations
  start       Start the configured local runtime
  stop        Stop the configured local runtime
  backup      Dump the configured local Postgres database
  uninstall   Remove runtime container/config; keeps data unless --delete-data
  import      Import existing markdown projection into PostgreSQL through Absurd
  install     Install OpenCode and/or Claude integrations
  reconcile   Rewrite canon from --canon-file through Absurd
  resume      Print the canon for a task from PostgreSQL
  status      Show database-backed continuity state

Examples:
  continuity setup --local
  continuity doctor
  continuity checkpoint --task-id TASK --status completed --progress "Done" --next "Ship"
  continuity install --target all
  continuity import --task-id TASK --journal-file ~/.config/opencode/checkpoints/TASK.md --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity reconcile --task-id TASK --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity resume --task-id TASK
  continuity status --json`);
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
