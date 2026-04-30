import type { Evaluator, ScoringMetric } from "../types.ts";

interface ToolSelectionExpect {
  shouldUseTools: boolean;
  requiredTools: string[];
  forbiddenTools?: string[];
  minToolCalls?: number;
  maxToolCalls?: number;
}

function parseExpect(raw: Record<string, unknown>): ToolSelectionExpect {
  const requiredTools = Array.isArray(raw.requiredTools)
    ? (raw.requiredTools as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const forbiddenTools = Array.isArray(raw.forbiddenTools)
    ? (raw.forbiddenTools as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  return {
    shouldUseTools: typeof raw.shouldUseTools === "boolean" ? raw.shouldUseTools : false,
    requiredTools,
    ...(forbiddenTools.length > 0 ? { forbiddenTools } : {}),
    ...(typeof raw.minToolCalls === "number" ? { minToolCalls: raw.minToolCalls } : {}),
    ...(typeof raw.maxToolCalls === "number" ? { maxToolCalls: raw.maxToolCalls } : {}),
  };
}

export const toolSelectionEvaluator: Evaluator = async ({ output, expectedOutput }) => {
  const expected = parseExpect(expectedOutput);
  const unique = new Set(output.toolNames);
  const count = output.toolCalls;

  // 1. Did it use tools when expected (and not when not)?
  const decision = expected.shouldUseTools ? (count > 0 ? 1 : 0) : (count === 0 ? 1 : 0);

  // 2. Were all required tools called?
  const required =
    expected.requiredTools.length === 0
      ? 1
      : expected.requiredTools.every((t) => unique.has(t))
        ? 1
        : 0;

  // 3. Were no forbidden tools called?
  const forbidden =
    (expected.forbiddenTools ?? []).length === 0
      ? 1
      : (expected.forbiddenTools ?? []).every((t) => !unique.has(t))
        ? 1
        : 0;

  // 4. Within min/max call count bounds?
  const callCount =
    (expected.minToolCalls === undefined || count >= expected.minToolCalls) &&
    (expected.maxToolCalls === undefined || count <= expected.maxToolCalls)
      ? 1
      : 0;

  const overall = (decision + required + forbidden + callCount) / 4;

  const scores: ScoringMetric[] = [
    {
      name: "tool_selection_overall",
      value: overall,
      comment: `tools=[${output.toolNames.join(", ")}] calls=${count}`,
    },
    { name: "tool_decision", value: decision },
    { name: "required_tools", value: required },
    { name: "forbidden_tools", value: forbidden },
    { name: "call_count", value: callCount },
  ];

  return scores;
};
