// OpenCode integration for agent-continuity.
// Install this plugin after `continuity` is on PATH. It injects CLI-first rules;
// the CLI, not this plugin, owns durable checkpoint writes.
const ORIENT_RE = /\b(resume\s+from|continue\s+from|where\s+are\s+we|current\s+state|what(?:'|’)?s\s+the\s+state|what\s+did\s+we\s+do|d[oó]nde\s+estamos)\b/i;
const CHECKPOINT_RE = /\b(checkpoint|dump\s+context|save\s+progress|document\s+state|guardar?\s+progreso|guard[aá])\b/i;
const RESUME_FILE_RE = /\b(?:resume|continue)\s+from\s+`?([^`\s]+\.md)\b/i;

function textFromParts(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function taskHint(prompt) {
  const match = prompt.match(RESUME_FILE_RE);
  if (!match) return "";
  const file = match[1].split("/").pop().replace(/^~/, "");
  const taskID = file.endsWith(".canon.md") ? file.slice(0, -".canon.md".length) : file.slice(0, -".md".length);
  return taskID ? ` Inferred task id: ${taskID}. Run: continuity resume --task-id ${taskID}` : "";
}

export const AgentContinuity = async () => {
  const pendingBySession = new Map();
  return {
    "chat.message": async (input, output) => {
      const prompt = textFromParts(output.parts);
      const orient = ORIENT_RE.test(prompt);
      const checkpoint = CHECKPOINT_RE.test(prompt);
      if (orient || checkpoint) pendingBySession.set(input.sessionID, { orient, checkpoint, hint: taskHint(prompt) });
      else pendingBySession.delete(input.sessionID);
    },
    "experimental.chat.system.transform": async (input, output) => {
      const trigger = input.sessionID ? pendingBySession.get(input.sessionID) : null;
      if (!trigger) return;
      if (trigger.orient) {
        output.system.push(
          "AGENT CONTINUITY: resume/orient via the database authority first. Run `continuity resume --task-id <TASK-ID>` before reading markdown projections. Markdown under ~/.config/opencode/checkpoints is compatibility output, not the authority." +
            trigger.hint,
        );
      }
      if (trigger.checkpoint) {
        output.system.push(
          "AGENT CONTINUITY: checkpoint through Absurd. Do not edit checkpoint markdown directly as the authority. Build the semantic journal/canon content, then run `continuity checkpoint --task-id <TASK-ID> --status <status> --progress <summary> --next <next>`; pass `--canon-file` when you have a reconciled canon.",
        );
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        "AGENT CONTINUITY: after compaction, write checkpoint state with `continuity checkpoint`. PostgreSQL/Absurd is the authority; markdown canon/journal files are projections.",
      );
    },
  };
};

export default AgentContinuity;
