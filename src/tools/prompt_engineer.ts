import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { llm } from "../services/ai/llm.ts";
import { promptService } from "../services/ai/prompt.ts";
import { assertMaxLength, safeParse } from "../utils/parse.ts";
import { createDocument } from "../services/common/document-store.ts";
import { getSessionId } from "../services/agent/session-context.ts";

const MAX_GOAL = 2_000;
const MAX_CONSTRAINTS = 1_000;
const MAX_CONTEXT = 5_000;
const MAX_PROMPT = 2_000;
const MAX_FEEDBACK = 2_000;

interface PromptEngineerArgs {
  goal: string;
  constraints: string;
  context: string;
  current_prompt: string;
  feedback: string;
}

async function promptEngineer(
  args: PromptEngineerArgs,
): Promise<Document> {
  assertMaxLength(args.goal, "goal", MAX_GOAL);
  assertMaxLength(args.constraints, "constraints", MAX_CONSTRAINTS);
  assertMaxLength(args.context, "context", MAX_CONTEXT);
  assertMaxLength(args.current_prompt, "current_prompt", MAX_PROMPT);
  assertMaxLength(args.feedback, "feedback", MAX_FEEDBACK);

  if (!args.goal.trim()) {
    throw new Error("goal is required and cannot be empty");
  }
  if (!args.constraints.trim()) {
    throw new Error("constraints is required and cannot be empty");
  }

  const systemPrompt = await promptService.load("prompt-engineer");

  const parts: string[] = [
    `## Goal\n${args.goal}`,
    `## Constraints\n${args.constraints}`,
    `## Context\n${args.context}`,
  ];

  if (args.current_prompt.trim()) {
    parts.push(`## Current Prompt\n\`\`\`\n${args.current_prompt}\n\`\`\``);
  }

  if (args.feedback.trim()) {
    parts.push(`## Feedback\n${args.feedback}`);
  }

  const userPrompt = parts.join("\n\n");

  const result = await llm.completion({
    model: systemPrompt.model ?? "gpt-4.1",
    systemPrompt: systemPrompt.content,
    userPrompt,
    ...(systemPrompt.temperature !== undefined && {
      temperature: systemPrompt.temperature,
    }),
  });

  // Strip markdown code fences if present (LLMs often wrap JSON in ```json ... ```)
  const cleaned = result.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const parsed = safeParse<Record<string, unknown>>(cleaned, "prompt_engineer response");

  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    throw new Error("LLM did not return a valid prompt field. Try again with more specific goal and constraints.");
  }

  const text = JSON.stringify({
    prompt: parsed.prompt,
    token_estimate: parsed.token_estimate ?? null,
    reasoning: parsed.reasoning ?? null,
  });

  return createDocument(text, `Engineered prompt for: ${args.goal.slice(0, 80)}`, {
    source: null,
    type: "document",
    mimeType: "application/json",
  }, getSessionId());
}

export default {
  name: "prompt_engineer",
  handler: promptEngineer,
} satisfies ToolDefinition;
