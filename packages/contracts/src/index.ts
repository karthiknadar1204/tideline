import { z } from "zod";

export const healthResponse = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponse>;

export const workspaceResponse = z.object({
  id: z.uuid(),
  name: z.string().min(1),
});

export type WorkspaceResponse = z.infer<typeof workspaceResponse>;

export const MAX_CODEX_IMPORT_BYTES = 1_048_576;
export const MAX_CODEX_IMPORT_EVENTS = 500;

export const sessionSource = z.enum(["codex", "claude-code"]);

const repository = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});

export const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const tokenCount = z.int().nonnegative().max(1_000_000_000_000);
export const modelTokens = z.strictObject({
  input: tokenCount,
  cachedInput: tokenCount,
  cacheWrite5m: tokenCount,
  cacheWrite1h: tokenCount,
  cacheWriteUnknown: tokenCount,
  output: tokenCount,
});
const modelUsage = z.strictObject({
  model: modelId.nullable(),
  tokens: modelTokens.nullable(),
});
const tokenCoverage = z.enum(["reported", "partial", "unavailable"]);
const sessionAnalytics = z.strictObject({
  throughLine: z.int().positive(),
  repository: repository.nullable(),
  models: z.array(modelUsage).max(512).refine(
    (models) => new Set(models.map(({ model }) => model)).size === models.length,
    { message: "Model usage must contain at most one entry per model." },
  ),
  tokenCoverage,
}).refine(
  ({ models, tokenCoverage }) => models.some(({ tokens }) => tokens !== null) === (tokenCoverage !== "unavailable"),
  { path: ["tokenCoverage"], message: "Token coverage must reflect whether usage was reported." },
);

const conversationMessage = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(32_000).refine(
    (text) => !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text),
    { message: "Message text must be valid Unicode without null characters." },
  ),
  line: z.int().positive(),
  timestamp: z.iso.datetime(),
});

export const sessionImportRequest = z.strictObject({
  version: z.literal(1),
  workspaceId: workspaceResponse.shape.id,
  session: z.strictObject({
    source: sessionSource.default("codex"),
    sourceSessionId: z.uuid(),
    startedAt: z.iso.datetime(),
    events: z.array(conversationMessage).min(1).max(MAX_CODEX_IMPORT_EVENTS).refine(
      (events) => events.every((event, index) => index === 0 || events[index - 1].line < event.line),
      { message: "Messages must be in source line order." },
    ),
    analytics: sessionAnalytics.optional(),
  }).refine(
    ({ analytics, events }) => !analytics || analytics.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["analytics", "throughLine"], message: "Analytics must cover the last conversation message." },
  ),
});

export const codexImportResponse = z.strictObject({
  id: z.uuid(),
  alreadyReceived: z.boolean(),
});

const sessionSummaryResponse = z.strictObject({
  id: z.uuid(),
  source: sessionSource,
  startedAt: z.iso.datetime(),
  title: z.string().min(1).max(100),
  messageCount: z.int().positive(),
  analytics: z.strictObject({
    repository: repository.nullable(),
    tokenCoverage,
    models: z.array(modelUsage.extend({
      estimatedCostUsd: z.number().nonnegative().nullable(),
    })),
  }).nullable(),
});

export const sessionSummariesResponse = z.array(sessionSummaryResponse);
export const sessionDetailResponse = sessionSummaryResponse.extend({
  sourceSessionId: z.uuid(),
  messages: z.array(conversationMessage).min(1).max(MAX_CODEX_IMPORT_EVENTS),
});

export const syncEnrollmentRequest = z.strictObject({
  workspaceId: workspaceResponse.shape.id,
});

export const syncEnrollmentResponse = z.strictObject({
  token: z.string().regex(/^tdsync_[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime(),
});

export const codexImportRequest = sessionImportRequest;
export type SessionImportRequest = z.infer<typeof sessionImportRequest>;
export type CodexImportRequest = z.input<typeof sessionImportRequest>;
export type SessionSource = z.infer<typeof sessionSource>;
export type SessionAnalytics = z.infer<typeof sessionAnalytics>;
export type ModelTokens = z.infer<typeof modelTokens>;
export type SessionSummary = z.infer<typeof sessionSummaryResponse>;
export type SessionDetail = z.infer<typeof sessionDetailResponse>;
