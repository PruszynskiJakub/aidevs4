import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { llm } from "../llm/llm.ts";
import { promptService } from "../llm/prompt.ts";
import { config } from "../config/index.ts";
import { assertMaxLength, safeParse } from "../utils/parse.ts";

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
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const typedArgs = args as unknown as PromptEngineerArgs;
  assertMaxLength(typedArgs.goal, "goal", MAX_GOAL);
  assertMaxLength(typedArgs.constraints, "constraints", MAX_CONSTRAINTS);
  assertMaxLength(typedArgs.context, "context", MAX_CONTEXT);
  assertMaxLength(typedArgs.current_prompt, "current_prompt", MAX_PROMPT);
  assertMaxLength(typedArgs.feedback, "feedback", MAX_FEEDBACK);

  if (!typedArgs.goal.trim()) {
    throw new Error("goal is required and cannot be empty");
  }
  if (!typedArgs.constraints.trim()) {
    throw new Error("constraints is required and cannot be empty");
  }

  const systemPrompt = await promptService.load("prompt-engineer");

  const parts: string[] = [
    `## Goal\n${typedArgs.goal}`,
    `## Constraints\n${typedArgs.constraints}`,
    `## Context\n${typedArgs.context}`,
  ];

  if (typedArgs.current_prompt.trim()) {
    parts.push(`## Current Prompt\n\`\`\`\n${typedArgs.current_prompt}\n\`\`\``);
  }

  if (typedArgs.feedback.trim()) {
    parts.push(`## Feedback\n${typedArgs.feedback}`);
  }

  const userPrompt = parts.join("\n\n");

  const result = await llm.completion({
    model: systemPrompt.model ?? config.models.agent,
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

  const output = JSON.stringify({
    prompt: parsed.prompt,
    token_estimate: parsed.token_estimate ?? null,
    reasoning: parsed.reasoning ?? null,
  });

  return text(output);
}

export default {
  name: "prompt_engineer",
  schema: {
    name: "prompt_engineer",
    description: "Craft or refine prompts for external LLMs with specific constraints. Use when you need to create a prompt that fits within a token budget, produces a specific output format, or handles edge cases. Supports iterative refinement — pass the current prompt and feedback to improve it. Returns the crafted or refined prompt text ready for use with the target LLM.",
    schema: z.object({
      goal: z.string().describe("What the prompt should accomplish. Be specific about the task, expected input, and desired output format."),
      constraints: z.string().describe("Hard constraints: token limit, output format (e.g. 'respond with DNG or NEU only'), language requirements, model limitations."),
      context: z.string().describe("Relevant context: sample data, known edge cases, exceptions to standard rules, placeholders available (e.g. {id}, {description})."),
      current_prompt: z.string().describe("The current prompt to refine. Empty string if crafting from scratch."),
      feedback: z.string().describe("What went wrong with the current prompt — which cases failed and why. Empty string if crafting from scratch."),
    }),
  },
  handler: promptEngineer,
} satisfies ToolDefinition;
