/**
 * Composition root for the agent system.
 *
 * `Runtime` is the typed bag of services every layer ultimately needs.
 * It replaces the constellation of module-level singletons (`bus`,
 * `llm`, `sandbox`, `sessionService`, `agentsService`) that are currently
 * imported ad-hoc across `src/agent/`, `src/infra/`, `src/tools/`.
 *
 * This file intentionally does NOT wire `Runtime` into any caller. It only
 * defines the shape and the factory. Wiring lands incrementally:
 *   1. Entry points (`cli.ts`, `server.ts`, `slack.ts`) build a runtime once.
 *   2. `runAgent(state, runtime)` and `executeRun(opts, runtime)` accept it.
 *   3. `dispatch` and tool handlers receive it as a parameter.
 *
 * No `runtime.get("name")` lookups. Every service is a typed field — if it
 * isn't on the type, it isn't on the runtime.
 */

import type { LLMProvider } from "./types/llm.ts";
import type { FileProvider } from "./types/file.ts";
import type { EventBus } from "./types/events.ts";
import { config as defaultConfig } from "./config/index.ts";

type AppConfig = typeof defaultConfig;
import { llm as defaultLlm, createLlmService } from "./llm/llm.ts";
import { sandbox as defaultSandbox, createSandbox } from "./infra/sandbox.ts";
import { bus as defaultBus, createEventBus } from "./infra/events.ts";
import { sessionService as defaultSessionService, createSessionService, type SessionService } from "./agent/session.ts";
import { agentsService as defaultAgentsService, makeAgentsService } from "./agent/agents.ts";

type AgentsService = ReturnType<typeof makeAgentsService>;

export interface Runtime {
  config: AppConfig;
  llm: LLMProvider;
  files: FileProvider;
  bus: EventBus;
  sessions: SessionService;
  agents: AgentsService;
}

export interface RuntimeOverrides {
  config?: AppConfig;
  llm?: LLMProvider;
  files?: FileProvider;
  bus?: EventBus;
  sessions?: SessionService;
  agents?: AgentsService;
}

/**
 * Build a runtime from the existing process-singleton factories.
 * Pass overrides to swap individual services (tests, alternate transports).
 */
export function createRuntime(overrides: RuntimeOverrides = {}): Runtime {
  return {
    config: overrides.config ?? defaultConfig,
    llm: overrides.llm ?? defaultLlm,
    files: overrides.files ?? defaultSandbox,
    bus: overrides.bus ?? defaultBus,
    sessions: overrides.sessions ?? defaultSessionService,
    agents: overrides.agents ?? defaultAgentsService,
  };
}

/**
 * Build a fully isolated runtime — no shared singletons. Use in tests where
 * a previous test's bus listeners or session map would otherwise leak.
 */
export function createIsolatedRuntime(overrides: RuntimeOverrides = {}): Runtime {
  return {
    config: overrides.config ?? defaultConfig,
    llm: overrides.llm ?? createLlmService(),
    files: overrides.files ?? createSandbox(),
    bus: overrides.bus ?? createEventBus(),
    sessions: overrides.sessions ?? createSessionService(),
    agents: overrides.agents ?? makeAgentsService(),
  };
}
