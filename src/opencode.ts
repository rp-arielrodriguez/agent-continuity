const ORIENT_RE = /\b(resume\s+from|continue\s+from|where\s+are\s+we|current\s+state|what(?:'|’)?s\s+the\s+state|what\s+did\s+we\s+do|d[oó]nde\s+estamos)\b/i;
const CHECKPOINT_RE = /\b(checkpoint|dump\s+context|save\s+progress|document\s+state|guardar?\s+progreso|guard[aá])\b/i;
const RESUME_FILE_RE = /\b(?:resume|continue)\s+from\s+`?([^`\s]+\.md)\b/i;

function textFromParts(parts: Array<{ type?: string; text?: string }> | undefined): string {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function taskHint(prompt: string): string {
  const match = prompt.match(RESUME_FILE_RE);
  if (!match) return "";
  const file = match[1].split("/").pop()?.replace(/^~/, "") ?? "";
  const taskId = file.endsWith(".canon.md") ? file.slice(0, -".canon.md".length) : file.slice(0, -".md".length);
  return taskId ? ` Inferred task id: ${taskId}. Run: continuity resume --daemon --task-id ${taskId}` : "";
}

export const AgentContinuity = async () => {
  const pendingBySession = new Map<string, { orient: boolean; checkpoint: boolean; hint: string }>();
  return {
    "chat.message": async (input: { sessionID: string }, output: { parts?: Array<{ type?: string; text?: string }> }) => {
      const prompt = textFromParts(output.parts);
      const orient = ORIENT_RE.test(prompt);
      const checkpoint = CHECKPOINT_RE.test(prompt);
      if (orient || checkpoint) pendingBySession.set(input.sessionID, { orient, checkpoint, hint: taskHint(prompt) });
      else pendingBySession.delete(input.sessionID);
    },
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      const trigger = input.sessionID ? pendingBySession.get(input.sessionID) : null;
      if (!trigger) return;
      if (trigger.orient) {
        output.system.push(
          "AGENT CONTINUITY: resume/orient via daemon continuity first. Run `continuity resume --daemon --task-id <TASK-ID>` before reading markdown projections; it infers project id from the current git remote unless `--project-id` is provided. If the daemon is unavailable, fall back to `continuity resume --task-id <TASK-ID>` from PostgreSQL compatibility state. Markdown under ~/.config/opencode/checkpoints is compatibility output, not the authority." +
            trigger.hint,
        );
      }
      if (trigger.checkpoint) {
        output.system.push(
          "AGENT CONTINUITY: checkpoint through daemon continuity. Do not edit checkpoint markdown directly as the authority. Build the semantic checkpoint/canon content, then run `continuity checkpoint --daemon --task-id <TASK-ID> --status <status> --progress <summary> --next <next>`; pass `--canon-file` when you have a reconciled canon. If the daemon is unavailable, fall back to PostgreSQL compatibility with the same command without `--daemon`.",
        );
      }
    },
    "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
      output.context.push(
        "AGENT CONTINUITY: after compaction, write checkpoint state with `continuity checkpoint --daemon`. Daemon continuity is the preferred authority; PostgreSQL/Absurd remains compatibility fallback; markdown canon/journal files are projections.",
      );
    },
  };
};

export default AgentContinuity;
