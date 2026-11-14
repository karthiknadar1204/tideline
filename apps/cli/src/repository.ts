import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { SessionAnalytics } from "@tideline/contracts";

const run = promisify(execFile);

function parseRemote(remote: string | undefined) {
  if (!remote) return;
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(remote);
  const url = URL.parse(scp ? `ssh://${scp[1]}/${scp[2]}` : remote);
  if (!url || !["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return;
  if (/%2f|%5c/i.test(url.pathname)) return;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!path.includes("/") || /[%\\]/.test(path)) return;
  const host = url.protocol === "ssh:" && url.port === "22" ? url.hostname : url.host;
  return { host: host.toLowerCase(), path };
}

export function createRepositoryGit(directory: string) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  return async (...args: string[]) => {
    const result = await run("git", args, {
      cwd: directory, env, timeout: 1_500, maxBuffer: 16_384, windowsHide: true,
    }).catch(() => undefined);
    return result?.stdout.trim();
  };
}

export async function readOrigin(git: ReturnType<typeof createRepositoryGit>) {
  return parseRemote(await git("config", "--local", "--no-includes", "--get", "remote.origin.url"));
}

async function readGitDirectories(git: ReturnType<typeof createRepositoryGit>) {
  const rootAndCommon = await git("rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir");
  const [root, common, extra] = rootAndCommon?.split("\n") ?? [];
  if (!root || !common || extra !== undefined) return null;
  return { root, common };
}

export async function readCheckout(directory: string) {
  const directories = await readGitDirectories(createRepositoryGit(directory));
  if (!directories) return null;
  const [root, common] = await Promise.all([
    realpath(directories.root).catch(() => undefined), realpath(directories.common).catch(() => undefined),
  ]);
  if (!root || !common) return null;
  return { root, common, name: basename(common) === ".git" ? basename(dirname(common)) : basename(root) };
}

export async function readRepository(directory: string): Promise<SessionAnalytics["repository"]> {
  const git = createRepositoryGit(directory);
  const directories = await readGitDirectories(git);
  if (!directories) return null;
  const { root, common } = directories;
  const remote = await readOrigin(git);
  const physical = remote ? undefined : await realpath(common).catch(() => undefined);
  const identity = remote ? { key: `remote:${remote.host}/${remote.path}`, name: basename(remote.path) } : physical ? {
    key: `local:${physical}`,
    name: basename(physical) === ".git" ? basename(dirname(physical)) : basename(root),
  } : undefined;
  if (!identity) return null;
  const name = identity.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
  return { key: createHash("sha256").update(identity.key).digest("hex"), name: name || "repository" };
}
