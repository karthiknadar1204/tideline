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

Set `TIDELINE_WEB_ORIGIN` in the web app to that same origin. The web build bundles the CLI and serves it with `/install.sh`. If the CLI needs a different API URL from the web server, set `TIDELINE_PUBLIC_API_URL` in the web app.

In Clerk's **User & authentication → User model** settings, turn off Clerk's self-service account deletion for the instance. Use **Settings → Account** in Tideline to delete an account so Tideline removes its data and access before deleting its Clerk identity. [Clerk user permissions](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options#user-model)

## Sync your first session

Copy the install command from the landing page or your workspace. It installs the CLI under `~/.local` and opens repository selection. Add `~/.local/bin` to your `PATH` to run `tideline` directly. To use a different location, set `TIDELINE_INSTALL_PREFIX` to an absolute path in the installer’s shell environment.

To run the development copy from the checkout, build it first.

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

Run setup from the Tideline checkout. The picker finds repositories and folders in local agent history. Type to search and use the arrow keys and Tab to select. Each entry shows how many local sessions Tideline found, how many this collector sent to the selected workspace, and whether sync is on. Related Git worktrees are grouped, and the review lists the exact folders you are approving.

```sh
bun --env-file=apps/cli/.env.local apps/cli/src/index.ts sync setup
```

Choose whether to include older sessions and whether to sync in the background. Approve in Clerk to use your private workspace, or pass `--workspace` with its ID. On Linux, add `--credential-file`. Run setup again to change the selection. Existing history approvals carry forward for retained folders. Removing a folder stops future uploads from it. Its imported sessions stay in the dashboard.

You can also open the picker with `upload`, `connect`, `enable`, or `disable`. To pause every repository, clear the selection and confirm. Use `sync retry` or `upload --retry` to resend queued uploads and recover failed ones from approved local sessions. An active collector picks up the request. When sync is stopped, the command attempts the retry directly. Use `sync status` to see what still needs attention.

`upload <file>` uses the same options and approval as `import <file>`.

Run `tideline sync once` with background sync stopped to scan the current selection, upload new or changed sessions, and exit.

To select paths without the picker, pass `--project /path/to/first /path/to/second --conversations`. Add `--history` to import older sessions and `--background` to start sync immediately. Use `sync start` and `sync stop` to control the background collector. Run `tideline sync autostart enable` from an installed CLI to start sync at login on macOS or Linux with systemd. Run `tideline sync autostart status` to check it and `tideline sync autostart disable` to remove it. Use `sync run` to watch in the terminal, `sync status` to check upload counts, or `sync revoke` to end this collector’s authorization.

Tideline checks local session files and databases about every two seconds. The local queue catches up after reconnecting or restarting. An upload can include up to 1 MiB of conversation and metadata, with a limit of 500 messages. Optional session details have a separate 512 KiB limit. Discovery can count sessions that exceed these limits or lack enough data to import.

**Settings → General** shows sync coverage. Collectors send an inventory at startup and every 30 minutes while running. It contains session IDs, agent names, and start times for approved sessions. The workspace compares those IDs with sessions it received. **Settings → Uploads** uses repository names and hashed IDs from the same report to show enabled, paused, and unreported repositories. Set `TIDELINE_SESSION_INVENTORY=0` in the collector environment to turn both reports off. The collector clears its previous report when it next connects. Agents can check coverage through the MCP tool `sync_coverage`.

For Codex and Claude Code, run `tideline sync setup --session-details` to include tool input and output text, recorded file diffs, and selected setup metadata. The collector redacts common credential patterns. Add `--repository-instructions` to sync supported instruction files from selected checkouts. Use `--repository-context` separately to sync redacted skill and agent definitions plus the paths, file sizes, and collector fingerprints of supported configurations and skill resources. **Repositories → Context** shows the latest snapshot.

With session details enabled, use `--subagent-transcripts` to collect bounded excerpts of linked Codex and Claude Code child conversations up to four levels deep. Open the parent session and select **Subagents** to read them.

Run `tideline sync setup --hooks --full-transcripts` to enable two optional features. The hooks wake a running collector after Codex and Claude Code events. Check them with `tideline hooks status` or remove them with `tideline hooks remove`. If Codex requests trust for the new hooks, review the Tideline commands in Codex’s `/hooks` menu. Polling also runs when no hooks are installed.

Full transcripts keep the redacted JSONL source records separately from the conversation summary. They include embedded PNG, JPEG, GIF, and WebP images up to 6 MiB each. Unsupported attachments are marked in the archive. Collection stops at a source record that exceeds the local reader limit or cannot be verified as belonging to the selected checkout. Open **Transcript** to read records and download JSONL or images. Enable both `--session-details` and `--subagent-transcripts` to include separate streams for verified child agents. Run `tideline sync setup --no-full-transcripts` to stop sending new archive data.

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

Add `--details` to `pull` or live `sql` to include captured tool text, file changes, and setup. Use `--pattern` on `pull` or `count` for regular expressions. For example, run `tideline count --pattern 'timeout|429' --field tool-output --unit call` to count each matching call once. Regex counts use your most recent default pull when available. Pass `--live` for fresh workspace data or `--in` for a specific export.

Add `--github` to `pull` to save imported pull requests and CI runs with the export. Use `sql --github` for live queries against `github_activity`, or query the table offline with `sql --in` using an export that includes it.

Add `--transcripts` to `pull` to save any archived JSONL and supported embedded images alongside the regular export.

`sql` runs one read-only `SELECT` or `WITH` query in local SQLite. Its tables are `sessions`, `messages`, `models`, `activity`, `commits`, `safety_findings`, `calls`, `prompts`, `agent_runs`, `agent_messages`, `file_changes`, and `session_setup`. It prints JSONL by default. Use `--out` with a new `.jsonl` or `.csv` file to save results. Scope larger queries with a repository, source, or date range.

## Create a team workspace

Open **Workspaces**, enter a name under **New team workspace**, and select **Create team workspace**. Open **Members** to choose an email address and role. Copy the invitation link and send it to the teammate. They can join after signing in with that verified email. The invitation expires after seven days.

Members can read and sync sessions and read reports. Admins can also manage workspace settings, invite or remove members, and share sessions. Owners can also assign the admin role. Removing a member ends their team access and revokes their team sync credentials. Each account also has a private personal workspace.

`workspace use` selects the workspace for CLI queries and new collectors. To change the destination of an existing collector, run `sync revoke`, then `sync setup --workspace <id>`.

## Share a session

As the workspace owner or an admin, open a session and review its conversation. Create a link under **Share session**. Anyone with the link can read that snapshot of the conversation. Later messages appear only in the workspace. Revoke the link from the session to end public access.

## Find a session

In **Sessions**, search by title, a phrase from a processed conversation, or its ID. Open **Filters** to narrow results by agent, repository, model, member, skill, subagent type, tool failure, reported frustration, UTC dates, and ranges for tokens, estimated cost, elapsed time, or messages. **Back to sessions** preserves those filters.

## Run a usage report

From a GitHub checkout, run `tideline github sync` after signing in with `gh auth login` and `tideline login`. The command imports up to 100 recent merged pull requests and 100 recent GitHub Actions runs. Open **Reports → GitHub** to filter and open those records.

Run `tideline sync setup --github-activity` to opt the selected GitHub checkouts into automatic collection. Tideline checks approved origins about every 15 minutes and uploads changed results through the collector's workspace credential. GitHub authentication stays in the local `gh` installation. A changed origin needs a new approval. Run `tideline sync setup --no-github-activity` to stop automatic collection while keeping session sync.

**Reports → Trends** compares two equal, completed UTC periods using synced workspace sessions. Its links open the sessions behind the recorded usage, failures, and frustration counts.

**Reports → Session intelligence** groups failed tools, skills, and child agents, common error reasons, and explicit feedback. Each pattern shows the number of affected sessions and recorded events in both periods. Open an example to jump to its source line. Error reasons use captured output when available, and the report shows how many sessions have incomplete activity.

Open **Trends** on the public site to compare benchmark scores by cost or duration. **Agent runs** shows monthly session and tool-call statistics from a public coding-agent sample. **Dev usage** shows observed tool errors by model, with a choice of how to normalize the counts. Each view links to its dataset and explains its coverage. Public Trends reads published datasets independently of workspace activity.

Open **Reports → Weekly** to compare completed UTC weeks, open notable sessions, download Markdown, or save a private report.

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

## Deliver daily and weekly digests

Workspace owners can open **Settings** → **Digests** to enable either schedule and choose up to 25 active recipients for each. Daily digests go out Monday through Friday if the preceding UTC workday has synced sessions. Monday reports cover Friday. Weekly digests cover the most recent completed Monday through Sunday and can go out on any day at a selected UTC hour. Both include usage totals, repository and model names, and notable session titles. Recipients use their current verified primary Clerk email addresses. Opening the report link in Tideline requires workspace access.

To enable delivery, set the worker's `TIDELINE_DIGEST_MAIL_URL` to your HTTPS mail relay, `TIDELINE_DIGEST_MAIL_TOKEN` to the relay's bearer credential, `CLERK_SECRET_KEY` to the Tideline instance's server key, and `TIDELINE_WEB_ORIGIN` to the dashboard origin. Run database migrations before starting the worker. Local HTTP is supported on loopback for testing.

The relay accepts an authenticated `POST` with JSON fields `to`, `subject`, and `markdown`. Return a successful HTTP status once accepted. Honor the `Idempotency-Key` header by returning success on repeated requests without sending another message. The key identifies a workspace, recipient, digest cadence, and reporting period. The worker stores successful deliveries, retries temporary failures, and attempts the current scheduled digest on its next check if the configured time has already passed.

## Connect enterprise identity

Enable Clerk Organizations with optional membership so personal workspaces stay available. Configure the API webhook endpoint at `/v1/webhooks/clerk-directory` and set `CLERK_WEBHOOK_SIGNING_SECRET` in the API environment. Subscribe to `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`, `organization.deleted`, `user.updated`, and `user.deleted`.

In a Tideline team, open **Settings → Integrations → Enterprise identity**. The workspace owner must also be an administrator of the selected Clerk organization. Link the organization, then open its **Security** tab to configure SAML single sign-on and SCIM Directory Sync. Enable self-serve SSO and Directory Sync for that organization in Clerk first. Existing manual memberships retain their Tideline roles. [Clerk self-serve SSO](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-sso) and [Clerk Directory Sync](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-directory-sync).

## Review commits and safety findings

Open a synced session to see commits reported by a `git commit` tool result and verified against the local repository. Tideline builds commit links for GitHub and GitLab origins. Other repositories show the verified SHA. A link can become reachable when you push the commit to the origin.

The collector looks for specific risky shell commands and possible credentials. The dashboard shows the rule and log line. Findings are advisory. Older sessions show unavailable until the collector sends a review.

## Configure Stripe test billing

The workspace owner can open **Settings** → **Billing** to see subscription status, start Stripe Checkout, or manage a subscription in Stripe’s customer portal.

1. Create the recurring prices in a Stripe sandbox and configure its customer portal. [Stripe customer portal setup](https://docs.stripe.com/customer-management/integrate-customer-portal)
2. Set `TIDELINE_STRIPE_TEST_SECRET_KEY` to the test secret key and `TIDELINE_STRIPE_PRICE_IDS` to the comma-separated price IDs in the API environment. Apply the database migrations and retain the correct `TIDELINE_WEB_ORIGIN` for return links.
3. Forward Stripe snapshot webhooks to `/v1/webhooks/stripe` and set `TIDELINE_STRIPE_WEBHOOK_SECRET` from the webhook listener. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `customer.subscription.created`, `updated`, `deleted`, `paused`, and `resumed`. [Stripe webhook testing and signatures](https://docs.stripe.com/webhooks)

Billing runs in Stripe test mode. Tideline reads product names and billing intervals from Stripe, and Stripe displays the configured amount at Checkout.

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
