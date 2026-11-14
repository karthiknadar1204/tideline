# Tideline

Tideline is a CLI and web app for understanding what your coding agents did.

Use Bun 1.4.4, Node.js 22.12 or later within Node 22, or Node 24, and a Neon PostgreSQL database. Run the commands from the repository root.

## Run locally

1. Copy each `.env.example` to `.env.local` in `apps/web`, `apps/api`, `apps/cli`, and `apps/worker`. Keep existing local configuration if you already have it.
2. Add your Clerk development publishable and secret keys to the web and API files. Set `NEON_DB_URL` to the same Neon connection string in the API and worker files.
3. Create a public OAuth application in the same Clerk development instance. Enable device authorization and the `openid` scope. Set the OAuth client ID in the API and CLI files. Set `TIDELINE_CLERK_ISSUER` in the CLI file to the HTTPS origin of your Clerk Frontend API. [Clerk device authorization guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant)
4. Install dependencies, apply the database migration, and start the apps.

```sh
bun install
bun run --filter @tideline/api db:migrate
bun run dev
```

Open [Tideline](http://localhost:3000) and sign in. **Open workspace** creates or opens your personal workspace. The Hono API listens at [127.0.0.1:3001/health](http://127.0.0.1:3001/health). Change `TIDELINE_WEB_ORIGIN` in the API config if you use a different origin for the web app.

## Approve the CLI in your browser

```sh
bun --cwd apps/cli ./src/index.ts login
```

Sign in with the same Clerk account and approve the request. The terminal prints the name and ID of your workspace. Add `--no-browser` to open the approval link yourself. The command verifies approval for this run and discards the OAuth token.

## Import a sanitized session

Open your personal workspace and copy its ID from `/workspace/<id>`. Use the included synthetic fixture for a first import. For any other file, review the conversation text and remove private data before confirming with `--sanitized`.

From the repository root, set `workspace_id` to the copied ID and run a preview.

```sh
export workspace_id=YOUR_WORKSPACE_ID
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts import \
  packages/test-fixtures/codex/sanitized-session.jsonl --workspace "$workspace_id" --dry-run
```

To send the file, replace `--dry-run` with `--sanitized` and approve in Clerk with the workspace owner's account. Refresh the workspace after the worker processes the import. Open **Add a test for empty input** under **Sessions** to read the conversation.

The importer accepts a single Codex or Claude Code JSONL file up to 1 MiB. It sends user and assistant text with source line numbers and any reported model and token data. PostgreSQL stores the import and its processing result. Sending the same file again returns its existing receipt.

## Sync new Codex and Claude Code sessions

From the repository root, choose the absolute path of a project and the ID of your private workspace. Use `--conversations` to approve syncing new sessions in that project. The collector sends user and assistant text, repository and model information, token counts, activity metadata, verified commit references, and safety findings when available. It redacts common credential patterns in messages. Raw tool arguments and results, skill instructions, child agent transcripts, local repository paths, and attachments stay on your machine. Conversation text can still contain sensitive information.

```sh
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts sync setup \
  --workspace "$workspace_id" --project /absolute/path/to/project --conversations
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts sync run
```

Approve the setup in Clerk, then leave `sync run` running. Tideline polls the local session files about every two seconds. The open workspace refreshes its session list every five seconds. Sync starts with sessions created after setup. The local queue catches up after reconnecting or restarting. Sync reads files up to 1 MiB and 500 messages per session. Use `sync status` to see queued, received, and failed uploads. Stop the collector with Ctrl+C. Run `sync revoke` with the collector stopped to revoke its upload access.

The CLI reads Codex sessions under `${CODEX_HOME:-~/.codex}/sessions` and Claude Code sessions under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`. It stores the local queue under `~/.tideline` by default. A sync credential is tied to one workspace and expires after 30 days. Sync runs on macOS and Linux using Bun or Node.js 22.13 or later. On macOS, the CLI uses Keychain by default. On Linux, pass `--credential-file` to store the credential in an owner-only file. The same option is available on macOS.

To preview a manual Claude Code import, pass `--source claude-code` to the import command. If Bun is unavailable on your PATH, replace `bun` in the commands above with `npx --yes --package=bun@1.4.4 -- bun`.

## Read the usage summaries

Open your private workspace to see reported tokens and estimated cost across sessions, repositories, and models. Open a session to see its own breakdown. Token totals include reported input, cache reads and writes, and output. Cost estimates apply standard API token rates in USD. Subscription charges, discounts, and special rates can differ. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

**Partial** shows the subtotal Tideline can count or price. **Unavailable** means the session lacks the data needed for that number. A session counts once in the workspace totals and once on each model row that it used. Older sessions may have only conversation text.

## Read session activity

Open a session to see tool calls, reported skill use, and child agent runs. **Returned** means a tool produced a result. A child run can stay **Running** after its launch tool returns. Tideline uses the parent session log and shows the latest status it can confirm. Each session includes up to 250 entries per activity category. Workspace totals show activity from sessions that have synced it.

## Review commits and safety findings

Open a synced session to see commits reported by a `git commit` tool result and verified against the local repository. Tideline builds commit links for GitHub and GitLab origins. Other repositories show the verified SHA. A link can become reachable when you push the commit to the origin.

The collector looks for specific risky shell commands and possible credentials. The dashboard shows the rule and log line. Findings are advisory. Older sessions show unavailable until the collector sends a review.

| Workspace | Current entry point |
| --- | --- |
| `apps/web` | Clerk sign-in, private workspaces, and a session reader |
| `apps/api` | Clerk verification, workspace access, and session import |
| `apps/cli` | Browser approval, manual import, and automatic sync |
| `apps/worker` | Processes pending imports |
| `packages/contracts` | Shared API request and response schemas |
| `packages/db` | PostgreSQL workspace records and migrations |

```sh
bun run check-types
bun run build
bun run cli --help
node apps/cli/dist/index.js --help
bun run --filter @tideline/worker start
```
