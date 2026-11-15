import { MAX_SESSION_COMMITS, MAX_SESSION_FINDINGS } from "@tideline/contracts";
import type { SafetyFinding } from "@tideline/contracts";
import { redactConversationText } from "@tideline/contracts/redaction";

export { redactConversationText };

export type SessionEvidence = {
  throughLine: number;
  findings: SafetyFinding[];
  commitCandidates: { hash: string; line: number }[];
  truncated: boolean;
};

type Command = { words: string[]; separator: string };
const shell = /^(?:.*\/)?(?:bash|dash|sh|zsh)$/;

function commands(command: string): Command[] {
  const parsed: Command[] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;

  function finishWord() {
    if (started) words.push(word);
    word = "";
    started = false;
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      if (index + 1 === command.length) return [];
      word += command[index += 1];
      started = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "#" && !started) {
      const end = command.indexOf("\n", index);
      if (end === -1) break;
      index = end - 1;
    } else if ("\n;|&()".includes(character)) {
      finishWord();
      const repeated = (character === "|" || character === "&") && command[index + 1] === character;
      if (repeated) index += 1;
      parsed.push({ words, separator: repeated ? character.repeat(2) : character });
      words = [];
    } else if (/\s/.test(character)) {
      finishWord();
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return [];
  finishWord();
  if (words.length) parsed.push({ words, separator: "" });
  return parsed;
}

function commandArguments(words: string[]) {
  const index = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (index === -1) return [];
  return words.slice(words[index] === "sudo" || words[index] === "command" ? index + 1 : index);
}

function hasFlag(arguments_: string[], long: string, short: string) {
  return arguments_.some((value) => value === long || /^-[A-Za-z]+$/.test(value) && value.slice(1).includes(short));
}

function inspectCommand(command: string | string[]) {
  let text = typeof command === "string" ? command.trim() : undefined;
  let parts = typeof command === "string" ? commands(command) : [{ words: command, separator: "" }];
  const wrapper = parts.length === 1 ? parts[0].words : [];
  if (wrapper.length === 3 && shell.test(wrapper[0]) && /^-[il]*c$/.test(wrapper[1]) &&
    parts[0]?.separator === "") {
    text = wrapper[2].trim();
    parts = commands(wrapper[2]);
  }

  const findings = new Set<SafetyFinding["rule"]>();
  for (const [index, part] of parts.entries()) {
    const [executable, subcommand, ...rest] = commandArguments(part.words);
    const flags = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
    if (executable === "git") {
      if (subcommand === "push" && !hasFlag(flags, "--dry-run", "n") &&
        (hasFlag(flags, "--force", "f") || flags.some((value) => /^--force-with-lease(?:=|$)/.test(value)) ||
          rest.some((value) => /^\+[^\s]+$/.test(value)))) findings.add("force-push");
      if (subcommand === "reset" && flags.includes("--hard")) findings.add("hard-reset");
      if (subcommand === "clean" && hasFlag(flags, "--force", "f") && !hasFlag(flags, "--dry-run", "n")) findings.add("git-clean");
    }
    if (executable === "rm") {
      const arguments_ = [subcommand, ...rest].filter((value): value is string => value !== undefined);
      const flags = arguments_.includes("--") ? arguments_.slice(0, arguments_.indexOf("--")) : arguments_;
      if (hasFlag(flags, "--force", "f") && (hasFlag(flags, "--recursive", "r") || hasFlag(flags, "--recursive", "R"))) {
        findings.add("recursive-delete");
      }
    }
    if ((executable === "curl" || executable === "wget") && part.separator === "|" &&
      shell.test(commandArguments(parts[index + 1]?.words ?? [])[0] ?? "")) findings.add("remote-shell");
  }

  const single = parts.length === 1 ? parts[0] : undefined;
  const isCommit = single?.separator === "" && single.words[0] === "git" && single.words[1] === "commit" &&
    !(text && /[`$<>]/.test(text)) && !single.words.some((argument) => argument === "--dry-run");
  return { findings, isCommit };
}

export function createSessionSafety() {
  const calls = new Map<string, {
    inProject: boolean;
    commit: boolean;
    failed?: boolean;
    ambiguous?: boolean;
    result?: SessionEvidence["commitCandidates"][number];
  }>();
  const findings: SafetyFinding[] = [];
  const findingKeys = new Set<string>();
  let throughLine = 0;
  let truncated = false;

  function add(rule: SafetyFinding["rule"], line: number, key = String(line)) {
    const findingKey = `${rule}:${key}`;
    const location = `${rule}:${line}`;
    if (findingKeys.has(findingKey) || findingKeys.has(location)) return;
    throughLine = Math.max(throughLine, line);
    if (findings.length === MAX_SESSION_FINDINGS) {
      truncated = true;
      return;
    }
    findingKeys.add(findingKey);
    findingKeys.add(location);
    findings.push({ rule, line });
  }

  function scanCredential(text: string, line: number, key?: string) {
    if (redactConversationText(text) !== text) add("possible-credential", line, key);
  }

  function command({ id, command: commandText, line, inProject }: {
    id: string; command: string | string[]; line: number; inProject: boolean;
  }) {
    const { findings, isCommit } = inspectCommand(commandText);
    const existing = calls.get(id);
    if (existing) {
      if (existing.inProject && !inProject) throughLine = Math.max(throughLine, line);
      existing.inProject &&= inProject;
    } else calls.set(id, { inProject, commit: isCommit });
    for (const rule of findings) add(rule, line, `command:${id}`);
    scanCredential(typeof commandText === "string" ? commandText : commandText.join(" "), line, `command:${id}`);
  }

  function result({ id, output, line, success }: { id: string; output: string; line: number; success?: boolean }) {
    const call = calls.get(id);
    if (!call) return;
    scanCredential(output, line, `result:${id}`);
    if (success === false) {
      if (call.result) throughLine = Math.max(throughLine, line);
      call.failed = true;
    }
    if (!call.inProject || !call.commit || !success || call.failed || call.ambiguous) return;
    const summaries = /^\[(?:detached HEAD|[^\]\r\n ]+)(?: \(root-commit\))? ([0-9a-f]{7,64})\][ \t]+[^\r\n]+/gm;
    const hashes = new Set(Array.from(output.matchAll(summaries), ([, hash]) => hash));
    if (call.result) hashes.add(call.result.hash);
    if (hashes.size > 1) {
      if (call.result) throughLine = Math.max(throughLine, line);
      call.ambiguous = true;
      return;
    }
    const hash = [...hashes][0];
    if (!hash || call.result) return;
    call.result = { hash, line };
    throughLine = Math.max(throughLine, line);
  }

  function snapshot(lastMessageLine: number): SessionEvidence {
    const commitCandidates = new Map<string, SessionEvidence["commitCandidates"][number]>();
    for (const { inProject, result, failed, ambiguous } of calls.values()) {
      if (!inProject || failed || ambiguous || !result || commitCandidates.has(result.hash)) continue;
      commitCandidates.set(result.hash, result);
    }
    const commits = [...commitCandidates.values()].sort((first, second) => first.line - second.line);
    return {
      throughLine: Math.max(throughLine, lastMessageLine),
      findings,
      commitCandidates: commits.slice(0, MAX_SESSION_COMMITS),
      truncated: truncated || commits.length > MAX_SESSION_COMMITS,
    };
  }

  return { command, result, scanCredential, snapshot };
}
