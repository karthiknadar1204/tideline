import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { cliRelease } from "@tideline/contracts";
import cliPackage from "../package.json";
import { tidelineWebOrigin } from "./login";

function hash(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

export async function installedCli() {
  const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
  if (!entry || !/^[a-f0-9]{64}\.mjs$/u.test(basename(entry))) return;
  const directory = dirname(entry);
  if (basename(directory) !== "tideline" || basename(dirname(directory)) !== "share") return;
  const prefix = dirname(dirname(directory));
  const launcher = join(prefix, "bin", "tideline");
  const stat = await lstat(launcher).catch(() => null);
  if (!stat?.isFile() || stat.size > 16_384 ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) return;
  const script = await readFile(launcher, "utf8");
  const currentExec = `exec node "\$bin_dir/../share/tideline/${basename(entry)}" "\$@"\n`;
  if (!script.startsWith("#!/bin/sh\nexport TIDELINE_WEB_URL=") || !script.endsWith(currentExec)) return;
  return { directory, launcher, script, currentExec, digest: basename(entry, ".mjs") };
}

async function readCliRelease(origin: string, timeout = 10_000) {
  const response = await fetch(new URL("/cli/release", origin), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  const release = cliRelease.safeParse(response.ok ? await response.json().catch(() => null) : null);
  if (!release.success) throw new Error("Could not read the Tideline release.");
  return release.data;
}

async function fetchReleaseFile(origin: string, size: number, digest: string) {
  const response = await fetch(new URL("/cli/tideline.mjs", origin), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || !response.body) throw new Error("Could not download the Tideline release.");
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > size) {
        await reader.cancel();
        throw new Error("The Tideline release size changed. Check for an update again.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bundle = Buffer.concat(chunks);
  if (downloaded !== size || hash(bundle) !== digest) {
    throw new Error("The download differs from the reviewed release. Check for an update again.");
  }
  return bundle;
}

export async function updateCli({ check, yes }: { check?: boolean; yes?: boolean }) {
  const origin = tidelineWebOrigin();
  const release = await readCliRelease(origin);
  const installation = await installedCli();
  if (installation?.digest === release.sha256) {
    console.log(`Tideline ${release.version} is up to date.`);
    return;
  }
  console.log(`Current CLI: ${cliPackage.version}. Available release: ${release.version} (${release.sha256.slice(0, 12)}).`);
  if (check) return;
  if (!installation) throw new Error(`Install this release using ${new URL("/docs/get-started", origin)}.`);
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run tideline update in a terminal or pass --yes.");
    const approved = await confirm({ message: `Install Tideline ${release.version}?`, initialValue: false });
    if (isCancel(approved) || !approved) return;
  }
  await installRelease(origin, installation, release);
}

export async function offerInteractiveUpdate() {
  const installation = await installedCli().catch(() => null);
  if (!installation) return;
  const origin = tidelineWebOrigin();
  const release = await readCliRelease(origin, 1_500).catch(() => null);
  if (!release || installation.digest === release.sha256) return;
  const approved = await confirm({ message: `Install Tideline ${release.version} (${release.sha256.slice(0, 12)})?`, initialValue: false });
  if (isCancel(approved) || !approved) return;
  await installRelease(origin, installation, release).catch((error: unknown) => {
    console.warn(error instanceof Error ? error.message : "Tideline could not update. Run tideline update to try again.");
  });
}

async function installRelease(origin: string, installation: NonNullable<Awaited<ReturnType<typeof installedCli>>>,
  { version, size, sha256 }: Awaited<ReturnType<typeof readCliRelease>>) {
  const bundle = await fetchReleaseFile(origin, size, sha256);
  const bin = dirname(installation.launcher);
  const staging = await mkdtemp(join(bin, ".tideline-update-"));
  try {
    const runtime = join(staging, "tideline.mjs");
    const launcher = join(staging, "tideline");
    const nextExec = `exec node "\$bin_dir/../share/tideline/${sha256}.mjs" "\$@"\n`;
    await writeFile(runtime, bundle, { mode: 0o600, flag: "wx" });
    await writeFile(launcher, installation.script.slice(0, -installation.currentExec.length) + nextExec, { mode: 0o700, flag: "wx" });
    if (await readFile(installation.launcher, "utf8") !== installation.script) {
      throw new Error("The Tideline launcher changed during this update. Check again.");
    }
    await rename(runtime, join(installation.directory, `${sha256}.mjs`));
    await rename(launcher, installation.launcher);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Installed Tideline ${version}. To refresh an active collector, run tideline sync stop then tideline sync start.`);
}
