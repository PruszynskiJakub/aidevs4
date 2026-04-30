// Provider-agnostic LLM types — no SDK imports allowed here

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  data: string; // base64-encoded
  mimeType: string;
}

export interface ResourceRef {
  type: "resource";
  path: string;
  description: string;
  mimeType?: string;
}

export type ContentPart = TextPart | ImagePart | ResourceRef;

export interface LLMSystemMessage {
  role: "system";
  content: string;
}

export interface LLMUserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface LLMAssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type LLMMessage =
  | LLMSystemMessage
  | LLMUserMessage
  | LLMAssistantMessage
  | LLMToolResultMessage;

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /** Opaque provider-specific data (e.g. Gemini thoughtSignature) that must
   *  be preserved when replaying the conversation back to the same provider. */
  providerMetadata?: Record<string, unknown>;
}

export interface LLMChatResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ChatCompletionParams {
  model: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface LLMProvider {
  chatCompletion(params: ChatCompletionParams): Promise<LLMChatResponse>;
  completion(params: CompletionParams): Promise<string>;
}
