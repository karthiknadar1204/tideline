import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { autocompleteMultiselect, confirm, intro, isCancel, log, select, spinner } from "@clack/prompts";
import { sessionSourceLabel } from "@tideline/contracts";
import type { SessionSource } from "@tideline/contracts";
import { readCheckout } from "./repository";
import type { SessionCandidate } from "./session-jsonl";
import { databaseSources, fileSources, isInaccessible, isWithin, readPhysicalDirectory, sessionFiles } from "./sync-sources";
import type { AgentRoots } from "./sync-sources";
import type { ApprovedProject } from "./sync-storage";

type Checkout = Omit<ApprovedProject, "since">;
type Repository = {
  key: string;
  name: string;
  checkouts: Map<string, Checkout>;
  sessions: Map<string, Map<SessionSource, Set<string>>>;
};

export const historyStart = new Date(0).toISOString();

export function terminalText(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

export function sameCheckout(previous: Checkout, next: Checkout) {
  if (previous.directory !== next.directory) return false;
  if (previous.git === undefined) return true;
  if (!previous.git || !next.git) return previous.git === next.git;
  return previous.git.root === next.git.root && previous.git.common === next.git.common;
}

function sessionCounts(repository: Repository) {
  const grouped = new Map<SessionSource, Set<string>>();
  for (const directory of repository.checkouts.keys()) {
    for (const [source, ids] of repository.sessions.get(directory) ?? []) {
      const total = grouped.get(source) ?? new Set<string>();
      for (const id of ids) total.add(id);
      grouped.set(source, total);
    }
  }
  return grouped;
}

function totalDiscoveredSessions(sessions: Map<SessionSource, Set<string>>) {
  return [...sessions.values()].reduce((total, ids) => total + ids.size, 0);
}

export async function* discoverSessions(roots: AgentRoots, warn: (message: string) => void) {
  for (const { root, depth, source, discover } of fileSources(roots)) {
    if (!root || await realpath(root).catch(() => undefined) !== root) continue;
    let skipped = false;
    try {
      for await (const path of sessionFiles(root, depth, () => { skipped = true; })) {
        if (await realpath(path).catch(() => undefined) !== path) continue;
        const candidate = await discover(path).catch(() => undefined);
        if (candidate) yield candidate;
      }
    } catch {
      skipped = true;
    }
    if (skipped) warn(`Some ${sessionSourceLabel[source]} files could not be scanned.`);
  }
  for (const { root, source, discover } of databaseSources(roots)) {
    if (!root || await realpath(root).catch(() => undefined) !== root) continue;
    try {
      yield* discover(root);
    } catch (error) {
      if (!isInaccessible(error) || error.code !== "ENOENT") warn(`${sessionSourceLabel[source]} storage could not be scanned.`);
    }
  }
}

export async function discoverRepositories(roots: AgentRoots, warn: (message: string) => void) {
  const repositories = new Map<string, Repository>();
  const checkouts = new Map<string, Awaited<ReturnType<typeof readCheckout>>>();
  for await (const { source, sourceSessionId, projectDirectory } of discoverSessions(roots, warn)) {
    const directory = await readPhysicalDirectory(projectDirectory);
    if (!directory) continue;
    if (!checkouts.has(directory)) checkouts.set(directory, await readCheckout(directory));
    const checkout = checkouts.get(directory);
    if (checkout === undefined) continue;
    const root = checkout?.root ?? directory;
    const key = checkout?.common ?? directory;
    let repository = repositories.get(key);
    if (!repository) {
      repository = { key, name: checkout?.name ?? (basename(root) || root), checkouts: new Map(), sessions: new Map() };
      repositories.set(key, repository);
    }
    repository.checkouts.set(root, { directory: root, git: checkout && { root, common: checkout.common } });
    const sessions = repository.sessions.get(root) ?? new Map<SessionSource, Set<string>>();
    const ids = sessions.get(source) ?? new Set<string>();
    ids.add(sourceSessionId);
    sessions.set(source, ids);
    repository.sessions.set(root, sessions);
  }
  return [...repositories.values()].sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

export async function explicitProjects(paths: string[]): Promise<Checkout[]> {
  const projects = new Map<string, Checkout>();
  for (const path of paths) {
    const directory = await readPhysicalDirectory(path);
    if (!directory) throw new Error("Each --project must point to an existing directory.");
    const checkout = await readCheckout(directory);
    projects.set(directory, { directory, git: checkout && { root: checkout.root, common: checkout.common } });
  }
  return [...projects.values()];
}

export async function chooseProjects(
  roots: AgentRoots,
  previous: ApprovedProject[],
  options: {
    workspace?: string; history?: boolean; background?: boolean; hooks?: boolean; allowEmpty?: boolean; onboarding?: boolean;
    fullTranscripts?: boolean; previousFullTranscripts?: boolean;
    sessionDetails?: boolean; previousSessionDetails?: boolean;
    subagentTranscripts?: boolean; previousSubagentTranscripts?: boolean;
    onDiscovered?: (repositoriesFound: number, localSessionsFound: number) => Promise<void>;
    received?: ReadonlySet<string>;
  },
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run in an interactive terminal to choose repositories, or pass --project and --conversations.");
  }
  intro(options.onboarding ? "Set up Tideline" : "Tideline · Repository sync");
  if (options.onboarding && !options.allowEmpty) log.info("Choose what to sync from this computer, then approve in your browser.");
  const scanning = spinner();
  scanning.start("Finding repositories in local agent history");
  const warnings = new Set<string>();
  const repositories = await discoverRepositories(roots, (warning) => warnings.add(warning));
  const discoveredCount = repositories.length;
  const localSessionsFound = repositories.reduce((total, repository) => total + totalDiscoveredSessions(sessionCounts(repository)), 0);
  scanning.stop(`Found ${discoveredCount} ${discoveredCount === 1 ? "repository or folder" : "repositories and folders"} · ${localSessionsFound} ${localSessionsFound === 1 ? "local session" : "local sessions"}`);
  for (const warning of warnings) log.warn(warning);
  await options.onDiscovered?.(discoveredCount, localSessionsFound);

  const priorByPath = new Map(previous.map((checkout) => [checkout.directory, checkout]));
  for (const repository of [...repositories]) {
    const retained = new Map([...repository.checkouts].filter(([directory, checkout]) => {
      const prior = priorByPath.get(directory);
      return prior && sameCheckout(prior, checkout);
    }));
    if (retained.size && retained.size < repository.checkouts.size) {
      const additional = new Map([...repository.checkouts].filter(([directory]) => !retained.has(directory)));
      repository.checkouts = retained;
      repositories.push({ ...repository, name: `${repository.name} · Other checkouts`, checkouts: additional });
    }
  }
  const listed = new Set(repositories.flatMap(({ checkouts }) => [...checkouts.keys()]));
  for (const checkout of previous) {
    if (!listed.has(checkout.directory)) {
      repositories.push({ key: checkout.directory, name: basename(checkout.directory), checkouts: new Map([[checkout.directory, checkout]]), sessions: new Map() });
    }
  }
  if (!repositories.length) {
    throw new Error("Tideline found no local sessions. Start a session with Codex, Claude Code, Cursor, or OpenCode, then try again. To choose a folder now, pass --project /path/to/repository --conversations.");
  }

  const wasActive = (checkout: Checkout) => {
    const prior = priorByPath.get(checkout.directory);
    return Boolean(prior && sameCheckout(prior, checkout));
  };
  const items = repositories.map((repository, index) => {
    const { name, checkouts } = repository;
    const sessions = sessionCounts(repository);
    const count = totalDiscoveredSessions(sessions);
    const uploaded = [...sessions].reduce((total, [source, ids]) => {
      for (const id of ids) if (options.received?.has(`${source}:${id}`)) total++;
      return total;
    }, 0);
    const active = [...checkouts.values()].every(wasActive);
    return {
      value: index,
      label: `${terminalText(name)} · ${count} local · ${uploaded} sent here · Sync ${active ? "on" : "off"}`,
      hint: terminalText([
        ...[...sessions].map(([source, ids]) => `${ids.size} ${sessionSourceLabel[source]}`),
        ...(checkouts.size > 1 ? [`${checkouts.size} checkouts`] : [[...checkouts.keys()][0]]),
      ].join(" · ")),
      active,
      count,
    };
  });
  let initialValues = items.filter(({ active }) => active).map(({ value }) => value);
  let settings = {
    history: options.history ?? Boolean(options.onboarding),
    background: options.background ?? true,
    hooks: options.hooks ?? Boolean(options.onboarding),
    sessionDetails: options.sessionDetails ?? options.previousSessionDetails ?? false,
    subagentTranscripts: options.subagentTranscripts ?? options.previousSubagentTranscripts ?? false,
    fullTranscripts: options.fullTranscripts ?? options.previousFullTranscripts ?? false,
  };

  async function customize() {
    const history = options.history ?? await confirm({ message: "Import older sessions?", initialValue: settings.history });
    if (isCancel(history)) return;
    const background = options.background ?? await confirm({ message: "Keep syncing when this terminal closes?", initialValue: settings.background });
    if (isCancel(background)) return;
    const hooks = options.onboarding && options.hooks === undefined
      ? await confirm({ message: "Install agent hooks for faster sync?", initialValue: settings.hooks }) : settings.hooks;
    if (isCancel(hooks)) return;
    const sessionDetails = options.sessionDetails ?? await confirm({
      message: "Include recorded tool input and output, file diffs, and setup?", initialValue: settings.sessionDetails,
    });
    if (isCancel(sessionDetails)) return;
    const subagentTranscripts = sessionDetails && (options.subagentTranscripts ?? await confirm({
      message: "Include redacted subagent conversations?", initialValue: settings.subagentTranscripts,
    }));
    if (isCancel(subagentTranscripts)) return;
    const fullTranscripts = options.onboarding && options.fullTranscripts === undefined
      ? await confirm({ message: "Include redacted raw transcripts and recorded images?", initialValue: settings.fullTranscripts }) : settings.fullTranscripts;
    if (isCancel(fullTranscripts)) return;
    return { history, background, hooks, sessionDetails, subagentTranscripts, fullTranscripts };
  }

  for (;;) {
    const choices = await autocompleteMultiselect({
      message: "Choose repositories to sync",
      placeholder: "Search repositories",
      options: items,
      required: !options.allowEmpty,
      initialValues,
      maxItems: 8,
    });
    if (isCancel(choices)) return;
    const selected = choices.map((index) => repositories[index]);
    const projects = [...new Map(selected.flatMap(({ checkouts }) => [...checkouts])).values()];
    if (!projects.length) {
      const approve = await confirm({ message: "Pause uploads for every repository on this computer?", initialValue: false });
      if (isCancel(approve) || !approve) return;
      return { ...settings, projects, history: false, background: false, hooks: false };
    }
    if (projects.some((project) => previous.some((prior) => prior.since === historyStart && sameCheckout(prior, project)))) {
      log.info("Projects already approved for older sessions keep that approval.");
    }
    if (!options.onboarding) {
      const chosen = await customize();
      if (!chosen) return;
      settings = chosen;
    }
    const destination = options.onDiscovered ? "the workspace open in your browser"
      : options.workspace ? `workspace ${options.workspace}` : "your personal workspace";
    const selectedSessions = choices.reduce((total, index) => total + items[index].count, 0);
    for (;;) {
      log.info(projects.map(({ directory }) => terminalText(directory)).join("\n"));
      log.info(`Tideline sends redacted conversation text and available metadata to ${destination}.`);
      if (settings.fullTranscripts) log.info("Includes redacted raw transcripts and recorded images.");
      if (settings.sessionDetails) log.info("Includes recorded tool text, diffs, and setup. Tools can expose source code and command output to workspace members.");
      if (settings.sessionDetails && settings.subagentTranscripts) log.info("Includes redacted subagent conversations.");
      if (!options.onboarding) {
        const approved = await confirm({ message: "Approve this selection?", initialValue: false });
        if (isCancel(approved) || !approved) return;
        return { ...settings, projects };
      }

      log.info([
        settings.history ? `Import ${selectedSessions} saved ${selectedSessions === 1 ? "session" : "sessions"}` : "Start with new sessions",
        settings.background ? "Background sync on" : "Background sync off",
        settings.hooks ? "Install Codex and Claude Code hooks" : "Leave agent hooks as configured",
      ].join(" · "));
      const action = await select({
        message: "Review repository selection",
        options: [
          { value: "confirm", label: "Confirm and continue" },
          { value: "settings", label: "Customize setup" },
          { value: "change", label: "Change repositories" },
          { value: "cancel", label: "Cancel setup" },
        ],
      });
      if (isCancel(action) || action === "cancel") return;
      if (action === "confirm") return { ...settings, projects };
      if (action === "change") break;
      settings = await customize() ?? settings;
    }
    initialValues = choices;
  }
}

export function createApprovedScope(projects: ApprovedProject[]) {
  const ordered = [...projects].sort((left, right) => right.directory.length - left.directory.length);
  const dates = new Map(projects.map(({ directory, since }) => [directory, Date.parse(since)]));
  const resolved = new Map<string, Promise<string | undefined>>();
  const projectRoot = (directory: string) => ordered.find((project) => isWithin(directory, project.directory))?.directory;

  async function verify(directory: string) {
    const physical = await readPhysicalDirectory(directory);
    const project = physical && ordered.find((root) => isWithin(physical, root.directory));
    if (!physical || !project) return;
    if (await realpath(project.directory).catch(() => undefined) !== project.directory) return;
    if (project.git !== undefined) {
      const actual = await readCheckout(physical);
      if (project.git ? actual?.root !== project.git.root || actual.common !== project.git.common : actual !== null) return;
    }
    return physical;
  }

  return {
    projectRoot,
    since: Math.min(...dates.values()),
    projectScope(directory: string | undefined) {
      if (!directory || !isAbsolute(directory)) return Promise.resolve(undefined);
      let pending = resolved.get(directory);
      if (!pending) {
        pending = verify(directory);
        resolved.set(directory, pending);
      }
      return pending;
    },
    sessionAllowed({ startedAt, projectDirectory }: Pick<SessionCandidate, "startedAt" | "projectDirectory">) {
      const root = projectRoot(projectDirectory);
      return root !== undefined && Date.parse(startedAt) >= (dates.get(root) ?? Number.POSITIVE_INFINITY);
    },
  };
}
