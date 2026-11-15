import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "bun:test";
import { createSyncAutostart } from "../src/sync-autostart";

function success(stdout = "") {
  return { ok: true, stdout, stderr: "" };
}

function failure(stderr = "") {
  return { ok: false, stdout: "", stderr };
}

function uid() {
  const value = process.getuid?.();
  if (value === undefined) throw new Error("These service tests require a Unix user ID.");
  return value;
}

test("a LaunchAgent starts only the selected sync scope and can stop or remove only its own service", async () => {
  const home = await mkdtemp(join(tmpdir(), "tideline-autostart-mac-"));
  try {
    const scope = join(home, ".test & <sync>");
    const launcher = join(home, "custom prefix", "bin", "tideline");
    const node = join(home, "node versions", "bin", "node");
    const label = `com.tideline.sync.${createHash("sha256").update(scope).digest("hex").slice(0, 24)}`;
    const file = join(home, "Library", "LaunchAgents", `${label}.plist`);
    const other = join(home, "Library", "LaunchAgents", "some-other-app.plist");
    let loaded = false;
    let running = false;
    let externalDisable = false;
    let bootstraps = 0;
    let foreign = false;
    const service = createSyncAutostart({ platform: "darwin", home, scope, uid: uid() }, async (program, arguments_) => {
      expect(program).toBe("/bin/launchctl");
      const [action, name, path] = arguments_;
      if (action === "print-disabled") return success(externalDisable ? `\t"${label}" => disabled\n` : "");
      if (action === "print") {
        return loaded ? success(`\tpath = ${foreign ? other : file}\n\tstate = ${running ? "running" : "exited"}\n`) :
          failure(`Could not find service "${label}" in domain for user gui: ${uid()}`);
      }
      if (action === "enable") externalDisable = false;
      else if (action === "bootstrap") {
        expect(path).toBe(file);
        expect(name).toBe(`gui/${uid()}`);
        loaded = running = true;
        bootstraps++;
      } else if (action === "bootout") loaded = running = false;
      else if (action === "kickstart") running = true;
      else throw new Error(`Unexpected manager request: ${arguments_.join(" ")}`);
      return success();
    });
    expect(await service.status()).toBeUndefined();
    await service.enable(launcher, node);
    if (process.platform === "darwin") execFileSync("/usr/bin/plutil", ["-lint", "--", file]);
    const plist = await readFile(file, "utf8");
    expect(plist).toContain(`<string>${launcher}</string><string>sync</string><string>run</string><string>--autostart</string>`);
    expect(plist).toContain("<key>TIDELINE_SYNC_HOME</key>");
    expect(plist).toContain(".test &amp; &lt;sync&gt;");
    expect(plist).toContain(`${join(home, "node versions", "bin")}:/usr/bin:/bin`);
    expect(plist).not.toContain("TOKEN");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await service.status()).toEqual({ loaded: true, running: true, enabled: true });
    await service.enable(launcher, node);
    expect(bootstraps).toBe(1);
    await expect(service.enable(launcher, "/other/node")).rejects.toThrow("Node location changed");
    expect(await service.stop()).toBe(true);
    expect(await service.status()).toEqual({ loaded: false, running: false, enabled: true });
    expect(await service.start()).toBe(true);
    expect(bootstraps).toBe(2);
    await writeFile(other, "unrelated", { mode: 0o600 });
    foreign = true;
    await expect(service.disable()).rejects.toThrow("another launchd service");
    expect(await readFile(file, "utf8")).toBe(plist);
    foreign = false;
    externalDisable = true;
    expect((await service.status())?.enabled).toBe(false);
    await service.enable(launcher, node);
    expect((await service.status())?.enabled).toBe(true);
    expect(await service.disable()).toBe(true);
    expect(await service.disable()).toBe(false);
    expect(await service.status()).toBeUndefined();
    expect(await readFile(other, "utf8")).toBe("unrelated");
    await writeFile(file, "custom manually installed service", { mode: 0o600 });
    await expect(service.enable(launcher, node)).rejects.toThrow("another service");
    expect(await readFile(file, "utf8")).toBe("custom manually installed service");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the Linux user unit is scoped, escapes paths, and can recover from an interrupted enable", async () => {
  const home = await mkdtemp(join(tmpdir(), "tideline-autostart-linux-"));
  try {
    const linuxConfigHome = join(home, "custom config");
    const scope = join(home, "test % scope");
    const launcher = join(home, 'arg "with" $literal %i', "bin", "tideline");
    const label = `tideline-sync-${createHash("sha256").update(scope).digest("hex").slice(0, 24)}.service`;
    const file = join(linuxConfigHome, "systemd", "user", label);
    let enabled = false;
    let running = false;
    let interrupted = true;
    const service = createSyncAutostart({ platform: "linux", home, linuxConfigHome, scope, uid: uid() }, async (program, arguments_) => {
      expect(program).toBe("/usr/bin/systemctl");
      const [user, action, option, unit] = arguments_;
      expect(user).toBe("--user");
      if (action === "show") {
        expect(unit).toBe(label);
        return success(`FragmentPath=${enabled ? file : ""}\nActiveState=${running ? "active" : "inactive"}\nUnitFileState=${enabled ? "enabled" : ""}\n`);
      }
      if (action === "enable") {
        expect(option).toBe("--now");
        expect(unit).toBe(file);
        if (interrupted) return failure("Interrupted");
        enabled = running = true;
      } else if (action === "stop") running = false;
      else if (action === "start") running = true;
      else if (action === "disable") enabled = running = false;
      else expect(action).toBe("daemon-reload");
      return success();
    });
    await expect(service.enable(launcher, "/usr/local/bin/node")).rejects.toThrow("Could not enable");
    expect(await service.status()).toEqual({ loaded: false, running: false, enabled: false });
    const content = await readFile(file, "utf8");
    expect(content).toContain('arg \\"with\\" $literal %%i');
    expect(content).toContain("ExecStart=:/bin/sh \"");
    expect(content).toContain('test %% scope"');
    expect(content).toContain("WantedBy=default.target");
    expect(content).not.toContain(basename(linuxConfigHome));
    interrupted = false;
    await service.enable(launcher, "/usr/local/bin/node");
    expect(await service.status()).toEqual({ loaded: true, running: true, enabled: true });
    await service.stop();
    expect(await service.status()).toEqual({ loaded: true, running: false, enabled: true });
    await service.start();
    expect((await service.status())?.running).toBe(true);
    expect(await service.disable()).toBe(true);
    expect(await service.status()).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
