import { createOpenAIProvider } from "../../apps/server/src/providers/openai.ts";
import type { LLMMessage, LLMTool, LLMToolCall } from "../../apps/server/src/types/llm.ts";
import { $ } from "bun";

// ── Config ──────────────────────────────────────────────────────────
const MODEL = "gpt-4.1";
const MAX_ITERATIONS = 30;
const CWD = process.cwd();

const llm = createOpenAIProvider();

// ── Bash tool definition ────────────────────────────────────────────
const bashTool: LLMTool = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Execute a bash command and return its stdout/stderr. " +
      "Use this for all file operations: listing, reading, writing, moving, " +
      "searching, creating directories, etc. " +
      "Commands run in the working directory unless an absolute path is used.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
};

const tools: LLMTool[] = [bashTool];

// ── Tool executor ───────────────────────────────────────────────────
async function executeBash(command: string): Promise<string> {
  try {
    const result = await $`bash -c ${command}`.cwd(CWD).quiet().nothrow();
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    const output = [stdout, stderr].filter(Boolean).join("\n");

    if (result.exitCode !== 0) {
      return `[exit code ${result.exitCode}]\n${output}`;
    }
    return output || "(no output)";
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function dispatch(name: string, argsJson: string): Promise<string> {
  if (name !== "bash") return JSON.stringify({ error: `Unknown tool: ${name}` });

  const { command } = JSON.parse(argsJson) as { command: string };
  console.log(`  $ ${command}`);
  const result = await executeBash(command);
  // Truncate very long outputs
  if (result.length > 20_000) {
    return result.slice(0, 20_000) + "\n...(truncated)";
  }
  return result;
}

// ── System prompt ───────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an autonomous AI agent with access to a bash tool. You can execute any shell command to accomplish tasks.

## Capabilities
- Read, write, create, move, copy, and delete files and directories
- Search file contents with grep/ripgrep
- List directory structures with ls/find/tree
- Run scripts and programs
- Process text with sed, awk, jq, etc.
- Use git, curl, and other CLI tools

## Guidelines
- Break complex tasks into small steps
- Verify results after each step (e.g., check file exists after creating it)
- Use absolute paths when possible to avoid confusion
- For large files, read only what you need (head, tail, grep)
- When modifying files, show a diff or re-read to confirm changes
- If a command fails, analyze the error and try an alternative approach
- Current working directory: ${CWD}`;

// ── Agent loop ──────────────────────────────────────────────────────
async function runAgent(userPrompt: string) {
  console.log(`\n🤖 Agent started | model=${MODEL} | cwd=${CWD}`);
  console.log(`📝 Task: ${userPrompt}\n`);

  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`── Step ${i + 1}/${MAX_ITERATIONS} ──`);

    const response = await llm.chatCompletion({
      model: MODEL,
      messages,
      tools,
    });

    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length && { toolCalls: response.toolCalls }),
    });

    // Done — no more tool calls
    if (response.finishReason === "stop" || !response.toolCalls.length) {
      console.log(`\n✅ Agent finished\n`);
      console.log(response.content ?? "(no response)");
      return;
    }

    // Execute tool calls
    const functionCalls = response.toolCalls.filter(
      (tc: LLMToolCall) => tc.type === "function",
    );

    for (const tc of functionCalls) {
      const result = await dispatch(tc.function.name, tc.function.arguments);
      const preview =
        result.length > 500 ? result.slice(0, 500) + "..." : result;
      console.log(`  → ${preview}\n`);

      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: result,
      });
    }
  }

  console.log(`\n⚠️  Max iterations (${MAX_ITERATIONS}) reached`);
}

// ── CLI ─────────────────────────────────────────────────────────────
if (import.meta.main) {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error("Usage: bun run playground/bash/bash.ts \"your prompt\"");
    process.exit(1);
  }
  await runAgent(prompt);
}

export { runAgent };
