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

async function* discoverSessions(roots: AgentRoots, warn: (message: string) => void) {
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
    workspace?: string; history?: boolean; background?: boolean; allowEmpty?: boolean; onboarding?: boolean;
    onDiscovered?: (repositoriesFound: number, localSessionsFound: number) => Promise<void>;
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
    const active = [...checkouts.values()].every(wasActive);
    return {
      value: index,
      label: `${terminalText(name)} · ${count} ${count === 1 ? "local session" : "local sessions"}${active ? " · Sync on" : ""}`,
      hint: terminalText([
        ...[...sessions].map(([source, ids]) => `${ids.size} ${sessionSourceLabel[source]}`),
        ...(checkouts.size > 1 ? [`${checkouts.size} checkouts`] : [[...checkouts.keys()][0]]),
      ].join(" · ")),
      active,
      count,
    };
  });
  let initialValues = items.filter(({ active }) => active).map(({ value }) => value);
  let historyDefault = false;
  let backgroundDefault = true;

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
      return { projects, history: false, background: false };
    }
    if (projects.some((project) => previous.some((prior) => prior.since === historyStart && sameCheckout(prior, project)))) {
      log.info("Projects already approved for older sessions keep that approval.");
    } else if (options.onboarding && options.history === undefined) {
      log.info("You can import existing sessions or start with new sessions only.");
    }
    const history: Awaited<ReturnType<typeof confirm>> = options.history ?? await confirm({ message: "Import older sessions from these repositories?", initialValue: historyDefault });
    if (isCancel(history)) return;
    const background: Awaited<ReturnType<typeof confirm>> = options.background ?? await confirm({ message: "Keep syncing when this terminal closes?", initialValue: backgroundDefault });
    if (isCancel(background)) return;

    if (options.onboarding) {
      const checkoutLabel = projects.length === 1 ? "folder" : "folders";
      const added = projects.filter((checkout) => !wasActive(checkout)).length;
      const kept = projects.length - added;
      const paused = previous.length - kept;
      log.info(`Review ${projects.length} ${checkoutLabel} · ${added} new · ${kept} continuing · ${paused} paused`);
      const selectedSessions = choices.reduce((total, index) => total + items[index].count, 0);
      log.info(`${selectedSessions} ${selectedSessions === 1 ? "local session" : "local sessions"} found in your selection. ${history ? "Include older sessions." : "Start with new sessions in newly selected folders."}`);
    }
    log.info(projects.map(({ directory }) => terminalText(directory)).join("\n"));
    const destination = options.onDiscovered ? "the workspace open in your browser"
      : options.workspace ? `workspace ${options.workspace}` : "your private workspace";
    log.info(`Tideline uploads conversation text and available metadata from these folders to ${destination}. Common credentials in messages are redacted.`);

    if (!options.onboarding) {
      const approved = await confirm({ message: "Approve this selection?", initialValue: false });
      if (isCancel(approved) || !approved) return;
      return { projects, history, background };
    }

    const action = await select({
      message: "Review repository selection",
      initialValue: "change",
      options: [
        { value: "confirm", label: "Confirm selection and continue" },
        { value: "change", label: "Change selection" },
        { value: "cancel", label: "Cancel setup" },
      ],
    });
    if (isCancel(action) || action === "cancel") return;
    if (action === "confirm") return { projects, history, background };
    initialValues = choices;
    historyDefault = history;
    backgroundDefault = background;
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
