import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration, Part, Tool } from "@google/genai";
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

function findToolCallName(messages: LLMMessage[], toolCallId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.toolCalls) {
      const tc = m.toolCalls.find((t) => t.id === toolCallId);
      if (tc) return tc.function.name;
    }
  }
  return undefined;
}

function contentPartsToGemini(content: string | ContentPart[]): Part[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content
    .filter((part) => part.type !== "resource")
    .map((part): Part => {
      if (part.type === "text") {
        return { text: part.text };
      }
      return { inlineData: { data: part.data, mimeType: part.mimeType } };
    });
}

function toGeminiContents(
  messages: LLMMessage[],
): { systemInstruction: string | undefined; contents: Content[] } {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        systemInstruction = msg.content;
        break;

      case "user":
        contents.push({
          role: "user",
          parts: contentPartsToGemini(msg.content),
        });
        break;

      case "assistant": {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
            parts.push({
              functionCall: {
                id: tc.id,
                name: tc.function.name,
                args,
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
        break;
      }

      case "tool": {
        let response: Record<string, unknown>;
        try { response = JSON.parse(msg.content); } catch { response = { result: msg.content }; }
        // Recover the function name from the preceding assistant message's tool calls
        const fnName = findToolCallName(messages, msg.toolCallId) ?? msg.toolCallId;
        contents.push({
          role: "user",
          parts: [{
            functionResponse: {
              id: msg.toolCallId,
              name: fnName,
              response,
            },
          }],
        });
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function toGeminiTools(tools: LLMTool[]): Tool[] {
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parametersJsonSchema: t.function.parameters,
  }));
  return [{ functionDeclarations: declarations }];
}

function extractToolCalls(parts: Part[]): LLMToolCall[] {
  return parts
    .filter((p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } =>
      p.functionCall != null,
    )
    .map((p, idx) => ({
      id: p.functionCall.id ?? `gemini-tc-${idx}`,
      type: "function" as const,
      function: {
        name: p.functionCall.name ?? "",
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    }));
}

export function createGeminiProvider(apiKey: string): LLMProvider {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: { attempts: config.retry.geminiMaxAttempts },
    },
  });

  return {
    async chatCompletion(params: ChatCompletionParams): Promise<LLMChatResponse> {
      const { systemInstruction, contents } = toGeminiContents(params.messages);

      const response = await ai.models.generateContent({
        model: params.model,
        contents,
        config: {
          ...(systemInstruction && { systemInstruction }),
          ...(params.temperature !== undefined && { temperature: params.temperature }),
          ...(params.maxTokens !== undefined && { maxOutputTokens: params.maxTokens }),
          ...(params.tools?.length && { tools: toGeminiTools(params.tools) }),
          abortSignal: AbortSignal.timeout(config.limits.geminiTimeout),
        },
      });

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      const textParts = parts.filter((p) => p.text != null);
      const content = textParts.length > 0
        ? textParts.map((p) => p.text).join("")
        : null;

      const toolCalls = extractToolCalls(parts);

      const usage = response.usageMetadata;

      return {
        content,
        toolCalls,
        finishReason: candidate?.finishReason ?? "stop",
        ...(usage && {
          usage: {
            promptTokens: usage.promptTokenCount ?? 0,
            completionTokens: usage.candidatesTokenCount ?? 0,
          },
        }),
      };
    },

    async completion(params: CompletionParams): Promise<string> {
      const response = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
        config: {
          systemInstruction: params.systemPrompt,
          temperature: params.temperature ?? 0,
          abortSignal: AbortSignal.timeout(config.limits.geminiTimeout),
        },
      });

      return response.text ?? "";
    },
  };
}
