import { activityName, codexSkillInstructions, MAX_SESSION_ACTIVITY_ITEMS } from "@tideline/contracts";
import type { SessionActivity } from "@tideline/contracts";
import { z } from "zod";
import type { createSessionSafety } from "./session-safety";

type ToolCall = SessionActivity["tools"][number];
type SkillUse = SessionActivity["skills"][number];
type ChildRun = SessionActivity["children"][number];

const responseActivity = z.object({
  type: z.string(),
  id: z.string().nullish(),
  call_id: z.string().nullish(),
  name: z.unknown().optional(),
  namespace: z.unknown().optional(),
  status: z.unknown().optional(),
  success: z.unknown().optional(),
  is_error: z.unknown().optional(),
  arguments: z.unknown().optional(),
  output: z.unknown().optional(),
});
const eventActivity = z.object({
  type: z.string(),
  thread_id: z.uuid().optional(),
  item: z.unknown().optional(),
});
const agentLife = z.object({
  agent_thread_id: z.uuid(),
  id: z.string().optional(),
  event_id: z.string().optional(),
  agent_path: z.string().optional(),
  kind: z.enum(["started", "interacted", "interrupted", "completed"]),
});
const toolItem = z.object({
  type: z.string(),
  id: z.string(),
  name: z.unknown().optional(),
  namespace: z.unknown().optional(),
  tool: z.unknown().optional(),
  server: z.unknown().optional(),
  status: z.unknown().optional(),
  success: z.unknown().optional(),
  exit_code: z.unknown().optional(),
  source: z.unknown().optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
  aggregated_output: z.string().nullish(),
  result: z.unknown().optional(),
});
const commandArguments = z.object({
  cmd: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  cwd: z.string().optional(),
  workdir: z.string().optional(),
});
const collaborationItem = z.object({
  sender_thread_id: z.uuid(),
  receiver_thread_ids: z.array(z.uuid()).optional(),
  receiver_agents: z.array(z.object({
    thread_id: z.uuid(),
    agent_role: z.unknown().optional(),
    agent_nickname: z.unknown().optional(),
  })).optional(),
  agents_states: z.record(z.uuid(), z.unknown()).optional(),
});
const childSelection = z.object({
  agent_type: z.unknown().optional(),
  task_name: z.unknown().optional(),
});
const spawnOutput = z.object({ agent_id: z.uuid(), nickname: z.unknown().optional() });
const waitOutput = z.object({ status: z.record(z.uuid(), z.unknown()) });
const outputFields = z.object({ is_error: z.literal(true).optional(), isError: z.literal(true).optional() });
const agentResult = z.object({ completed: z.unknown().optional(), errored: z.unknown().optional() });
const builtInToolNames = new Map([
  ["CommandExecution", "exec_command"],
  ["FileChange", "apply_patch"],
  ["ImageGeneration", "image_gen"],
  ["ImageView", "view_image"],
  ["WebSearch", "web_search"],
]);
const collaborationNamespaces = ["multi_agent_v1", "multi_agent_v2", "collaboration"];
const collaborationTools = (names: string[]) => new Set([
  ...names, ...collaborationNamespaces.flatMap((namespace) => names.map((name) => `${namespace}:${name}`)),
]);
const spawnToolNames = collaborationTools(["spawn_agent"]);
const waitToolNames = collaborationTools(["wait", "wait_agent"]);
const activeChildStatuses = new Set<ChildRun["status"]>(["unknown", "started", "running"]);

function safeName(value: unknown) {
  return activityName.safeParse(value).data;
}

function qualifiedName(namespace: unknown, value: unknown) {
  const name = safeName(value);
  const qualifier = safeName(namespace);
  return name && qualifier ? safeName(`${qualifier}:${name}`) ?? name : name;
}

function structuredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function explicitToolFailure(status: unknown, success: unknown, result?: unknown) {
  const fields = outputFields.safeParse(result).data;
  return status === "failed" || status === "declined" || status === "interrupted" ||
    success === false || fields?.is_error || fields?.isError;
}

function agentStatus(value: unknown): ChildRun["status"] {
  switch (value) {
    case "pending_init": return "started";
    case "running": return "running";
    case "interrupted":
    case "shutdown": return "stopped";
    case "completed": return "completed";
    case "errored":
    case "failed": return "failed";
  }
  const status = agentResult.safeParse(value).data;
  if (status?.errored !== undefined) return "failed";
  if (status?.completed !== undefined) return "completed";
  return "unknown";
}

export function createCodexActivity(safety?: ReturnType<typeof createSessionSafety>) {
  const tools = new Map<string, ToolCall>();
  const children = new Map<string, ChildRun>();
  const skills: SkillUse[] = [];
  const selectedChildren = new Map<string, string>();
  let throughLine = 0;
  let truncated = false;

  function writeTool(id: string, name: string, status: ToolCall["status"], line: number, mcpServer?: string) {
    throughLine = line;
    const existing = tools.get(id);
    if (existing) {
      if (existing.status === "called" || status === "failed") existing.status = status;
      if (mcpServer) existing.mcpServer ??= mcpServer;
    } else if (tools.size < MAX_SESSION_ACTIVITY_ITEMS) {
      tools.set(id, { line, index: 0, name, status, ...(mcpServer && { mcpServer }) });
    } else {
      truncated = true;
    }
  }

  function writeChild({ id, name, status, line, index, allowNew }: {
    id: string; name?: string; status: ChildRun["status"]; line: number; index: number; allowNew: boolean;
  }) {
    const child = children.get(id);
    if (child) {
      throughLine = line;
      if (status !== "unknown" && (status !== "started" || child.status === "unknown") &&
          (status !== "running" || activeChildStatuses.has(child.status))) {
        child.status = status;
      }
      child.name ??= name ?? null;
    } else if (allowNew) {
      throughLine = line;
      if (children.size < MAX_SESSION_ACTIVITY_ITEMS) {
        children.set(id, { line, index, name: name ?? null, status });
      } else {
        truncated = true;
      }
    }
  }

  function response(value: unknown, line: number, projectDirectory?: string) {
    const item = responseActivity.safeParse(value).data;
    if (!item) return;
    const id = item.call_id ?? item.id;
    if (!id) return;

    if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "local_shell_call" ||
        item.type === "web_search_call" || item.type === "tool_search_call") {
      const name = qualifiedName(item.namespace, item.name ?? item.type.replace(/_call$/u, ""));
      if (!name) return;
      if (safety && (name === "exec_command" || name === "shell_command")) {
        const arguments_ = commandArguments.safeParse(structuredValue(item.arguments)).data;
        const command = arguments_?.cmd ?? arguments_?.command;
        const directory = arguments_?.workdir ?? arguments_?.cwd;
        if (command) safety.command({ id, command, line, inProject: !!projectDirectory &&
          (directory === undefined || directory === "." || directory === projectDirectory) });
      }
      if (spawnToolNames.has(name)) {
        const selection = childSelection.safeParse(structuredValue(item.arguments)).data;
        const selected = safeName(selection?.task_name) ?? safeName(selection?.agent_type);
        if (selected && selectedChildren.size < MAX_SESSION_ACTIVITY_ITEMS) selectedChildren.set(id, selected);
      }
      const status = explicitToolFailure(item.status, item.success) ? "failed" :
        item.type === "web_search_call" && item.status === "completed" ? "returned" : "called";
      writeTool(id, name, status, line);
      return;
    }
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output" &&
        item.type !== "tool_search_output" && item.type !== "mcp_tool_call_output") return;
    const name = tools.get(id)?.name ?? qualifiedName(item.namespace, item.name);
    if (!name) return;
    const failed = item.is_error === true || explicitToolFailure(item.status, item.success, item.output);
    if (safety && typeof item.output === "string" && (name === "exec_command" || name === "shell_command")) {
      const envelope = /^Chunk ID: [a-z0-9]+\r?\n(?:Wall time: [^\r\n]*\r?\n)?Process exited with code (-?\d+)\r?\n(?:Original token count: \d+\r?\n)?Output:\r?\n([\s\S]*)$/u.exec(item.output);
      safety.result({ id, output: envelope?.[2] ?? item.output, line,
        success: failed ? false : envelope ? envelope[1] === "0" : undefined });
    }
    writeTool(id, name, failed ? "failed" : "returned", line);
    if (failed) return;

    if (spawnToolNames.has(name)) {
      const parsed = spawnOutput.safeParse(structuredValue(item.output)).data;
      if (!parsed) return;
      writeChild({
        id: parsed.agent_id, name: selectedChildren.get(id) ?? safeName(parsed.nickname),
        status: "started", line, index: 0, allowNew: true,
      });
    } else if (waitToolNames.has(name)) {
      const parsed = waitOutput.safeParse(structuredValue(item.output)).data;
      if (!parsed) return;
      for (const [index, [childId, status]] of Object.entries(parsed.status).entries()) {
        writeChild({ id: childId, status: agentStatus(status), line, index, allowNew: false });
      }
    }
  }

  function childLifecycle(value: unknown, line: number) {
    const activity = agentLife.safeParse(value).data;
    if (!activity) return;
    const status = {
      started: "started",
      interacted: "running",
      interrupted: "stopped",
      completed: "completed",
    } as const;
    const callId = activity.id ?? activity.event_id;
    const name = (callId && selectedChildren.get(callId)) ||
      safeName(/^\/root(?:\/[A-Za-z0-9_.:-]+)*\/([A-Za-z0-9_.:-]+)$/u.exec(activity.agent_path ?? "")?.[1]);
    writeChild({
      id: activity.agent_thread_id, name, status: status[activity.kind], line, index: 0,
      allowNew: activity.kind === "started",
    });
  }

  function event(value: unknown, line: number, sessionId: string, projectDirectory?: string) {
    const parsed = eventActivity.safeParse(value).data;
    if (!parsed || (parsed.thread_id && parsed.thread_id !== sessionId)) return;
    if (parsed.type === "sub_agent_activity") {
      childLifecycle(value, line);
      return;
    }
    if (parsed.type !== "item_completed" && parsed.type !== "item_started") return;
    const item = toolItem.safeParse(parsed.item).data;
    if (!item || (item.type === "CommandExecution" && item.source === "user_shell")) return;
    if (safety && item.type === "CommandExecution") {
      if (item.command) safety.command({ id: item.id, command: item.command, line,
        inProject: !!projectDirectory && item.cwd === projectDirectory });
      if (parsed.type === "item_completed") {
        const output = [item.stdout, item.stderr].filter(Boolean).join("\n") || item.aggregated_output || "";
        safety.result({ id: item.id, output, line, success: explicitToolFailure(item.status, item.success) ? false :
          typeof item.exit_code === "number" ? item.exit_code === 0 : undefined });
      }
    }
    if (item.type === "SubAgentActivity") {
      childLifecycle(parsed.item, line);
      return;
    }
    const status = explicitToolFailure(item.status, item.success, item.result) ||
        (item.type === "CommandExecution" && typeof item.exit_code === "number" && item.exit_code !== 0)
      ? "failed" : parsed.type === "item_completed" ? "returned" : "called";

    if (item.type === "CollabAgentToolCall") {
      const collaboration = collaborationItem.safeParse(parsed.item).data;
      const name = safeName(item.tool);
      if (!name || collaboration?.sender_thread_id !== sessionId) return;
      writeTool(item.id, tools.get(item.id)?.name ?? name, status, line);
      const states = collaboration.agents_states ?? {};
      const references = collaboration.receiver_agents ?? [];
      const referencesById = new Map(references.map((ref) => [ref.thread_id, ref]));
      const ids = new Set([
        ...(collaboration.receiver_thread_ids ?? []), ...referencesById.keys(), ...Object.keys(states),
      ]);
      for (const [index, id] of [...ids].entries()) {
        const ref = referencesById.get(id);
        const childStatus = agentStatus(states[id]);
        const spawned = name === "spawn_agent";
        writeChild({
          id, name: selectedChildren.get(item.id) ?? safeName(ref?.agent_role) ?? safeName(ref?.agent_nickname),
          status: childStatus === "unknown" && spawned ? "started" : childStatus, line, index, allowNew: spawned,
        });
      }
      return;
    }
    const name = builtInToolNames.get(item.type) ?? (
      item.type === "McpToolCall" ? qualifiedName(item.server, item.tool) :
      item.type === "DynamicToolCall" ? qualifiedName(item.namespace, item.tool) :
      item.type === "FunctionCallOutput" ? qualifiedName(item.namespace, item.name) : undefined
    );
    if (name) writeTool(item.id, tools.get(item.id)?.name ?? name, status, line,
      item.type === "McpToolCall" ? safeName(item.server) : undefined);
  }

  function skill(value: string, line: number, index: number) {
    const match = codexSkillInstructions.exec(value.trim());
    const name = safeName(match?.[1]);
    if (!name) return;
    throughLine = line;
    if (skills.length < MAX_SESSION_ACTIVITY_ITEMS) {
      skills.push({ line, index, name, status: "invoked" });
    } else {
      truncated = true;
    }
  }

  function snapshot(lastMessageLine: number): SessionActivity {
    return {
      throughLine: Math.max(throughLine, lastMessageLine),
      truncated,
      tools: [...tools.values()],
      skills,
      children: [...children.values()],
    };
  }

  return { response, event, skill, snapshot };
}
