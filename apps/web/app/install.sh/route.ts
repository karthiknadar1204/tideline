import { cliInstaller } from "../../lib/cli-install";

export async function GET() {
  const script = await cliInstaller();
  if (!script) return new Response("Tideline CLI installation is unavailable. Try again later.\n", { status: 503 });

  return new Response(script, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
