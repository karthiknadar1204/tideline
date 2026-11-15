import { cliInstallConfig } from "@tideline/contracts";
import { fetchTidelineApi } from "./workspace";

function releaseOrigin(value: string) {
  const url = URL.parse(value);
  const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !url || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error("Set the Tideline URL to an HTTPS origin or a local HTTP origin.");
  }
  return url.origin;
}

function webOrigin() {
  return releaseOrigin(process.env.TIDELINE_WEB_ORIGIN ?? "http://localhost:3000");
}

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function cliInstallCommand(workspaceId?: string) {
  const url = new URL("/install.sh", webOrigin());
  const command = `curl -fsSL ${shellQuote(url.href)} | sh`;
  return workspaceId ? `${command} -s -- --workspace ${shellQuote(workspaceId)}` : command;
}

export function cliPairedInstallCommand(code: string) {
  return `${cliInstallCommand()} -s -- --code ${shellQuote(code)}`;
}

export async function cliInstaller() {
  const response = await fetchTidelineApi("/cli/install-config");
  const config = cliInstallConfig.safeParse(response?.ok ? await response.json().catch(() => undefined) : undefined);
  if (!config.success) return;

  const web = webOrigin();
  const api = releaseOrigin(process.env.TIDELINE_PUBLIC_API_URL || process.env.TIDELINE_API_URL || "http://127.0.0.1:3001");
  const settings = [
    ["TIDELINE_WEB_URL", web],
    ["TIDELINE_API_URL", api],
    ["TIDELINE_CLERK_ISSUER", releaseOrigin(config.data.clerkIssuer)],
    ["TIDELINE_CLERK_OAUTH_CLIENT_ID", config.data.oauthClientId],
  ].map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");

  return `#!/bin/sh
install_tideline() {
  set -eu
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) printf '%s\\n' 'Tideline sync runs on macOS and Linux.' >&2; return 1 ;;
  esac
  if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 || (major === 22 && minor >= 13) ? 0 : 1)'; then
    printf '%s\\n' 'Install Node.js 24 or Node.js 22.13+ and run this command again.' >&2
    return 1
  fi
  if [ ! -t 1 ] || ! ( : </dev/tty ) 2>/dev/null; then
    printf '%s\\n' 'Run this command in an interactive terminal to choose repositories.' >&2
    return 1
  fi

  umask 077
  prefix="\${TIDELINE_INSTALL_PREFIX:-"$HOME/.local"}"
  case "$prefix" in
    /*) ;;
    *) printf '%s\\n' 'Use an absolute path for TIDELINE_INSTALL_PREFIX.' >&2; return 1 ;;
  esac
  runtime="$prefix/share/tideline"
  bin="$prefix/bin"
  mkdir -p "$runtime" "$bin"
  stage=$(mktemp -d "$runtime/.install.XXXXXXXX")
  launcher=""
  trap 'rm -rf "$stage"; if [ -n "$launcher" ]; then rm -f "$launcher"; fi' 0

  printf '%s\\n' 'Downloading the Tideline CLI…'
  curl -fsSL ${shellQuote(new URL("/cli/tideline.mjs", web).href)} -o "$stage/tideline.mjs"
  digest=$(node -e 'const {createHash}=require("node:crypto"); const {readFileSync}=require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$stage/tideline.mjs")
  mv -f "$stage/tideline.mjs" "$runtime/$digest.mjs"
  launcher=$(mktemp "$bin/.tideline.XXXXXXXX")
  {
    cat <<'TIDELINE_SETTINGS'
#!/bin/sh
${settings}
TIDELINE_SETTINGS
    cat <<'TIDELINE_LOCATION'
bin_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
TIDELINE_LOCATION
    printf 'exec node "$bin_dir/../share/tideline/%s.mjs" "$@"\\n' "$digest"
  } > "$launcher"
  chmod 700 "$launcher"
  mv -f "$launcher" "$bin/tideline"
  rm -rf "$stage"
  trap - 0

  if ! command -v tideline >/dev/null 2>&1; then
    printf 'Tideline CLI installed at %s\\n' "$bin/tideline"
  fi
  exec "$bin/tideline" onboard "$@" </dev/tty
}
install_tideline "$@"
`;
}
