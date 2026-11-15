import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { installedCli } from "./cli-update";
import { tidelineApiOrigin } from "./login";
import { openPrivateDatabase, openSyncStorage, syncDirectoryPath, SyncSetupMissingError } from "./sync-storage";

const execute = promisify(execFile);
const marker = "Managed by Tideline session sync";
type ManagerResult = { ok: boolean; stdout: string; stderr: string };
type RunManager = (program: string, arguments_: string[]) => Promise<ManagerResult>;

type ServiceLocation = { platform: "darwin" | "linux"; home: string; linuxConfigHome?: string; scope: string; uid: number };
type ServiceState = { loaded: boolean; running: boolean; enabled: boolean };

async function runManager(program: string, arguments_: string[]): Promise<ManagerResult> {
  try {
    const { stdout, stderr } = await execute(program, arguments_, {
      timeout: 12_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" },
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error instanceof Error && "stdout" in error ? String(error.stdout) : "",
      stderr: error instanceof Error && "stderr" in error ? String(error.stderr) : "",
    };
  }
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemd(value: string) {
  return JSON.stringify(value.replaceAll("%", "%%"));
}

function absent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safePath(path: string) {
  return isAbsolute(path) && !/[\x00-\x1f\x7f]/u.test(path);
}

export function createSyncAutostart({ platform, home, linuxConfigHome, scope, uid }: ServiceLocation,
  run: RunManager = runManager) {
  const mac = platform === "darwin";
  const scopeId = createHash("sha256").update(scope).digest("hex").slice(0, 24);
  const label = mac ? `com.tideline.sync.${scopeId}` : `tideline-sync-${scopeId}.service`;
  const directory = mac ? join(home, "Library", "LaunchAgents") :
    join(linuxConfigHome && isAbsolute(linuxConfigHome) ? linuxConfigHome : join(home, ".config"), "systemd", "user");
  const file = join(directory, mac ? `${label}.plist` : label);
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const signature = mac ? `<!-- ${marker}: ${scopeId} -->` : `# ${marker}: ${scopeId}`;
  const manager = mac ? "launchd" : "the systemd user manager";
  const launch = (args: string[]) => run("/bin/launchctl", args);
  const control = (args: string[]) => run("/usr/bin/systemctl", ["--user", ...args]);

  function registration(launcher: string, node: string) {
    if (![file, launcher, node, scope].every(safePath) || dirname(node).includes(":")) {
      throw new Error("Automatic sync needs absolute paths without control characters and a Node directory without colons.");
    }
    const path = [dirname(node), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
    if (mac) return `<?xml version="1.0" encoding="UTF-8"?>
${signature}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>sync</string><string>run</string><string>--autostart</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>TIDELINE_SYNC_HOME</key><string>${xml(scope)}</string>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`;
    return `${signature}
[Unit]
Description=Tideline session sync

[Service]
ExecStart=:/bin/sh ${systemd(launcher)} sync run --autostart
Environment=${systemd(`TIDELINE_SYNC_HOME=${scope}`)} ${systemd(`PATH=${path}`)}
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=default.target
`;
  }

  async function ownedFile() {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
      if (absent(error)) return;
      throw new Error(`Cannot read the automatic sync registration at ${file}.`);
    });
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 16_384) {
        throw new Error(`Refusing to change an unowned automatic sync registration at ${file}.`);
      }
      const content = await handle.readFile("utf8");
      if (!content.split("\n", 3).includes(signature)) throw new Error(`Refusing to change another service at ${file}.`);
      return { content, stat };
    } finally {
      await handle.close();
    }
  }

  async function withControlLock<T>(change: () => Promise<T>) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error(`Automatic sync needs a service directory owned and writable only by you at ${directory}.`);
    }
    const lock = await openPrivateDatabase(directory, `.tideline-${scopeId}-control.sqlite`, true);
    try {
      lock.exec("PRAGMA busy_timeout = 1000");
      try {
        lock.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (error instanceof Error && "errcode" in error && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff)) {
          throw new Error("Another command is changing automatic sync. Try again in a moment.");
        }
        throw error;
      }
      return await change();
    } finally {
      lock.close();
    }
  }

  async function install(content: string) {
    const previous = await ownedFile();
    if (previous) {
      if (previous.content !== content) throw new Error("The installed launcher or Node location changed. Disable automatic sync and enable it again.");
      return;
    }
    const temporary = await mkdtemp(join(directory, ".tideline-autostart-"));
    try {
      const staged = join(temporary, "registration");
      await writeFile(staged, content, { flag: "wx", mode: 0o600 });
      await link(staged, file);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function query(): Promise<ServiceState> {
    if (mac) {
      const disabled = await launch(["print-disabled", domain]);
      if (!disabled.ok) throw new Error("Could not reach launchd in this user's login session.");
      const enabled = !disabled.stdout.split("\n").some((line) => line.trim() === `"${label}" => disabled`);
      const response = await launch(["print", target]);
      if (!response.ok) {
        if (response.stderr.includes(`Could not find service "${label}"`)) {
          return { loaded: false, running: false, enabled };
        }
        throw new Error("Could not reach launchd in this user's login session.");
      }
      if (response.stdout.match(/^\s*path = (.+)$/mu)?.[1] !== file) {
        throw new Error(`Refusing to manage another launchd service named ${label}.`);
      }
      return { loaded: true, running: /^\s*state = running\s*$/mu.test(response.stdout), enabled };
    }
    const response = await control(["show", "--property=FragmentPath,LoadState,ActiveState,UnitFileState", label]);
    if (!response.ok && !/^LoadState=not-found$/mu.test(response.stdout)) {
      throw new Error("Could not reach the systemd user manager. Automatic sync on Linux needs a systemd login session.");
    }
    const path = response.stdout.match(/^FragmentPath=(.*)$/mu)?.[1];
    if (path && path !== file) throw new Error(`Refusing to manage another systemd service named ${label}.`);
    return {
      loaded: path === file,
      running: /^ActiveState=active$/mu.test(response.stdout),
      enabled: /^UnitFileState=enabled$/mu.test(response.stdout),
    };
  }

  async function requireCommand(result: Promise<ManagerResult>, action: string) {
    if (!(await result).ok) throw new Error(`Could not ${action} automatic sync with ${manager}. Run tideline sync autostart status.`);
  }

  return {
    async status() {
      return await ownedFile() ? query() : undefined;
    },
    async enable(launcher: string, node: string) {
      const content = registration(launcher, node);
      await withControlLock(async () => {
        const current = await query();
        await install(content);
        if (mac) {
          if (!current.enabled) await requireCommand(launch(["enable", target]), "enable");
          if (!current.loaded) await requireCommand(launch(["bootstrap", domain, file]), "start");
          else if (!current.running) await requireCommand(launch(["kickstart", target]), "start");
        } else {
          await requireCommand(control(["enable", "--now", file]), "enable");
        }
      });
    },
    async start() {
      if (!await ownedFile()) return false;
      return withControlLock(async () => {
        if (!await ownedFile()) return false;
        const current = await query();
        if (!current.running) {
          if (mac) await requireCommand(launch(current.loaded ? ["kickstart", target] : ["bootstrap", domain, file]), "start");
          else await requireCommand(control(["start", label]), "start");
        }
        return true;
      });
    },
    async stop() {
      if (!await ownedFile()) return false;
      return withControlLock(async () => {
        if (!await ownedFile()) return false;
        const current = await query();
        if (mac && current.loaded) await requireCommand(launch(["bootout", target]), "stop");
        if (!mac && current.loaded) await requireCommand(control(["stop", label]), "stop");
        return true;
      });
    },
    async disable() {
      if (!await ownedFile()) return false;
      return withControlLock(async () => {
        const registration = await ownedFile();
        if (!registration) return false;
        const current = await query();
        if (mac && current.loaded) await requireCommand(launch(["bootout", target]), "stop");
        if (!mac) await requireCommand(control(["disable", "--now", label]), "disable");
        const latest = await ownedFile();
        if (latest?.stat.ino !== registration.stat.ino || latest.stat.dev !== registration.stat.dev) {
          throw new Error("Automatic sync registration changed. Run tideline sync autostart status.");
        }
        await unlink(file);
        if (!mac) await requireCommand(control(["daemon-reload"]), "reload");
        return true;
      });
    },
  };
}

export function syncAutostart() {
  const platform = process.platform;
  const uid = process.getuid?.();
  if ((platform !== "darwin" && platform !== "linux") || uid === undefined) return;
  return createSyncAutostart({ platform, uid, home: homedir(), linuxConfigHome: process.env.XDG_CONFIG_HOME, scope: syncDirectoryPath() });
}

export async function configureSyncAutostart(action: "enable" | "disable" | "status") {
  const service = syncAutostart();
  if (!service) throw new Error("Automatic sync at login is available on macOS or Linux with systemd.");
  if (action === "status") {
    const state = await service.status();
    const login = state?.enabled ? "enabled" : state ? "registered, but not enabled" : "disabled";
    console.info(`Automatic sync at login: ${login}. Collector: ${state?.running ? "running" : "stopped"}.`);
    return;
  }
  if (action === "disable") {
    await service.disable();
    console.info("Automatic sync at login is disabled.");
    return;
  }
  const installation = await installedCli();
  if (!installation) throw new Error("Install Tideline using your dashboard's setup command to enable sync at login.");
  const storage = await openSyncStorage();
  try {
    const config = storage.config();
    if (!config) throw new SyncSetupMissingError("Set up Tideline sync first with tideline sync setup.");
    if (!config.projects.length) throw new Error("Choose repositories with tideline enable before turning on sync at login.");
    if (config.apiOrigin !== tidelineApiOrigin()) throw new Error("TIDELINE_API_URL differs from the approved sync destination.");
    if (config.revoked || Date.now() >= Date.parse(config.expiresAt)) {
      throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
    }
  } finally {
    storage.close();
  }
  await service.enable(installation.launcher, process.execPath);
  const { stopBackgroundSync } = await import("./sync-background");
  await stopBackgroundSync({ quiet: true, includeAutostart: false });
  console.info("Automatic sync at login is enabled. Run tideline sync autostart status to check it.");
}
