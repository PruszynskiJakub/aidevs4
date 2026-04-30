import { describe, it, expect } from "bun:test";
import { toolSelectionEvaluator } from "../../../apps/server/src/evals/evaluators/tool-selection.ts";
import type { EvalCase, AgentOutput } from "../../../apps/server/src/evals/types.ts";

function makeCase(expect: Record<string, unknown>): EvalCase {
  return { id: "test", message: "test message", expect };
}

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    response: "",
    toolNames: [],
    toolCalls: 0,
    iterations: 1,
    tokens: { input: 0, output: 0, total: 0 },
    durationMs: 100,
    ...overrides,
  };
}

describe("tool-selection evaluator", () => {
  it("scores perfect when tool used as expected", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({
        shouldUseTools: true,
        requiredTools: ["grep"],
        maxToolCalls: 3,
      }),
      output: makeOutput({ toolNames: ["grep"], toolCalls: 1 }),
      expectedOutput: {
        shouldUseTools: true,
        requiredTools: ["grep"],
        maxToolCalls: 3,
      },
    });

    const overall = scores.find((s) => s.name === "tool_selection_overall");
    expect(overall?.value).toBe(1);
  });

  it("scores perfect when no tool expected and none used", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({
        shouldUseTools: false,
        requiredTools: [],
        maxToolCalls: 0,
      }),
      output: makeOutput({ toolNames: [], toolCalls: 0 }),
      expectedOutput: {
        shouldUseTools: false,
        requiredTools: [],
        maxToolCalls: 0,
      },
    });

    const overall = scores.find((s) => s.name === "tool_selection_overall");
    expect(overall?.value).toBe(1);
  });

  it("fails decision when tools used but not expected", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({ shouldUseTools: false, requiredTools: [] }),
      output: makeOutput({ toolNames: ["bash"], toolCalls: 1 }),
      expectedOutput: { shouldUseTools: false, requiredTools: [] },
    });

    const decision = scores.find((s) => s.name === "tool_decision");
    expect(decision?.value).toBe(0);
  });

  it("fails required_tools when expected tool not called", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({
        shouldUseTools: true,
        requiredTools: ["grep", "read_file"],
      }),
      output: makeOutput({ toolNames: ["grep"], toolCalls: 1 }),
      expectedOutput: {
        shouldUseTools: true,
        requiredTools: ["grep", "read_file"],
      },
    });

    const required = scores.find((s) => s.name === "required_tools");
    expect(required?.value).toBe(0);
  });

  it("fails forbidden_tools when forbidden tool called", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({
        shouldUseTools: true,
        requiredTools: ["glob"],
        forbiddenTools: ["bash"],
      }),
      output: makeOutput({ toolNames: ["glob", "bash"], toolCalls: 2 }),
      expectedOutput: {
        shouldUseTools: true,
        requiredTools: ["glob"],
        forbiddenTools: ["bash"],
      },
    });

    const forbidden = scores.find((s) => s.name === "forbidden_tools");
    expect(forbidden?.value).toBe(0);
  });

  it("fails call_count when exceeding maxToolCalls", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({
        shouldUseTools: true,
        requiredTools: [],
        maxToolCalls: 2,
      }),
      output: makeOutput({
        toolNames: ["grep", "read_file", "glob"],
        toolCalls: 3,
      }),
      expectedOutput: {
        shouldUseTools: true,
        requiredTools: [],
        maxToolCalls: 2,
      },
    });

    const callCount = scores.find((s) => s.name === "call_count");
    expect(callCount?.value).toBe(0);
  });

  it("returns 5 metrics per case", async () => {
    const scores = await toolSelectionEvaluator({
      input: makeCase({ shouldUseTools: true, requiredTools: ["grep"] }),
      output: makeOutput({ toolNames: ["grep"], toolCalls: 1 }),
      expectedOutput: { shouldUseTools: true, requiredTools: ["grep"] },
    });

    expect(scores).toHaveLength(5);
    const names = scores.map((s) => s.name);
    expect(names).toContain("tool_selection_overall");
    expect(names).toContain("tool_decision");
    expect(names).toContain("required_tools");
    expect(names).toContain("forbidden_tools");
    expect(names).toContain("call_count");
  });
});
