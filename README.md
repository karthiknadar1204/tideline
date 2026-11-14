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

Open [Tideline](http://localhost:3000) and sign in to open your personal workspace. Use **Open workspace** on the landing page to see all your workspaces. The Hono API listens at [127.0.0.1:3001/health](http://127.0.0.1:3001/health). Change `TIDELINE_WEB_ORIGIN` in the API config if you use a different origin for the web app.

## Sync your first session

Build the CLI, then copy the command under **Sync your first session** in your workspace. To start in the terminal with your personal or selected workspace, run these from the checkout.

```sh
bun run --filter @tideline/cli build
node --env-file=apps/cli/.env.local apps/cli/dist/index.js onboard
```

Choose the repositories you want to sync. Choose whether to include older sessions and whether to run in the background, then review the list and approve in your browser. If you leave background sync off, rerun the command with `sync run` in place of `onboard`. If you skip older sessions, start a new coding session in a selected repository. Open the dashboard link printed by the CLI to see it after processing. If you run Tideline at another web origin, set `TIDELINE_WEB_URL` in the CLI environment.

## Sign in and check your workspace

```sh
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts login
```

Sign in with the same Clerk account and approve the request. Tideline saves a 30-day CLI credential in your private local storage. Add `--no-browser` to open the approval link yourself. Run `whoami` to see your account and upload failures. Use `workspace list`, `workspace show`, and `workspace use <id>` to inspect and select a personal or team workspace. `set-org <id>` also selects a workspace.

Run `doctor` to check API connectivity, browser approval, local agent storage, background sync, and upload authorization. Add `--json` to `doctor`, `whoami`, or the workspace list and show commands for scripts. Run `logout` to revoke the CLI credential and any local collector for the same workspace. Pulled files remain on your machine.

## Import a sanitized session

Sign in with `login` to use your selected workspace, or copy the ID from `/workspace/<id>` and pass `--workspace`. Use the included synthetic fixture for a first import. For any other file, review the conversation text and remove private data before confirming with `--sanitized`.

From the repository root, set `workspace_id` to the copied ID and run a preview.

```sh
export workspace_id=YOUR_WORKSPACE_ID
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts import \
  packages/test-fixtures/codex/sanitized-session.jsonl --workspace "$workspace_id" --dry-run
```

To send the file, replace `--dry-run` with `--sanitized` and approve in Clerk with the workspace owner's account. Refresh the workspace after the worker processes the import. Open **Add a test for empty input** under **Sessions** to read the conversation.

The importer accepts a single Codex or Claude Code JSONL file up to 1 MiB. It sends user and assistant text with source line numbers and any reported model and token data. PostgreSQL stores the import and its processing result. Sending the same file again returns its existing receipt.

## Choose repositories and sync

Run setup from the Tideline checkout. The picker finds repositories and folders in local agent history. Type to search and use the arrow keys and Tab to select. Each entry shows how many saved sessions Tideline found. Related Git worktrees are grouped, and the review lists the exact folders you are approving.

```sh
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts sync setup
```

Choose whether to include older sessions and whether to sync in the background. Approve in Clerk to use your private workspace, or pass `--workspace` with its ID. On Linux, add `--credential-file`. Run setup again to change the selection. Existing history approvals carry forward for retained folders. Removing a folder stops future uploads from it. Its imported sessions stay in the dashboard.

You can also open the picker with `upload`, `connect`, `enable`, or `disable`. To pause every repository, clear the selection and confirm. Use `sync retry` or `upload --retry` to resend queued uploads and recover failed ones from approved local sessions. An active collector picks up the request. When sync is stopped, the command attempts the retry directly. Use `sync status` to see what still needs attention.

To select paths without the picker, pass `--project /path/to/first /path/to/second --conversations`. Add `--history` to import older sessions and `--background` to start sync immediately. Use `sync start` and `sync stop` to control the background collector. It stays running after the terminal closes. Run `sync start` again after a reboot or if the process exits. Use `sync run` to watch in the current terminal, `sync status` to check upload counts, or `sync revoke` to end this collector’s authorization.

Tideline checks local session files and databases about every two seconds. The dashboard refreshes its recent sessions every five seconds and shows each session’s original date. The local queue catches up after reconnecting or restarting. Each upload is limited to 1 MiB and 500 messages. Discovery counts can include sessions that exceed these limits or lack enough data to import. The collector sends conversation text and available metadata. Raw tool inputs and outputs, skill instructions, child agent transcripts, local repository paths, and attachments stay on your machine. Tideline redacts common credential patterns in messages.

The CLI reads Codex sessions under `${CODEX_HOME:-~/.codex}/sessions` and `archived_sessions` in the same home directory. It reads Claude Code sessions under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`. For Cursor, it reads local IDE SQLite storage under `~/Library/Application Support/Cursor/User` on macOS or `${XDG_CONFIG_HOME:-~/.config}/Cursor/User` on Linux. Use `TIDELINE_CURSOR_USER_DIR` to select a different Cursor User directory. OpenCode uses SQLite under `${XDG_DATA_HOME:-~/.local/share}/opencode`. If OpenCode uses a custom database file, set the same `OPENCODE_DB` when running setup.

For an approval created before Cursor and OpenCode support, run `sync revoke`, then `sync setup` again to include these sources. Cursor support covers local, single-folder IDE sessions. OpenCode support covers local sessions stored in SQLite. Both sync conversation text, repository information, and any reported model names. OpenCode also syncs available token counts. Cost and activity data are unavailable for these sources. Synced messages retain their original text after edits or deletions in the agent.

Tideline stores the local queue under `~/.tideline` by default. A sync credential is tied to one workspace and expires after 30 days. Sync runs on macOS and Linux using Bun or Node.js 22.13 or later. On macOS, the CLI uses Keychain by default. On Linux, pass `--credential-file` to store the credential in an owner-only file. The same option is available on macOS.

To preview a manual Claude Code import, pass `--source claude-code` to the import command. If Bun is unavailable on your PATH, replace `bun` in the commands above with `npx --yes --package=bun@1.4.4 -- bun`.

## Export and query synced sessions

Sign in with `login` first. `pull`, `count`, and `sql` accept `--repo`, `--source`, `--from`, and `--to`. The dates are inclusive UTC days in `YYYY-MM-DD` format. The workspace defaults to your selected workspace.

```sh
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts pull --repo my-repo --out ./tideline-export
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts count "test failed" --in ./tideline-export --ignore-case
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts sql 'SELECT source, count(*) AS total FROM sessions GROUP BY source' --in ./tideline-export
```

`pull` writes one JSONL file per session and a manifest in a private directory. Omit `--out` to use a new directory under the local Tideline `pulls` folder. The export includes conversation text. Use `--in` with `count` or `sql` to read the export offline. Without search text, `count` counts sessions. With text, it counts matching messages by default. Use `--unit session` to count each matching conversation once and `--field user` or `--field assistant` to search one role.

`sql` runs one read-only `SELECT` or `WITH` query in local SQLite. Its tables are `sessions`, `messages`, `models`, `activity`, `commits`, and `safety_findings`. It prints JSONL by default. Use `--out` with a new `.jsonl` or `.csv` file to save results. Scope larger queries with a repository, source, or date range.

## Create a team workspace

Open **Workspaces**, enter a name under **New team workspace**, and select **Create team workspace**. Open **Members** to choose an email address and role. Copy the invitation link and send it to the teammate. They can join after signing in with that verified email. The invitation expires after seven days.

Members can read and sync sessions and read reports. Admins can also manage workspace settings, invite or remove members, and share sessions. Owners can also assign the admin role. Removing a member ends their team access and revokes their team sync credentials. Each account also has a private personal workspace.

`workspace use` selects the workspace for CLI queries and new collectors. To change the destination of an existing collector, run `sync revoke`, then `sync setup --workspace <id>`.

## Share a session

As the workspace owner or an admin, open a session and review its conversation. Create a link under **Share session**. Anyone with the link can read that snapshot of the conversation. Later messages appear only in the workspace. Revoke the link from the session to end public access.

## Find a session

In **Sessions**, search by title or by a phrase from a processed conversation. Filter by agent and repository. Open **More filters** to select a model or a range of UTC start dates. **Back to sessions** returns you to the same results after you read a conversation.

## Run a usage report

Open **Reports** to see session activity, reported tokens, and estimated cost by repository and model. Choose a time period, agent, or repository, then select **Apply**. **Download CSV** exports counts and usage for the chosen filters. Open a session to see its own breakdown. Token totals include reported input, cache reads and writes, and output. Cost estimates apply standard API token rates in USD. Subscription charges, discounts, and special rates can differ. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

**Partial** shows the subtotal Tideline can count or price. **Unavailable** means the session lacks the data needed for that number. A session counts once in the workspace totals and once on each model row that it used. Older sessions may have only conversation text.

## Manage workspace settings

Open **Settings** to rename the workspace or copy the CLI sync command. Set a monthly estimated spend budget in USD. Tideline marks a budget as near its limit at 80%, reached at 100%, and over budget above 100%. You can also set a weekly or monthly goal for reported tokens or estimated spend. Choose an upper limit or a minimum target, then apply it to all agents or to one agent.

Periods use UTC. Weeks start on Monday. Tideline assigns a session's usage to the period in which the session started. The dashboard updates as sessions sync. If usage data is incomplete, Tideline shows the known amount and marks outcomes it cannot establish as partial or unavailable. Budgets and goals are advisory.

## Connect an agent with MCP

Build the CLI and sign in. In the intended workspace, open **Settings** and copy **Codex setup**. Run the copied command from the Tideline checkout, then start a new Codex session. Other MCP clients can launch `node` with the arguments below over stdio. Use absolute paths so the command works from any project.

```sh
bun run --filter @tideline/cli build
node --env-file=apps/cli/.env.local apps/cli/dist/index.js login
```

```text
node --env-file=/path/to/tideline/apps/cli/.env.local /path/to/tideline/apps/cli/dist/index.js mcp --workspace WORKSPACE_ID
```

The agent can search synced sessions, read a conversation, and save a Markdown report with optional links to its source sessions. Ask it to save the report when you want a copy in **Reports** → **Saved reports**. Reports default to **Private**. Ask for **Workspace** visibility to share one with current team members. The author can delete it from the dashboard.

Each MCP connection serves the workspace specified in its command. To revoke this CLI login, rerun the sign-in command with `logout` in place of `login`. Set `TIDELINE_WEB_URL` in the CLI environment if your dashboard runs at a different origin.

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
