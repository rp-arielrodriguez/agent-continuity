import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function inferProjectId(cwd = process.cwd()): Promise<string> {
  let remote = "";
  try {
    const result = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd });
    remote = result.stdout.trim();
  } catch {
    throw new Error("missing --project-id and git remote.origin.url could not be read");
  }

  const projectId = projectIdFromRemote(remote);
  if (!projectId) throw new Error(`cannot infer project id from remote.origin.url: ${remote}`);
  return projectId;
}

export function projectIdFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  if (trimmed === "") return null;

  const scpLike = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpLike) return lastTwoPathParts(scpLike[1]);

  try {
    const url = new URL(trimmed);
    return lastTwoPathParts(url.pathname);
  } catch {
    return lastTwoPathParts(trimmed);
  }
}

function lastTwoPathParts(value: string): string | null {
  const parts = value
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}
