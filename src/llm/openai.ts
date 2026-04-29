import OpenAI, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
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
import { DomainError, isDomainError } from "../types/errors.ts";

/**
 * Map an unknown OpenAI SDK error to a DomainError.
 * Recognises the SDK's error class hierarchy and maps each to a domain category.
 * Re-passes existing DomainErrors unchanged.
 */
export function toOpenAIDomainError(err: unknown): DomainError {
  if (isDomainError(err)) return err;

  if (err instanceof APIConnectionTimeoutError) {
    return new DomainError({
      type: "timeout",
      message: "OpenAI request timed out",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof RateLimitError) {
    const code = (err as { code?: string }).code;
    if (code === "insufficient_quota") {
      return new DomainError({
        type: "auth",
        message: "OpenAI quota exhausted",
        internalMessage: err.message,
        cause: err,
      });
    }
    return new DomainError({
      type: "capacity",
      message: "OpenAI rate limit reached",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof AuthenticationError) {
    return new DomainError({
      type: "auth",
      message: "OpenAI authentication failed",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof PermissionDeniedError) {
    return new DomainError({
      type: "permission",
      message: "OpenAI permission denied",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof BadRequestError) {
    return new DomainError({
      type: "validation",
      message: "OpenAI rejected the request",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof NotFoundError) {
    return new DomainError({
      type: "not_found",
      message: "OpenAI resource not found",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof ConflictError) {
    return new DomainError({
      type: "conflict",
      message: "OpenAI request conflicted with provider state",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof APIConnectionError) {
    return new DomainError({
      type: "provider",
      provider: "openai",
      message: "OpenAI connection failed",
      internalMessage: err.message,
      cause: err,
    });
  }

  if (err instanceof APIError) {
    return new DomainError({
      type: "provider",
      provider: "openai",
      message: "OpenAI provider error",
      internalMessage: err.message,
      cause: err,
    });
  }

  const message = err instanceof Error ? err.message : "Unknown OpenAI adapter failure";
  return new DomainError({
    type: "provider",
    provider: "openai",
    message: "OpenAI provider error",
    internalMessage: message,
    cause: err,
  });
}

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
      try {
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
      } catch (err) {
        throw toOpenAIDomainError(err);
      }
    },

    async completion(params: CompletionParams): Promise<string> {
      try {
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
      } catch (err) {
        throw toOpenAIDomainError(err);
      }
    },
  };
}
