import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const requiredUseCases = [
  "AC-INSTALL-001",
  "AC-MANUAL-001",
  "AC-HARNESS-ORIENT-001",
  "AC-HARNESS-CLAIM-001",
  "AC-HARNESS-SAVE-001",
  "AC-HARNESS-HANDOFF-001",
  "AC-HARNESS-RUN-001",
  "AC-HARNESS-RUN-002",
  "AC-INTENT-001",
  "AC-INTENT-002",
  "AC-INTEGRATION-001",
  "AC-INTEGRATION-002",
  "AC-RECOVERY-001",
  "AC-RECOVERY-002",
  "AC-RUNEVENT-001",
  "AC-DISCOVERY-001",
  "AC-DISCOVERY-002",
  "AC-DISCOVERY-003",
  "AC-DISCOVERY-004",
  "AC-TRUST-001",
  "AC-SYNC-001",
  "AC-SYNC-002",
  "AC-STORAGE-001",
  "AC-STORAGE-002",
  "AC-STORAGE-003",
  "AC-SCHED-001",
  "AC-SCHED-002",
  "AC-SCHED-003",
  "AC-SCHED-004",
  "AC-SCHED-005",
  "AC-SCHED-006",
  "AC-SCHED-007",
  "AC-TMUX-001",
  "AC-REAL-AGENTS-001",
];

test("acceptance Rubik matrix lists every supported use case with concrete evidence", async () => {
  const matrix = await readFile(path.join(process.cwd(), "docs", "acceptance-matrix.md"), "utf8");
  const rows = matrix
    .split("\n")
    .filter((line) => line.startsWith("| AC-"))
    .map(parseMatrixRow);

  assert.deepEqual(rows.map((row) => row.id).sort(), [...requiredUseCases].sort());
  for (const row of rows) {
    assert.equal(row.cells.length, 8, `${row.id} should keep all Rubik evidence columns`);
    assert(!/future|needs coverage|todo/i.test(row.cells.join(" ")), `${row.id} should not claim unsupported future evidence`);
    assert(
      row.cells.slice(3).some((cell) => cell.includes("test/") || cell.includes("daemon/") || cell.includes("npm run") || cell.includes("physical") || cell.includes("CLI")),
      `${row.id} should name at least one executable evidence path`,
    );
  }
});

function parseMatrixRow(line: string): { id: string; cells: string[] } {
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  return { id: cells[0], cells };
}
