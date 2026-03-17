# SP-25 LLM Provider Abstraction

## Main objective

Decouple the application from specific LLM SDK details by introducing a
provider registry with model-string routing and multimodal support, so that
tools and the agent resolve the correct provider automatically by model name.

## Context

The codebase has a clean `LLMProvider` interface (`types/llm.ts`) with a single
OpenAI implementation (`services/llm.ts`). The agent accepts `LLMProvider` via
dependency injection — well-designed.

However, two problems exist:

1. **Gemini SDK leak** — `document_processor.ts` imports `@google/genai` directly
   because the abstraction only supports text content. There is no way to send
   images through `LLMProvider`.
2. **No provider routing** — model names like `gpt-4.1` and `gemini-2.5-flash`
   are strings, but nothing maps them to the right SDK. If a tool or prompt
   specifies a Gemini model, the call still goes to OpenAI and fails.
3. **Singleton coupling** — `think.ts` and `utils/llm.ts` import a hardcoded
   OpenAI singleton. There's no way for them to use a different provider without
   code changes.

The fix: a **provider registry** that maps model-name patterns to provider
implementations, with a `resolve(model)` method that returns the correct
`LLMProvider`. Extend the message types to support multimodal content so
`document_processor` can go through the same abstraction.

## Out of scope

- Streaming / SSE support — add later when needed
- Anthropic provider — add when a task requires it; the registry makes this trivial
- Retry / fallback logic — separate concern (wrap providers with decorators later)
- Changing the tool handler signature (no DI via context) — tools resolve from
  the global registry directly
- Prompt service changes — it already returns model strings, which is exactly
  what the registry needs

## Constraints

- Zero breaking changes to existing tool handler signatures (`(args: any) => Promise<unknown>`)
- `types/llm.ts` must remain SDK-free (no imports from `openai` or `@google/genai`)
- Each provider adapter lives in its own file under `src/providers/`
- Provider SDKs are lazy-loaded: if `GEMINI_API_KEY` is unset, the Gemini
  provider is not instantiated
- Model routing must be configurable at startup, not hardcoded in the registry
- Existing tests must continue to pass without modification (agent tests mock
  `LLMProvider` directly, which remains unchanged)

## Acceptance criteria

- [ ] `LLMMessage` content supports both `string` and `ContentPart[]` (text +
      image parts) — backward-compatible (string still works everywhere)
- [ ] `LLMProvider` interface gains a `multimodalCompletion()` method (or
      `chatCompletion` accepts multimodal messages) for sending image+text
- [ ] `src/providers/openai.ts` implements `LLMProvider` — extracted from
      current `services/llm.ts`
- [ ] `src/providers/gemini.ts` implements `LLMProvider` — supports text and
      multimodal (vision) calls
- [ ] Provider registry exists at `src/services/provider-registry.ts` with:
  - `register(pattern: string | RegExp, provider: LLMProvider)` — register a
    provider for a model-name pattern
  - `resolve(model: string): LLMProvider` — returns first matching provider,
    throws if none match
- [ ] Default registry is configured at startup, mapping `gpt-*` / `o*` → OpenAI,
      `gemini-*` → Gemini (only if API key is set)
- [ ] `services/llm.ts` singleton `llm` is replaced by (or delegates to) the
      registry — `llm.chatCompletion({ model: "gemini-2.5-flash", ... })` routes
      to Gemini automatically
- [ ] `document_processor.ts` uses the provider abstraction instead of importing
      `@google/genai` directly
- [ ] `think.ts` and `utils/llm.ts` use the registry-backed `llm` — no behavior
      change, but now routable
- [ ] `agent.ts` continues to work unchanged (it already calls `provider.chatCompletion`)
- [ ] All existing tests pass
- [ ] New tests cover: provider registration, model-string routing, unknown model
      error, multimodal message conversion for both OpenAI and Gemini adapters

## Implementation plan

1. **Extend `types/llm.ts` with multimodal content types**
   - Add `ContentPart` union: `TextPart | ImagePart`
     ```ts
     interface TextPart { type: "text"; text: string }
     interface ImagePart { type: "image"; data: string; mimeType: string }
     ```
   - Change `LLMUserMessage.content` to `string | ContentPart[]`
   - Keep `LLMSystemMessage.content` as `string` (systems are text-only)
   - `LLMAssistantMessage.content` stays `string | null` (responses are text)

2. **Extract OpenAI adapter to `src/providers/openai.ts`**
   - Move `toOpenAIMessages()`, `toOpenAITools()`, `toResponse()`,
     `createOpenAIProvider()` from `services/llm.ts` to `providers/openai.ts`
   - Update message conversion to handle `ContentPart[]` → OpenAI's
     `content: [{type: "text", text: ...}, {type: "image_url", ...}]` format
   - Export `createOpenAIProvider(client?: OpenAI): LLMProvider`

3. **Create Gemini adapter at `src/providers/gemini.ts`**
   - Implement `createGeminiProvider(apiKey: string): LLMProvider`
   - Map `LLMMessage` → Gemini `Content[]` format
   - Map `ContentPart[]` → Gemini `Part[]` (text + inline image data)
   - Handle tool calling format differences (Gemini function calling ↔
     `LLMToolCall`)
   - `completion()` — simple text-in/text-out via `generateContent`
   - `chatCompletion()` — full chat with tool support via `generateContent`
     with tool declarations
   - Respect `AbortSignal.timeout(GEMINI_TIMEOUT)` as today

4. **Create provider registry at `src/services/provider-registry.ts`**
   ```ts
   class ProviderRegistry implements LLMProvider {
     register(pattern: string | RegExp, provider: LLMProvider): void
     resolve(model: string): LLMProvider
     // LLMProvider methods delegate: extract model → resolve → forward
     chatCompletion(params): Promise<LLMChatResponse>
     completion(params): Promise<string>
   }
   ```
   - Pattern matching: string patterns use `startsWith` / glob-style,
     RegExp for complex cases
   - Order matters: first match wins
   - `resolve()` throws descriptive error if no provider matches
   - The registry itself implements `LLMProvider` so it's a drop-in
     replacement for the singleton

5. **Configure default registry at `src/services/llm.ts`**
   - Create and configure the registry:
     ```ts
     const registry = new ProviderRegistry();
     registry.register("gpt-", createOpenAIProvider());
     registry.register("o", createOpenAIProvider());  // o1, o3, etc.
     if (process.env.GEMINI_API_KEY) {
       registry.register("gemini-", createGeminiProvider(process.env.GEMINI_API_KEY));
     }
     export const llm: LLMProvider = registry;
     ```
   - The export signature stays `LLMProvider` — all existing imports work

6. **Migrate `document_processor.ts`**
   - Remove `@google/genai` import
   - Import `llm` from `services/llm.ts`
   - Build `LLMMessage` with `ContentPart[]` for images + text
   - Call `llm.chatCompletion({ model: GEMINI_MODEL, messages, ... })`
   - Delete the `buildContentParts()` helper (replaced by type-level content parts)

7. **Verify `think.ts` and `utils/llm.ts`**
   - No code changes needed — they already import `llm` and pass model strings
   - Confirm routing works: `gpt-4.1` → OpenAI, any future Gemini model → Gemini

8. **Write tests**
   - `providers/openai.test.ts` — message/tool conversion, multimodal mapping
   - `providers/gemini.test.ts` — message conversion, multimodal, tool call mapping
   - `services/provider-registry.test.ts` — registration, resolution, unknown model error,
     pattern priority, LLMProvider delegation
   - `document_processor.test.ts` — update to mock `llm` instead of Gemini SDK
   - Run full `bun test` to verify no regressions

## Testing scenarios

| Criterion | Test |
|-----------|------|
| Multimodal content types | Unit: create `LLMUserMessage` with `ContentPart[]`, pass through OpenAI and Gemini adapters, verify SDK-specific format |
| OpenAI adapter | Unit: mock `openai.chat.completions.create`, verify message/tool conversion round-trips |
| Gemini adapter | Unit: mock `GoogleGenAI.models.generateContent`, verify text + image parts, tool call extraction |
| Registry routing | Unit: register two providers with different patterns, verify `resolve()` returns correct one |
| Unknown model error | Unit: call `resolve("claude-3")` with no matching pattern → throws |
| Registry as LLMProvider | Unit: call `registry.chatCompletion()` → delegates to resolved provider |
| document_processor migration | Unit: mock `llm.chatCompletion`, call `ask()` with image paths, verify multimodal message built correctly |
| Lazy loading | Unit: no `GEMINI_API_KEY` → Gemini not registered, `resolve("gemini-*")` throws helpful error |
| Existing tests pass | Integration: `bun test` green with no test modifications |
