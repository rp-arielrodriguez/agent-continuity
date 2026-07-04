import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.js";

export type InstallTarget = "all" | "opencode" | "claude";

export interface InstallOptions {
  home?: string;
  target?: InstallTarget;
  dryRun?: boolean;
}

export interface InstallResult {
  target: InstallTarget;
  wrote: string[];
  removed: string[];
  skipped: string[];
  messages: string[];
}

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: CommandHook[];
}

type SettingsJson = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

const OPENCODE_PLUGIN_PACKAGE = "agent-continuity";
const LEGACY_OPENCODE_PLUGIN = "agent-continuity.js";
const LEGACY_CLAUDE_SESSION_HOOK = "agent-continuity-session-start.sh";
const CLAUDE_PROMPT_HOOK = "agent-continuity-user-prompt-submit.sh";

export async function installAgentContinuity(options: InstallOptions = {}): Promise<InstallResult> {
  const target = options.target ?? "all";
  const home = expandHome(options.home ?? "~");
  const result: InstallResult = { target, wrote: [], removed: [], skipped: [], messages: [] };

  if (target === "all" || target === "opencode") {
    await installOpenCode(home, result, options.dryRun ?? false);
  }
  if (target === "all" || target === "claude") {
    await installClaude(home, result, options.dryRun ?? false);
  }

  return result;
}

export async function uninstallAgentContinuity(options: InstallOptions = {}): Promise<InstallResult> {
  const target = options.target ?? "all";
  const home = expandHome(options.home ?? "~");
  const result: InstallResult = { target, wrote: [], removed: [], skipped: [], messages: [] };

  if (target === "all" || target === "opencode") {
    await uninstallOpenCode(home, result, options.dryRun ?? false);
  }
  if (target === "all" || target === "claude") {
    await uninstallClaude(home, result, options.dryRun ?? false);
  }

  return result;
}

async function installOpenCode(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const configDir = join(home, ".config", "opencode");
  const pluginDir = join(configDir, "plugins");
  const legacyPluginPath = join(pluginDir, LEGACY_OPENCODE_PLUGIN);
  const configPath = join(configDir, "opencode.json");

  await removeIfExists(legacyPluginPath, result, dryRun);

  const config = await readJsonObject(configPath, { $schema: "https://opencode.ai/config.json" });
  const plugins = Array.isArray(config.plugin) ? [...config.plugin] : [];
  const nextPlugins = plugins.filter((plugin) => !isLegacyOpenCodePlugin(plugin));
  if (!nextPlugins.includes(OPENCODE_PLUGIN_PACKAGE)) {
    nextPlugins.push(OPENCODE_PLUGIN_PACKAGE);
  }

  if (JSON.stringify(plugins) !== JSON.stringify(nextPlugins)) {
    config.plugin = nextPlugins;
    await writeJson(configPath, config, result, dryRun);
  } else {
    result.skipped.push(configPath);
  }

  result.messages.push(`OpenCode plugin: ${OPENCODE_PLUGIN_PACKAGE}`);
}

async function uninstallOpenCode(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const configDir = join(home, ".config", "opencode");
  const pluginDir = join(configDir, "plugins");
  const legacyPluginPath = join(pluginDir, LEGACY_OPENCODE_PLUGIN);
  const configPath = join(configDir, "opencode.json");

  await removeIfExists(legacyPluginPath, result, dryRun);

  const rawConfig = await readExisting(configPath);
  if (rawConfig === null) {
    result.skipped.push(configPath);
    return;
  }
  const config = parseJsonObject(configPath, rawConfig);
  const plugins = Array.isArray(config.plugin) ? [...config.plugin] : [];
  const nextPlugins = plugins.filter((plugin) => plugin !== OPENCODE_PLUGIN_PACKAGE && !isLegacyOpenCodePlugin(plugin));
  if (JSON.stringify(plugins) !== JSON.stringify(nextPlugins)) {
    if (nextPlugins.length > 0) config.plugin = nextPlugins;
    else delete config.plugin;
    await writeJson(configPath, config, result, dryRun);
  } else {
    result.skipped.push(configPath);
  }

  result.messages.push(`OpenCode plugin removed: ${OPENCODE_PLUGIN_PACKAGE}`);
}

async function installClaude(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const claudeDir = join(home, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const promptHookPath = join(hooksDir, CLAUDE_PROMPT_HOOK);
  const settingsPath = join(claudeDir, "settings.json");

  await writeIfChanged(promptHookPath, await readFile(templatePath("integrations/claude/hooks/user-prompt-submit.sh"), "utf8"), result, dryRun, 0o755);

  const settings = (await readJsonObject(settingsPath, {})) as SettingsJson;
  settings.hooks ??= {};
  const sessionStartHooks = removeCommandHook(settings.hooks.SessionStart, `bash ~/.claude/hooks/${LEGACY_CLAUDE_SESSION_HOOK}`);
  if (sessionStartHooks) settings.hooks.SessionStart = sessionStartHooks;
  else delete settings.hooks.SessionStart;
  settings.hooks.UserPromptSubmit = addCommandHook(settings.hooks.UserPromptSubmit, `bash ~/.claude/hooks/${CLAUDE_PROMPT_HOOK}`);
  await writeJson(settingsPath, settings, result, dryRun);

  result.messages.push(`Claude hook: ${promptHookPath}`);
}

async function uninstallClaude(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const claudeDir = join(home, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const promptHookPath = join(hooksDir, CLAUDE_PROMPT_HOOK);
  const legacySessionHookPath = join(hooksDir, LEGACY_CLAUDE_SESSION_HOOK);
  const settingsPath = join(claudeDir, "settings.json");

  await removeIfExists(promptHookPath, result, dryRun);
  await removeIfExists(legacySessionHookPath, result, dryRun);

  const rawSettings = await readExisting(settingsPath);
  if (rawSettings === null) {
    result.skipped.push(settingsPath);
    return;
  }
  const settings = parseJsonObject(settingsPath, rawSettings) as SettingsJson;
  if (settings.hooks) {
    const promptHooks = removeCommandHook(settings.hooks.UserPromptSubmit, `bash ~/.claude/hooks/${CLAUDE_PROMPT_HOOK}`);
    if (promptHooks) settings.hooks.UserPromptSubmit = promptHooks;
    else delete settings.hooks.UserPromptSubmit;

    const sessionHooks = removeCommandHook(settings.hooks.SessionStart, `bash ~/.claude/hooks/${LEGACY_CLAUDE_SESSION_HOOK}`);
    if (sessionHooks) settings.hooks.SessionStart = sessionHooks;
    else delete settings.hooks.SessionStart;

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  await writeJson(settingsPath, settings, result, dryRun);

  result.messages.push(`Claude hook removed: ${promptHookPath}`);
}

function addCommandHook(groups: HookGroup[] | undefined, command: string): HookGroup[] {
  const existing = groups ?? [];
  if (existing.some((group) => group.hooks?.some((hook) => hook.type === "command" && hook.command === command))) {
    return existing;
  }
  return [...existing, { hooks: [{ type: "command", command }] }];
}

function removeCommandHook(groups: HookGroup[] | undefined, command: string): HookGroup[] | undefined {
  const next = (groups ?? [])
    .map((group) => {
      const hooks = group.hooks?.filter((hook) => !(hook.type === "command" && hook.command === command));
      return { ...group, hooks };
    })
    .filter((group) => group.hooks === undefined || group.hooks.length > 0);
  return next.length > 0 ? next : undefined;
}

async function readJsonObject(path: string, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...fallback };
    throw new Error(`failed to read JSON config ${path}: ${(error as Error).message}`);
  }
  return parseJsonObject(path, content);
}

function parseJsonObject(path: string, content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`failed to read JSON config ${path}: ${(error as Error).message}`);
  }
}

async function writeJson(path: string, value: unknown, result: InstallResult, dryRun: boolean): Promise<void> {
  await writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`, result, dryRun);
}

async function writeIfChanged(path: string, content: string, result: InstallResult, dryRun: boolean, mode?: number): Promise<void> {
  const current = await readExisting(path);
  if (current === content) {
    result.skipped.push(path);
    return;
  }

  result.wrote.push(path);
  if (dryRun) return;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  if (mode !== undefined) await chmod(path, mode);
}

async function removeIfExists(path: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const current = await readExisting(path);
  if (current === null) return;

  result.removed.push(path);
  if (!dryRun) await rm(path, { force: true });
}

function isLegacyOpenCodePlugin(value: unknown): boolean {
  return typeof value === "string" && value.endsWith(`/${LEGACY_OPENCODE_PLUGIN}`);
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function templatePath(relativePath: string): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return join(packageRoot, relativePath);
}
