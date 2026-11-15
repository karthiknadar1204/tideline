import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cliRelease } from "@tideline/contracts";
import cliPackage from "../../../../cli/package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  const bundle = await readFile(join(process.cwd(), "public", "cli", "tideline.mjs")).catch(() => null);
  if (!bundle?.length) return Response.json({ error: "Tideline CLI release is unavailable." }, { status: 503 });
  const release = cliRelease.parse({
    version: cliPackage.version,
    sha256: createHash("sha256").update(bundle).digest("hex"),
    size: bundle.length,
  });
  return Response.json(release, { headers: { "Cache-Control": "no-store" } });
}
