import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMChatResponse,
  LLMProvider,
  ChatCompletionParams,
  CompletionParams,
} from "../types/llm.ts";

function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system" as const, content: msg.content };
      case "user":
        return { role: "user" as const, content: msg.content };
      case "assistant":
        return {
          role: "assistant" as const,
          content: msg.content,
          ...(msg.toolCalls?.length && {
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          }),
        };
      case "tool":
        return {
          role: "tool" as const,
          tool_call_id: msg.toolCallId,
          content: msg.content,
        };
    }
  });
}

function toOpenAITools(tools: LLMTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: t.function.strict,
    },
  }));
}

function toResponse(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
  usage?: OpenAI.Chat.Completions.ChatCompletion["usage"],
): LLMChatResponse {
  const msg = choice.message;
  const toolCalls: LLMToolCall[] = (msg.tool_calls ?? [])
    .filter((tc) => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

  return {
    content: msg.content,
    toolCalls,
    finishReason: choice.finish_reason ?? "stop",
    ...(usage && {
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      },
    }),
  };
}

export function createOpenAIProvider(client?: OpenAI): LLMProvider {
  const openai = client ?? new OpenAI();

  return {
    async chatCompletion(params: ChatCompletionParams): Promise<LLMChatResponse> {
      const response = await openai.chat.completions.create({
        model: params.model,
        messages: toOpenAIMessages(params.messages),
        ...(params.tools?.length && { tools: toOpenAITools(params.tools) }),
        ...(params.temperature !== undefined && { temperature: params.temperature }),
      });

      return toResponse(response.choices[0], response.usage);
    },

    async completion(params: CompletionParams): Promise<string> {
      const response = await openai.chat.completions.create({
        model: params.model,
        temperature: params.temperature ?? 0,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
      });

      return response.choices[0].message.content ?? "";
    },
  };
}

export const llm: LLMProvider = createOpenAIProvider();
