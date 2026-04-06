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
  ContentPart,
} from "../types/llm.ts";
import { config } from "../config/index.ts";

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function contentToOpenAI(content: string | ContentPart[]): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type !== "resource")
    .map((part): OpenAIContentPart => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      return {
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      };
    });
}

function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system" as const, content: msg.content };
      case "user":
        return { role: "user" as const, content: contentToOpenAI(msg.content) };
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
  const openai = client ?? new OpenAI({ maxRetries: config.retry.openaiMaxRetries });

  return {
    async chatCompletion(params: ChatCompletionParams): Promise<LLMChatResponse> {
      const response = await openai.chat.completions.create(
        {
          model: params.model,
          messages: toOpenAIMessages(params.messages),
          ...(params.tools?.length && { tools: toOpenAITools(params.tools) }),
          ...(params.temperature !== undefined && { temperature: params.temperature }),
          ...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
        },
        { signal: AbortSignal.timeout(config.limits.openaiTimeout) },
      );

      return toResponse(response.choices[0], response.usage);
    },

    async completion(params: CompletionParams): Promise<string> {
      const response = await openai.chat.completions.create(
        {
          model: params.model,
          temperature: params.temperature ?? 0,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userPrompt },
          ],
        },
        { signal: AbortSignal.timeout(config.limits.openaiTimeout) },
      );

      return response.choices[0].message.content ?? "";
    },
  };
}
