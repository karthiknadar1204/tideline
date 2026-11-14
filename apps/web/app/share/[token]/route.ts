import { createHash } from "node:crypto";
import { sessionShareToken, sessionSourceLabel, sharedSessionSnapshot } from "@tideline/contracts";
import type { SharedSessionSnapshot } from "@tideline/contracts";
import { fetchTidelineApi } from "../../../lib/workspace";

const css = `
  :root{color-scheme:light dark;--bg:#f7f8f7;--surface:#fff;--ink:#182722;--sub:#52615c;--line:#dce2df;--accent:#235d4c}
  @media(prefers-color-scheme:dark){:root{--bg:#141b19;--surface:#19221f;--ink:#e7efeb;--sub:#a9bcb4;--line:#33423c;--accent:#a3d4c1}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.6 system-ui,sans-serif}
  .container{width:min(100% - 2rem,46rem);margin:auto}
  .top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.15rem 0;border-bottom:1px solid var(--line)}
  a{color:var(--accent);text-underline-offset:.25em}
  a:focus-visible{outline:2px solid var(--accent);outline-offset:.25rem}
  .wordmark{color:inherit;font-weight:650;text-decoration:none}
  .label,.context{font-size:.875rem;color:var(--sub)}
  main{padding:2.75rem 0 4rem}
  h1{margin:.5rem 0 1rem;font-size:clamp(1.875rem,5vw,2.5rem);line-height:1.15;letter-spacing:-.033em;overflow-wrap:anywhere}
  p{margin:0}
  time{font-variant-numeric:tabular-nums}
  ol{display:grid;gap:.75rem;margin:1.75rem 0 0;padding:0;list-style:none}
  li{padding:1rem 1.25rem;border:1px solid var(--line);border-radius:.75rem;background:var(--surface)}
  .speaker{margin-bottom:.3rem;font-size:.875rem;font-weight:650}
  .message{white-space:pre-wrap;overflow-wrap:anywhere}
  @media(max-width:30rem){main{padding-top:2rem}li{padding:.875rem 1rem}}
`;

const stylesheetHash = createHash("sha256").update(css).digest("base64");
const securityHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${stylesheetHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

const date = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderSession(session: SharedSessionSnapshot) {
  const agent = sessionSourceLabel[session.source];
  const messages = session.messages.map(({ role, text }) => `
    <li>
      <p class="speaker">${role === "user" ? "User" : agent}</p>
      <p class="message">${escapeText(text)}</p>
    </li>
  `).join("");

  return `
    <p class="context">${agent} · <time datetime="${session.startedAt}">${date.format(new Date(session.startedAt))}</time></p>
    <h1>${escapeText(session.title)}</h1>
    <ol role="list" aria-label="Conversation">${messages}</ol>
  `;
}

function page(content: string, status: number) {
  return new Response(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Shared session · Tideline</title>
        <style>${css}</style>
      </head>
      <body>
        <header class="container top">
          <a class="wordmark" href="/">Tideline</a>
          <span class="label">Shared session</span>
        </header>
        <main class="container">${content}</main>
      </body>
    </html>`, { status, headers: securityHeaders });
}

export async function GET(_request: Request, { params }: RouteContext<"/share/[token]">) {
  const token = sessionShareToken.safeParse((await params).token);
  const unavailable = "<h1>Shared session unavailable</h1><p>The link may have been revoked or entered incorrectly.</p>";
  if (!token.success) return page(unavailable, 404);

  const response = await fetchTidelineApi(`/shares/${token.data}`);
  if (response?.status === 404) return page(unavailable, 404);
  const transcript = response?.ok && sharedSessionSnapshot.safeParse(await response.json().catch(() => null));
  return transcript && transcript.success
    ? page(renderSession(transcript.data), 200)
    : page("<h1>Could not open this session</h1><p>Try again in a moment.</p>", 503);
}
