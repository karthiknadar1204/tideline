import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceResponse } from "@tideline/contracts";
import { z } from "zod";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const requestTimeout = 10_000;

const discoveryResponse = z.object({
  issuer: z.url(),
  device_authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  grant_types_supported: z.array(z.string()),
});

const deviceResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().regex(/^[A-Za-z0-9-]{4,32}$/),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.int().positive(),
  interval: z.int().positive().default(5),
});

const tokenResponse = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~+/=-]+$/),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});

const oauthError = z.object({ error: z.string() });

function getOrigin(value: string | undefined, name: string, allowLoopback = false) {
  const url = value ? URL.parse(value) : null;
  const isLoopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !url || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && isLoopback && url.protocol === "http:"))
  ) {
    const protocols = allowLoopback ? "an HTTPS or local HTTP" : "an HTTPS";
    throw new Error(`Set ${name} to ${protocols} origin without a path.`);
  }

  return url.origin;
}

function secureUrl(value: string, expectedOrigin?: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (expectedOrigin && url.origin !== expectedOrigin)
  ) {
    throw new Error("Clerk returned an unexpected URL for browser approval.");
  }

  return url;
}

export async function readJson(response: Response) {
  const value: unknown = await response.json().catch(() => null);
  return value;
}

async function discoverClerk(issuer: string) {
  const response = await fetch(new URL("/.well-known/oauth-authorization-server", issuer), {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeout),
  }).catch(() => null);
  const discovery = discoveryResponse.safeParse(response?.ok ? await readJson(response) : null);

  if (!discovery.success || !discovery.data.grant_types_supported.includes(deviceGrant)) {
    throw new Error("Could not discover Clerk device authorization. Check TIDELINE_CLERK_ISSUER and the Clerk development instance.");
  }
  if (getOrigin(discovery.data.issuer, "Clerk metadata issuer") !== issuer) {
    throw new Error("Clerk returned metadata for a different issuer.");
  }

  return {
    deviceEndpoint: secureUrl(discovery.data.device_authorization_endpoint, issuer),
    tokenEndpoint: secureUrl(discovery.data.token_endpoint, issuer),
  };
}

function postOAuthForm(url: URL, body: URLSearchParams, timeout: number) {
  return fetch(url, {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  }).catch(() => null);
}

function openBrowser(url: URL) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  const browser = spawn(command, args, { detached: true, stdio: "ignore" });
  browser.once("error", () => {
    process.stderr.write("Could not open your browser. Use the approval link shown above.\n");
  });
  browser.unref();
}

async function pollForToken({ tokenEndpoint, clientId, device, expiresAt }: {
  tokenEndpoint: URL;
  clientId: string;
  device: z.infer<typeof deviceResponse>;
  expiresAt: number;
}) {
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: deviceGrant,
    device_code: device.device_code,
  });
  let interval = device.interval * 1_000;
  let retryDelay = interval;

  while (performance.now() + retryDelay < expiresAt) {
    await delay(retryDelay);
    const timeout = Math.floor(Math.min(expiresAt - performance.now(), requestTimeout));
    if (timeout <= 0) break;

    const response = await postOAuthForm(tokenEndpoint, form, timeout);
    if (!response || response.status >= 500) {
      retryDelay = Math.max(interval, Math.min(retryDelay * 2, 30_000));
      continue;
    }

    const payload = await readJson(response);
    if (response.ok) {
      const token = tokenResponse.safeParse(payload);
      if (!token.success) throw new Error("Clerk returned an invalid access token response.");
      return token.data.access_token;
    }

    const error = oauthError.safeParse(payload);
    switch (error.success ? error.data.error : null) {
      case "authorization_pending":
        retryDelay = interval;
        break;
      case "slow_down":
        interval += 5_000;
        retryDelay = interval;
        break;
      case "access_denied":
        throw new Error("Browser approval was denied.");
      case "expired_token":
        throw new Error("The approval code expired. Retry the command to get a new code.");
      default:
        throw new Error("Clerk could not complete browser approval. Check the OAuth client configuration and try again.");
    }
  }

  throw new Error("The approval code expired. Retry the command to get a new code.");
}

export function tidelineApiOrigin() {
  return getOrigin(process.env.TIDELINE_API_URL ?? "http://127.0.0.1:3001", "TIDELINE_API_URL", true);
}

export async function approveInBrowser(browser: boolean) {
  const issuer = getOrigin(process.env.TIDELINE_CLERK_ISSUER, "TIDELINE_CLERK_ISSUER");
  const clientId = process.env.TIDELINE_CLERK_OAUTH_CLIENT_ID?.trim();
  if (!clientId) throw new Error("Set TIDELINE_CLERK_OAUTH_CLIENT_ID to the public OAuth client ID.");

  const { deviceEndpoint, tokenEndpoint } = await discoverClerk(issuer);
  const response = await postOAuthForm(
    deviceEndpoint,
    new URLSearchParams({ client_id: clientId, scope: "openid" }),
    requestTimeout,
  );
  const device = deviceResponse.safeParse(response?.ok ? await readJson(response) : null);
  if (!device.success) {
    throw new Error("Could not start Clerk device authorization. Check that the public OAuth client has it enabled.");
  }

  const expiresAt = performance.now() + device.data.expires_in * 1_000;
  const verificationUrl = secureUrl(device.data.verification_uri);
  const completeUrl = device.data.verification_uri_complete
    ? secureUrl(device.data.verification_uri_complete, verificationUrl.origin)
    : verificationUrl;

  process.stdout.write(`Open ${verificationUrl.href} and enter code ${device.data.user_code}.\nWaiting for browser approval…\n`);
  if (browser) openBrowser(completeUrl);

  return pollForToken({ tokenEndpoint, clientId, device: device.data, expiresAt });
}

export function postToTideline({ apiOrigin, path, accessToken, body, signal }: {
  apiOrigin: string;
  path: string;
  accessToken: string;
  body?: string;
  signal?: AbortSignal;
}) {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");

  const timeout = AbortSignal.timeout(requestTimeout);
  return fetch(new URL(path, apiOrigin), {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => null);
}

export async function login({ browser }: { browser: boolean }) {
  const apiOrigin = tidelineApiOrigin();
  const accessToken = await approveInBrowser(browser);
  const approval = await postToTideline({ apiOrigin, path: "/v1/cli/approve", accessToken });

  if (!approval?.ok) {
    throw new Error("Clerk approved the request, but Tideline could not verify it. Check the API and its OAuth client configuration.");
  }

  const workspace = workspaceResponse.safeParse(await readJson(approval));
  if (!workspace.success) throw new Error("Tideline returned an invalid workspace response.");
  process.stdout.write(`Browser approval verified for ${workspace.data.name} (${workspace.data.id}).\n`);
}
