#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultCheckpointInput, loadConfig } from "./config.js";
import { continuityStatus, importCheckpoint, readCanon, reconcileCanon, runCheckpoint } from "./workflow.js";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const config = loadConfig();

  switch (parsed.command) {
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
      const taskId = requiredOption(parsed, "task-id");
      const canon = await readCanon(taskId, config);
      if (!canon) throw new Error(`no canon found for task ${taskId}`);
      console.log(canon.endsWith("\n") ? canon.trimEnd() : canon);
      return;
    }
    case "reconcile": {
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
      const status = await continuityStatus(config);
      if (parsed.options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`database: ${config.databaseUrl}`);
        console.log(`queue: ${config.queueName}`);
        console.log(`checkpointDir: ${config.checkpointDir}`);
        console.log(`tasks: ${status.tasks}`);
        console.log(`journalEntries: ${status.journalEntries}`);
        console.log(`canons: ${status.canons}`);
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

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = stringOption(parsed, name);
  if (!value) throw new Error(`missing required option --${name}`);
  return value;
}

function printHelp(): void {
  console.log(`continuity <command>

Commands:
  checkpoint  Append a journal entry and rewrite canon through Absurd
  import      Import existing markdown projection into PostgreSQL through Absurd
  reconcile   Rewrite canon from --canon-file through Absurd
  resume      Print the canon for a task from PostgreSQL
  status      Show database-backed continuity state

Examples:
  continuity checkpoint --task-id TASK --status completed --progress "Done" --next "Ship"
  continuity import --task-id TASK --journal-file ~/.config/opencode/checkpoints/TASK.md --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity reconcile --task-id TASK --canon-file ~/.config/opencode/checkpoints/TASK.canon.md
  continuity resume --task-id TASK
  continuity status --json`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
