import { z } from "zod";
import { sessionSource } from "./index";
import { readDay, shiftDay } from "./utc-days";

export const intelligencePeriods = [7, 30, 90] as const;

export const sessionIntelligenceQuery = z.strictObject({
  days: z.coerce.number().pipe(z.literal(intelligencePeriods)),
  through: z.iso.date(),
  source: sessionSource.optional(),
  repository: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
}).refine(({ days, through }) => readDay(through) && through >= shiftDay("0001-01-01", days * 2 - 1));

export function intelligenceDateRanges({ days, through }: z.output<typeof sessionIntelligenceQuery>) {
  return {
    current: { from: shiftDay(through, 1 - days), to: through },
    prior: { from: shiftDay(through, 1 - 2 * days), to: shiftDay(through, -days) },
  };
}

export const failureReasonGuidance = {
  "Rate limit": "Check call volume and whether the integration backs off after a rate limit.",
  Timeout: "Look for a shared timeout or a slow operation in the linked calls.",
  "Permission denied": "Check access to the files, commands, or services in the linked calls.",
  "Authentication error": "Check which integration rejected the credential and whether its scope changed.",
  "Missing dependency": "Check whether the repository setup installs the missing tool or package.",
  "Connection error": "Check whether the linked calls depend on the same service or network route.",
  "Failed checks": "Compare the linked test or build output to see which checks keep failing.",
} satisfies Record<string, string>;

const periodCoverage = z.strictObject({
  sessions: z.int().nonnegative(),
  activitySessions: z.int().nonnegative(),
  incompleteActivitySessions: z.int().nonnegative(),
  capturedOutputSessions: z.int().nonnegative(),
});

export const sessionIntelligenceResponse = z.strictObject({
  current: periodCoverage,
  prior: periodCoverage,
  repositories: z.array(z.strictObject({ key: z.string().regex(/^[0-9a-f]{64}$/u), name: z.string() })),
  patterns: z.array(z.strictObject({
    kind: z.enum(["tool", "skill", "child", "reason", "reported-frustration", "agent-correction"]),
    label: z.string().min(1).max(250),
    currentSessions: z.int().nonnegative(),
    priorSessions: z.int().nonnegative(),
    currentEvents: z.int().nonnegative(),
    priorEvents: z.int().nonnegative(),
    examples: z.array(z.strictObject({
      id: z.uuid(),
      title: z.string().min(1).max(100),
      source: sessionSource,
      startedAt: z.iso.datetime(),
      anchor: z.string().regex(/^(?:message-[1-9][0-9]*|(?:tool|skill|child)-[1-9][0-9]*-[0-9]+)$/u),
    })).max(3),
  })).max(36),
});

export type SessionIntelligenceQuery = z.output<typeof sessionIntelligenceQuery>;
export type SessionIntelligence = z.infer<typeof sessionIntelligenceResponse>;
