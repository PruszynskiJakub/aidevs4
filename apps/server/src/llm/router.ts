import type {
  LLMProvider,
  LLMChatResponse,
  ChatCompletionParams,
  CompletionParams,
} from "../types/llm.ts";
import { errorMessage } from "../utils/parse.ts";
import { bus } from "../infra/events.ts";
import { DomainError, isDomainError, type DomainErrorType } from "../types/errors.ts";

interface ProviderEntry {
  pattern: string | RegExp;
  provider: LLMProvider;
}

function matches(model: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return model.startsWith(pattern);
  }
  return pattern.test(model);
}

/**
 * An LLM error is "fatal" (will not succeed on retry) if its category is
 * one of: validation (bad request), auth (key/quota issue), permission,
 * not_found. Categories `capacity`, `provider`, `timeout`, `conflict` are
 * transient.
 */
const FATAL_TYPES: ReadonlySet<DomainErrorType> = new Set<DomainErrorType>([
  "validation",
  "auth",
  "permission",
  "not_found",
]);

export class ProviderRegistry implements LLMProvider {
  private entries: ProviderEntry[] = [];

  register(pattern: string | RegExp, provider: LLMProvider): void {
    this.entries.push({ pattern, provider });
  }

  resolve(model: string): LLMProvider {
    for (const entry of this.entries) {
      if (matches(model, entry.pattern)) {
        return entry.provider;
      }
    }

    const registered = this.entries
      .map((e) => (typeof e.pattern === "string" ? `"${e.pattern}"` : e.pattern.toString()))
      .join(", ");

    throw new DomainError({
      type: "validation",
      message: `No provider registered for model "${model}"`,
      internalMessage: `Registered patterns: ${registered || "(none)"}`,
    });
  }

  async chatCompletion(params: ChatCompletionParams): Promise<LLMChatResponse> {
    const provider = this.resolve(params.model);
    try {
      return await provider.chatCompletion(params);
    } catch (err) {
      this.emitCallFailed(params.model, err);
      throw err;
    }
  }

  async completion(params: CompletionParams): Promise<string> {
    const provider = this.resolve(params.model);
    try {
      return await provider.completion(params);
    } catch (err) {
      this.emitCallFailed(params.model, err);
      throw err;
    }
  }

  private emitCallFailed(model: string, err: unknown): void {
    const fatal = isDomainError(err) ? FATAL_TYPES.has(err.type) : false;
    const code = isDomainError(err) ? err.type : undefined;
    bus.emit("llm.call.failed", {
      model,
      error: errorMessage(err),
      fatal,
      code,
    });
  }
}
