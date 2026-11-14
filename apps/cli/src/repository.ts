import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { SessionAnalytics } from "@tideline/contracts";

const run = promisify(execFile);

function remoteIdentity(remote: string | undefined) {
  if (!remote) return;
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(remote);
  const url = URL.parse(scp ? `ssh://${scp[1]}/${scp[2]}` : remote);
  if (!url || !["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return;
  if (/%2f|%5c/i.test(url.pathname)) return;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!path.includes("/") || /[%\\]/.test(path)) return;
  const host = url.protocol === "ssh:" && url.port === "22" ? url.hostname : url.host;
  return { key: `remote:${host.toLowerCase()}/${path}`, name: basename(path) };
}

export async function readRepository(directory: string): Promise<SessionAnalytics["repository"]> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  async function git(...args: string[]) {
    const result = await run("git", args, {
      cwd: directory, env, timeout: 1_500, maxBuffer: 16_384, windowsHide: true,
    }).catch(() => undefined);
    return result?.stdout.trim();
  }

  const rootAndCommon = await git("rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir");
  const [root, common, extra] = rootAndCommon?.split("\n") ?? [];
  if (!root || !common || extra !== undefined) return null;
  const remote = remoteIdentity(await git("config", "--local", "--no-includes", "--get", "remote.origin.url"));
  const physical = remote ? undefined : await realpath(common).catch(() => undefined);
  const identity = remote ?? (physical ? {
    key: `local:${physical}`,
    name: basename(physical) === ".git" ? basename(dirname(physical)) : basename(root),
  } : undefined);
  if (!identity) return null;
  const name = identity.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
  return { key: createHash("sha256").update(identity.key).digest("hex"), name: name || "repository" };
}
