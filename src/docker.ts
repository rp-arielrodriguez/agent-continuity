import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerRuntimeConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await runDocker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

export async function dockerContainerExists(name: string): Promise<boolean> {
  const result = await runDocker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
  return result.stdout.split("\n").includes(name);
}

export async function dockerContainerRunning(name: string): Promise<boolean> {
  const result = await runDocker(["ps", "--filter", `name=^/${name}$`, "--filter", "status=running", "--format", "{{.Names}}"]);
  return result.stdout.split("\n").includes(name);
}

export async function dockerVolumeExists(name: string): Promise<boolean> {
  try {
    await runDocker(["volume", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDockerVolume(name: string): Promise<"created" | "exists"> {
  if (await dockerVolumeExists(name)) return "exists";
  await runDocker(["volume", "create", name]);
  return "created";
}

export async function ensureDockerContainer(runtime: DockerRuntimeConfig): Promise<"created" | "started" | "running"> {
  if (await dockerContainerRunning(runtime.containerName)) return "running";

  if (await dockerContainerExists(runtime.containerName)) {
    await runDocker(["start", runtime.containerName]);
    return "started";
  }

  await runDocker([
    "run",
    "--detach",
    "--name",
    runtime.containerName,
    "--env",
    `POSTGRES_USER=${runtime.user}`,
    "--env",
    `POSTGRES_PASSWORD=${runtime.password}`,
    "--env",
    `POSTGRES_DB=${runtime.database}`,
    "--publish",
    `${runtime.host}:${runtime.port}:5432`,
    "--volume",
    `${runtime.volumeName}:/var/lib/postgresql/data`,
    runtime.image,
  ]);
  return "created";
}

export async function startDockerContainer(name: string): Promise<"started" | "running"> {
  if (await dockerContainerRunning(name)) return "running";
  if (!(await dockerContainerExists(name))) throw new Error(`docker container not found: ${name}`);
  await runDocker(["start", name]);
  return "started";
}

export async function stopDockerContainer(name: string): Promise<"stopped" | "not-running"> {
  if (!(await dockerContainerRunning(name))) return "not-running";
  await runDocker(["stop", name]);
  return "stopped";
}

export async function removeDockerContainer(name: string): Promise<"removed" | "missing"> {
  if (!(await dockerContainerExists(name))) return "missing";
  await runDocker(["rm", "--force", name]);
  return "removed";
}

export async function removeDockerVolume(name: string): Promise<"removed" | "missing"> {
  if (!(await dockerVolumeExists(name))) return "missing";
  await runDocker(["volume", "rm", name]);
  return "removed";
}

export async function dumpPostgres(runtime: DockerRuntimeConfig): Promise<string> {
  const result = await runDocker(["exec", runtime.containerName, "pg_dump", "-U", runtime.user, "-d", runtime.database]);
  return result.stdout;
}

export async function runDocker(args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 * 50 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const details = [err.message, err.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(details);
  }
}
