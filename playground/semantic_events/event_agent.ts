import type { LLMMessage, LLMToolCall } from "../../apps/server/src/types/llm.ts";
import { llm } from "../../apps/server/src/services/ai/llm.ts";
import { config } from "../../apps/server/src/config/index.ts";
import { getTools, dispatch } from "../../apps/server/src/tools/index.ts";
import { promptService } from "../../apps/server/src/services/ai/prompt.ts";
import { agentsService as agents } from "../../apps/server/src/services/agent/agents/agents.ts";
import { AgentEventEmitter } from "./event_emitter.ts";
import { makeEventId, parsePlanSteps } from "./types.ts";
import type { AgentEvent } from "./types.ts";

function parseToolResponse(raw: string): {
  status: "ok" | "error";
  data: unknown;
  hints?: string[];
} {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "status" in parsed &&
      "data" in parsed &&
      (parsed.status === "ok" || parsed.status === "error")
    ) {
      return { status: parsed.status, data: parsed.data, hints: parsed.hints };
    }
  } catch {
    /* not JSON */
  }
  return { status: "ok", data: raw };
}

function emit(emitter: AgentEventEmitter, partial: Record<string, unknown> & { type: string }): void {
  emitter.emit({
    id: makeEventId(),
    timestamp: Date.now(),
    ...partial,
  } as AgentEvent);
}

export async function runEventAgent(
  sessionId: string,
  prompt: string,
  emitter: AgentEventEmitter,
): Promise<void> {
  const sessionStart = performance.now();
  const cumulative = { prompt: 0, completion: 0 };

  emit(emitter, { type: "session_start", sessionId, prompt });

  try {
    const assistant = await assistants.get("default");
    const actModel = assistant.model;

    const planPrompt = await promptService.load("plan");
    const planModel = planPrompt.model!;

    const tools = await getTools();

    const messages: LLMMessage[] = [
      { role: "system", content: assistant.prompt },
      { role: "user", content: prompt },
    ];

    for (let i = 0; i < config.limits.maxIterations; i++) {
      const iteration = i + 1;

      // --- PLAN PHASE ---
      emit(emitter, { type: "plan_start", iteration, model: planModel });

      const planMessages: LLMMessage[] = [
        { role: "system", content: planPrompt.content },
        ...messages.filter((m) => m.role !== "system"),
      ];

      const planStart = performance.now();
      const planResponse = await llm.chatCompletion({
        model: planModel,
        messages: planMessages,
        ...(planPrompt.temperature !== undefined && {
          temperature: planPrompt.temperature,
        }),
      });
      const planDuration = performance.now() - planStart;
      const planText = planResponse.content ?? "";

      if (planResponse.usage) {
        cumulative.prompt += planResponse.usage.promptTokens;
        cumulative.completion += planResponse.usage.completionTokens;
        emit(emitter, {
          type: "token_usage",
          iteration,
          phase: "plan",
          model: planModel,
          tokens: {
            prompt: planResponse.usage.promptTokens,
            completion: planResponse.usage.completionTokens,
          },
          cumulative: { ...cumulative },
        });
      }

      const steps = parsePlanSteps(planText);
      emit(emitter, {
        type: "plan_update",
        iteration,
        steps,
        durationMs: Math.round(planDuration),
      });

      // --- ACT PHASE ---
      const actMessages: LLMMessage[] = [
        ...messages,
        { role: "assistant", content: `## Current Plan\n\n${planText}` },
      ];

      const actStart = performance.now();
      const response = await llm.chatCompletion({
        model: actModel,
        messages: actMessages,
        tools,
      });
      const actDuration = performance.now() - actStart;

      if (response.usage) {
        cumulative.prompt += response.usage.promptTokens;
        cumulative.completion += response.usage.completionTokens;
        emit(emitter, {
          type: "token_usage",
          iteration,
          phase: "act",
          model: actModel,
          tokens: {
            prompt: response.usage.promptTokens,
            completion: response.usage.completionTokens,
          },
          cumulative: { ...cumulative },
        });
      }

      // Emit thinking if there's text alongside tool calls
      if (response.content && response.toolCalls.length > 0) {
        emit(emitter, { type: "thinking", iteration, content: response.content });
      }

      messages.push({
        role: "assistant",
        content: response.content,
        ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
      });

      // Final answer — no tool calls
      if (response.finishReason === "stop" || !response.toolCalls.length) {
        emit(emitter, { type: "message", content: response.content ?? "" });
        break;
      }

      // --- TOOL EXECUTION ---
      const functionCalls = response.toolCalls.filter((tc: LLMToolCall) => tc.type === "function");

      // Request user approval before executing
      const requestId = `approve_${sessionId}_${iteration}`;
      emit(emitter, {
        type: "approval_request",
        iteration,
        requestId,
        toolCalls: functionCalls.map((tc) => ({
          toolName: tc.function.name,
          arguments: tc.function.arguments,
        })),
      });

      const approvalResult = await emitter.waitForApproval(requestId);

      emit(emitter, {
        type: "approval_response",
        requestId,
        approved: approvalResult.approved,
        reason: approvalResult.reason,
      });

      if (!approvalResult.approved) {
        const reason = approvalResult.reason === "timeout"
          ? "Approval timed out (no response within 1 hour)."
          : "User rejected this tool call.";
        for (const tc of functionCalls) {
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: JSON.stringify({ error: reason }),
          });
        }
        continue;
      }

      for (let j = 0; j < functionCalls.length; j++) {
        const tc = functionCalls[j];
        emit(emitter, {
          type: "tool_call",
          iteration,
          toolName: tc.function.name,
          arguments: tc.function.arguments,
          batchIndex: j + 1,
          batchSize: functionCalls.length,
        });
      }

      const settled = await Promise.allSettled(
        functionCalls.map(async (tc) => {
          const start = performance.now();
          const result = await dispatch(tc.function.name, tc.function.arguments);
          return { result, elapsed: Math.round(performance.now() - start) };
        }),
      );

      for (let j = 0; j < functionCalls.length; j++) {
        const tc = functionCalls[j];
        const outcome = settled[j];

        if (outcome.status === "fulfilled") {
          const { result, elapsed } = outcome.value;
          const parsed = parseToolResponse(result.xml);
          const llmContent = JSON.stringify(parsed.data);

          emit(emitter, {
            type: "tool_result",
            iteration,
            toolName: tc.function.name,
            status: parsed.status,
            data: llmContent,
            hints: parsed.hints,
            durationMs: elapsed,
          });

          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: llmContent,
          });
        } else {
          const errorMsg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          const errorResult = JSON.stringify({ error: errorMsg });

          emit(emitter, {
            type: "tool_result",
            iteration,
            toolName: tc.function.name,
            status: "error",
            data: errorResult,
            durationMs: 0,
          });

          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: errorResult,
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(emitter, { type: "error", message });
  }

  emit(emitter, {
    type: "session_end",
    sessionId,
    totalDurationMs: Math.round(performance.now() - sessionStart),
    totalTokens: { ...cumulative },
  });
}
