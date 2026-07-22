import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.js";

export type InstallTarget = "all" | "opencode" | "claude" | "codex";

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
const LEGACY_CODEX_SESSION_HOOK = "agent-continuity-session-start.sh";
const PROMPT_HOOK = "agent-continuity-user-prompt-submit.sh";
const CODEX_SUBAGENT_HOOK = "agent-continuity-subagent-start.sh";
const CODEX_POST_COMPACT_HOOK = "agent-continuity-post-compact.sh";
const CHECKPOINT_SKILL = join("checkpoints", "SKILL.md");

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
  if (target === "all" || target === "codex") {
    await installCodex(home, result, options.dryRun ?? false);
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
  if (target === "all" || target === "codex") {
    await uninstallCodex(home, result, options.dryRun ?? false);
  }

  return result;
}

async function installOpenCode(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const configDir = join(home, ".config", "opencode");
  const pluginDir = join(configDir, "plugins");
  const legacyPluginPath = join(pluginDir, LEGACY_OPENCODE_PLUGIN);
  const configPath = join(configDir, "opencode.json");
  const skillPath = join(configDir, "skills", CHECKPOINT_SKILL);

  await removeIfExists(legacyPluginPath, result, dryRun);
  await installCheckpointSkill(skillPath, result, dryRun);

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
  const skillPath = join(configDir, "skills", CHECKPOINT_SKILL);

  await removeIfExists(legacyPluginPath, result, dryRun);
  await removeIfExists(skillPath, result, dryRun);

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
  const promptHookPath = join(hooksDir, PROMPT_HOOK);
  const legacySessionHookPath = join(hooksDir, LEGACY_CLAUDE_SESSION_HOOK);
  const skillPath = join(claudeDir, "skills", CHECKPOINT_SKILL);
  const settingsPath = join(claudeDir, "settings.json");

  await writeIfChanged(promptHookPath, await readFile(templatePath("integrations/shared/hooks/user-prompt-submit.sh"), "utf8"), result, dryRun, 0o755);
  await removeIfExists(legacySessionHookPath, result, dryRun);
  await installCheckpointSkill(skillPath, result, dryRun);

  const settings = (await readJsonObject(settingsPath, {})) as SettingsJson;
  settings.hooks ??= {};
  const sessionStartHooks = removeNamedCommandHook(settings.hooks.SessionStart, LEGACY_CLAUDE_SESSION_HOOK);
  if (sessionStartHooks) settings.hooks.SessionStart = sessionStartHooks;
  else delete settings.hooks.SessionStart;
  settings.hooks.UserPromptSubmit = replaceNamedCommandHook(
    settings.hooks.UserPromptSubmit,
    PROMPT_HOOK,
    { type: "command", command: `bash ~/.claude/hooks/${PROMPT_HOOK}`, statusMessage: "Checking Continuity intent" },
  );
  await writeJson(settingsPath, settings, result, dryRun);

  result.messages.push(`Claude hook: ${promptHookPath}`);
}

async function uninstallClaude(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const claudeDir = join(home, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const promptHookPath = join(hooksDir, PROMPT_HOOK);
  const legacySessionHookPath = join(hooksDir, LEGACY_CLAUDE_SESSION_HOOK);
  const skillPath = join(claudeDir, "skills", CHECKPOINT_SKILL);
  const settingsPath = join(claudeDir, "settings.json");

  await removeIfExists(promptHookPath, result, dryRun);
  await removeIfExists(legacySessionHookPath, result, dryRun);
  await removeIfExists(skillPath, result, dryRun);

  const rawSettings = await readExisting(settingsPath);
  if (rawSettings === null) {
    result.skipped.push(settingsPath);
    return;
  }
  const settings = parseJsonObject(settingsPath, rawSettings) as SettingsJson;
  if (settings.hooks) {
    const promptHooks = removeNamedCommandHook(settings.hooks.UserPromptSubmit, PROMPT_HOOK);
    if (promptHooks) settings.hooks.UserPromptSubmit = promptHooks;
    else delete settings.hooks.UserPromptSubmit;

    const sessionHooks = removeNamedCommandHook(settings.hooks.SessionStart, LEGACY_CLAUDE_SESSION_HOOK);
    if (sessionHooks) settings.hooks.SessionStart = sessionHooks;
    else delete settings.hooks.SessionStart;

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  await writeJson(settingsPath, settings, result, dryRun);

  result.messages.push(`Claude hook removed: ${promptHookPath}`);
}

async function installCodex(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const codexDir = join(home, ".codex");
  const hooksDir = join(codexDir, "hooks");
  const promptHookPath = join(hooksDir, PROMPT_HOOK);
  const subagentHookPath = join(hooksDir, CODEX_SUBAGENT_HOOK);
  const postCompactHookPath = join(hooksDir, CODEX_POST_COMPACT_HOOK);
  const legacySessionHookPath = join(hooksDir, LEGACY_CODEX_SESSION_HOOK);
  const skillPath = join(codexDir, "skills", CHECKPOINT_SKILL);
  const hooksPath = join(codexDir, "hooks.json");

  await writeIfChanged(promptHookPath, await readFile(templatePath("integrations/shared/hooks/user-prompt-submit.sh"), "utf8"), result, dryRun, 0o755);
  await writeIfChanged(subagentHookPath, await readFile(templatePath("integrations/codex/hooks/subagent-start.sh"), "utf8"), result, dryRun, 0o755);
  await writeIfChanged(postCompactHookPath, await readFile(templatePath("integrations/codex/hooks/post-compact.sh"), "utf8"), result, dryRun, 0o755);
  await removeIfExists(legacySessionHookPath, result, dryRun);
  await installCheckpointSkill(skillPath, result, dryRun);

  const settings = (await readJsonObject(hooksPath, {})) as SettingsJson;
  settings.hooks ??= {};
  const sessionStartHooks = removeNamedCommandHook(settings.hooks.SessionStart, LEGACY_CODEX_SESSION_HOOK);
  if (sessionStartHooks) settings.hooks.SessionStart = sessionStartHooks;
  else delete settings.hooks.SessionStart;
  settings.hooks.UserPromptSubmit = replaceNamedCommandHook(
    settings.hooks.UserPromptSubmit,
    PROMPT_HOOK,
    { type: "command", command: `bash ~/.codex/hooks/${PROMPT_HOOK}`, statusMessage: "Checking Continuity intent" },
  );
  settings.hooks.SubagentStart = replaceNamedCommandHook(
    settings.hooks.SubagentStart,
    CODEX_SUBAGENT_HOOK,
    { type: "command", command: `bash ~/.codex/hooks/${CODEX_SUBAGENT_HOOK}`, statusMessage: "Loading Continuity contract" },
  );
  settings.hooks.PostCompact = replaceNamedCommandHook(
    settings.hooks.PostCompact,
    CODEX_POST_COMPACT_HOOK,
    { type: "command", command: `bash ~/.codex/hooks/${CODEX_POST_COMPACT_HOOK}`, statusMessage: "Recovering Continuity context" },
    "manual|auto",
  );
  await writeJson(hooksPath, settings, result, dryRun);

  result.messages.push(`Codex hooks: ${hooksDir}`);
}

async function uninstallCodex(home: string, result: InstallResult, dryRun: boolean): Promise<void> {
  const codexDir = join(home, ".codex");
  const hooksDir = join(codexDir, "hooks");
  const hooksPath = join(codexDir, "hooks.json");
  const hookNames = [PROMPT_HOOK, CODEX_SUBAGENT_HOOK, CODEX_POST_COMPACT_HOOK, LEGACY_CODEX_SESSION_HOOK];

  for (const hookName of hookNames) await removeIfExists(join(hooksDir, hookName), result, dryRun);
  await removeIfExists(join(codexDir, "skills", CHECKPOINT_SKILL), result, dryRun);

  const rawSettings = await readExisting(hooksPath);
  if (rawSettings === null) {
    result.skipped.push(hooksPath);
    return;
  }
  const settings = parseJsonObject(hooksPath, rawSettings) as SettingsJson;
  if (settings.hooks) {
    for (const [event, hookName] of [
      ["UserPromptSubmit", PROMPT_HOOK],
      ["SubagentStart", CODEX_SUBAGENT_HOOK],
      ["PostCompact", CODEX_POST_COMPACT_HOOK],
      ["SessionStart", LEGACY_CODEX_SESSION_HOOK],
    ] as const) {
      const hooks = removeNamedCommandHook(settings.hooks[event], hookName);
      if (hooks) settings.hooks[event] = hooks;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  await writeJson(hooksPath, settings, result, dryRun);

  result.messages.push(`Codex hooks removed: ${hooksDir}`);
}

function replaceNamedCommandHook(groups: HookGroup[] | undefined, hookName: string, hook: CommandHook, matcher?: string): HookGroup[] {
  const existing = removeNamedCommandHook(groups, hookName) ?? [];
  return [...existing, { ...(matcher ? { matcher } : {}), hooks: [hook] }];
}

function removeNamedCommandHook(groups: HookGroup[] | undefined, hookName: string): HookGroup[] | undefined {
  const next = (groups ?? [])
    .map((group) => ({
      ...group,
      hooks: group.hooks?.filter((hook) => !(hook.type === "command" && hook.command.includes(hookName))),
    }))
    .filter((group) => group.hooks === undefined || group.hooks.length > 0);
  return next.length > 0 ? next : undefined;
}

async function installCheckpointSkill(path: string, result: InstallResult, dryRun: boolean): Promise<void> {
  await writeIfChanged(path, await readFile(templatePath("integrations/shared/skills/checkpoints/SKILL.md"), "utf8"), result, dryRun);
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
    if (mode !== undefined && await modeDiffers(path, mode)) {
      result.wrote.push(path);
      if (!dryRun) await chmod(path, mode);
      return;
    }
    result.skipped.push(path);
    return;
  }

  result.wrote.push(path);
  if (dryRun) return;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  if (mode !== undefined) await chmod(path, mode);
}

async function modeDiffers(path: string, expected: number): Promise<boolean> {
  return ((await stat(path)).mode & 0o777) !== expected;
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
