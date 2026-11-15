import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { z } from "zod";
import { installedCli } from "./cli-update";
import { tidelineApiOrigin } from "./login";
import { createApprovedScope } from "./sync-projects";
import { openSyncStorage, syncDirectoryPath } from "./sync-storage";
import { wakeSyncCollector } from "./sync-wake";

const agents = z.enum(["codex", "claude-code"]);
const choice = z.enum(["all", ...agents.options]);
const events = {
  codex: ["Stop", "SessionEnd"],
  "claude-code": ["SessionStart", "Stop", "SessionEnd"],
} as const;
const names = { codex: "Codex", "claude-code": "Claude Code" } as const;
const settingsObject = z.record(z.string(), z.unknown());
const hookGroup = z.looseObject({ hooks: z.array(z.unknown()) });
const hookGroups = z.array(hookGroup);
const maximumSettingsBytes = 1024 * 1024;
type Agent = z.infer<typeof agents>;
type Settings = z.infer<typeof settingsObject>;
type InstallContext = { launcher: string; node: string };

function settingsPath(agent: Agent) {
  return agent === "codex"
    ? join(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")), "hooks.json")
    : join(resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), "settings.json");
}

function absent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function ownPath(stat: Stats) {
  return (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

function unmodified(expected: Stats, actual: Stats) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}

async function isSettingsDirectory(directory: string) {
  const stat = await lstat(directory).catch((error: unknown) => {
    if (absent(error)) return;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || !ownPath(stat) || await realpath(directory) !== directory) {
    throw new Error(`Use a regular, owner-writable hook settings directory at ${directory}.`);
  }
  return true;
}

async function readSettings(path: string): Promise<{ value: Settings; stat?: Stats; original: string }> {
  if (!await isSettingsDirectory(dirname(path))) return { value: {}, original: "" };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (absent(error)) return;
    throw new Error(`Cannot read ${path} as a regular hook settings file.`);
  });
  if (!file) return { value: {}, original: "" };
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !ownPath(stat) || stat.size > maximumSettingsBytes) {
      throw new Error(`Use a regular hook settings file owned by you and under 1 MiB at ${path}.`);
    }
    const bytes = Buffer.alloc(maximumSettingsBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumSettingsBytes || !unmodified(stat, await lstat(path)) || !await isSettingsDirectory(dirname(path))) {
      throw new Error(`Hook settings changed while Tideline read ${path}. Try again.`);
    }
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    let json: unknown;
    try { json = JSON.parse(original); } catch { throw new Error(`Correct the JSON in ${path} and try again.`); }
    const value = settingsObject.safeParse(json).data;
    if (!value) throw new Error(`Hook settings in ${path} must be a JSON object.`);
    return { value, stat, original };
  } finally {
    await file.close();
  }
}

async function saveSettings(path: string, next: Settings, previous: Awaited<ReturnType<typeof readSettings>>) {
  const directory = dirname(path);
  if (!await isSettingsDirectory(directory)) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await isSettingsDirectory(directory)) throw new Error(`Could not use the hook settings directory at ${directory}.`);
  const temporary = await mkdtemp(join(directory, ".tideline-hooks-"));
  try {
    const staged = join(temporary, "settings.json");
    const indentation = previous.original.match(/\n([ \t]+)"/u)?.[1] ?? "  ";
    const text = JSON.stringify(next, null, indentation) + "\n";
    if (Buffer.byteLength(text) > maximumSettingsBytes) throw new Error(`Hook settings at ${path} would exceed 1 MiB.`);
    await writeFile(staged, text, { flag: "wx", mode: previous.stat ? previous.stat.mode & 0o777 : 0o600 });
    if (previous.stat) {
      if (!unmodified(previous.stat, await lstat(path))) throw new Error(`Hook settings changed at ${path}. Try again.`);
      await rename(staged, path);
    } else {
      await link(staged, path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error(`Hook settings were created at ${path}. Try again.`);
        }
        throw error;
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ownershipSuffix(scope: string) {
  return ` # tideline-hook-v1-${createHash("sha256").update(scope).digest("hex").slice(0, 24)}`;
}

function reconcileSettings(value: Settings, path: string, agent: Agent, scope: string, installation?: InstallContext) {
  const configured = value.hooks === undefined ? {} : settingsObject.safeParse(value.hooks).data;
  if (!configured) throw new Error(`The hooks property in ${path} must be a JSON object.`);
  let found = 0;
  const suffix = ownershipSuffix(scope);
  for (const event of events[agent]) {
    const commandSuffix = ` hooks __wake ${agent} ${event}${suffix}`;
    const groups = configured[event] === undefined ? [] : hookGroups.safeParse(configured[event]).data;
    if (!groups) throw new Error(`Correct the ${event} hook entries in ${path} and try again.`);
    let foundEvent = false;
    const remaining = groups.flatMap((group) => {
      const hooks = group.hooks.filter((entry) => {
        const hook = settingsObject.safeParse(entry).data;
        if (hook?.type !== "command" || typeof hook.command !== "string" ||
            !hook.command.startsWith("/usr/bin/env ") || !hook.command.endsWith(commandSuffix)) return true;
        return false;
      });
      if (hooks.length === group.hooks.length) return [group];
      foundEvent = true;
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (foundEvent) found++;
    if (installation) {
      const path = [dirname(installation.node), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
      const args = ["PATH=" + path, "TIDELINE_SYNC_HOME=" + scope, "NODE_NO_WARNINGS=1", installation.launcher];
      const hook = { type: "command", command: `/usr/bin/env ${args.map(shellQuote).join(" ")}${commandSuffix}`, timeout: 3,
        ...(event !== "SessionEnd" && { async: true }) };
      remaining.push({ hooks: [hook] });
    }
    if (remaining.length > 0) configured[event] = remaining;
    else delete configured[event];
  }
  const { hooks: _, ...rest } = value;
  return { value: Object.keys(configured).length ? { ...rest, hooks: configured } : rest, found };
}

export async function configureNativeHooks(action: "install" | "remove" | "status", selection: unknown = "all", { reportFollowUp = false } = {}) {
  if (process.platform === "win32") throw new Error("Tideline sync hooks currently require macOS or Linux.");
  const target = choice.parse(selection);
  const scope = syncDirectoryPath();
  const selected = target === "all" ? agents.options : [target];
  let installation: InstallContext | undefined;
  if (action === "install") {
    const installed = await installedCli();
    if (!installed) throw new Error("Install Tideline using your dashboard's setup command before installing hooks.");
    installation = { launcher: installed.launcher, node: process.execPath };
    if (![scope, installation.launcher, installation.node].every((path) => isAbsolute(path) && !/[\x00-\x1f\x7f]/u.test(path)) ||
        dirname(installation.node).includes(":")) throw new Error("Hooks need absolute paths without control characters and a Node directory without colons.");
    if (!reportFollowUp) {
      const storage = await openSyncStorage();
      try {
        const config = storage.config();
        if (!config?.projects.length) throw new Error("Choose repositories with tideline sync setup before installing hooks.");
        if (config.revoked || Date.now() >= Date.parse(config.expiresAt) || config.apiOrigin !== tidelineApiOrigin()) {
          throw new Error("Renew the collector's workspace approval before installing hooks.");
        }
      } finally {
        storage.close();
      }
    }
  }

  const changes = await Promise.all(selected.map(async (agent) => {
    const path = settingsPath(agent);
    const previous = await readSettings(path);
    const result = reconcileSettings({ ...previous.value }, path, agent, scope, installation);
    return { agent, path, previous, ...result };
  }));
  for (const { agent, path, previous, value, found } of changes) {
    if (action === "status") {
      const installed = found === events[agent].length ? "installed" : found ? "partly installed" : "not installed";
      console.info(`${names[agent]}: ${installed}.`);
      continue;
    }
    if ((action === "install" || found > 0) && JSON.stringify(value) !== JSON.stringify(previous.value)) await saveSettings(path, value, previous);
    console.info(`${names[agent]}: ${action === "install" ? "hooks installed" : found ? "hooks removed" : "no Tideline hooks installed"}.`);
  }
  if (action === "install" && selected.includes("codex")) console.info("Review the Tideline hooks with /hooks in Codex before they run.");
  if (action === "install" && selected.includes("claude-code")) console.info("Restart Claude Code if your existing session has not loaded the new hooks.");
  if (action === "install" && !reportFollowUp) console.info("Hooks wake Tideline while background sync is running.");
}

const hookPayload = z.object({ session_id: z.uuid() });
const maximumHookInput = 16 * 1024;

async function readHookSessionId() {
  if (process.stdin.isTTY) return;
  const deadline = setTimeout(() => process.stdin.destroy(), 1_500).unref();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) continue;
      bytes += chunk.length;
      if (bytes <= maximumHookInput) chunks.push(chunk);
    }
    if (bytes > maximumHookInput) return;
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return hookPayload.safeParse(data).data?.session_id;
  } catch {
    return;
  } finally {
    clearTimeout(deadline);
  }
}

async function wakeReportFollowUps(agent: Agent, event: string) {
  const sessionId = await readHookSessionId();
  if (!sessionId || (event !== "Stop" && event !== "SessionEnd") || !process.argv[1]) return;
  const { hasReportFollowers } = await import("./report-follow-up");
  if (!await hasReportFollowers(agent, sessionId)) return;
  const child = spawn(process.execPath, [process.argv[1], "hooks", "__report-follow-up", agent, sessionId], {
    detached: true, stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

export async function runNativeHook(source: unknown, event: string) {
  const agent = agents.safeParse(source).data;
  if (!agent || !events[agent].some((supported) => supported === event)) return;
  const follow = wakeReportFollowUps(agent, event).catch(() => {});
  try {
    const storage = await openSyncStorage();
    try {
      const config = storage.config();
      if (!config || config.revoked || config.apiOrigin !== tidelineApiOrigin() || Date.now() >= Date.parse(config.expiresAt)) return;
      if (await createApprovedScope(config.projects).projectScope(process.cwd())) await wakeSyncCollector(storage.directory);
    } finally {
      storage.close();
    }
  } catch { /* Do not interrupt the coding agent if monitoring is unavailable. */ }
  finally {
    await follow;
    if (agent === "codex" && event === "Stop") process.stdout.write("{\"continue\":true}\n");
  }
}
