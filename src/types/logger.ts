export type LogLevel = "debug" | "info" | "error";

export interface GeneralLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface AgentLogger {
  step(iter: number, max: number, model: string, msgCount: number): void;
  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void;
  toolHeader(count: number): void;
  toolCall(name: string, rawArgs: string): void;
  toolOk(name: string, elapsed: string, rawResult: string): void;
  toolErr(name: string, errorMsg: string): void;
  batchDone(count: number, elapsed: string): void;
  answer(text: string | null): void;
  maxIter(max: number): void;
  memoryObserve(tokensBefore: number, tokensAfter: number): void;
  memoryReflect(level: number, tokensBefore: number, tokensAfter: number): void;
}

export interface Logger extends GeneralLogger, AgentLogger {}

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  truncateArgs?: number;
  truncateResult?: number;
}

export interface JsonlWriter {
  /** Wildcard listener — pass to bus.onAny(). */
  listener: import("./events.ts").WildcardListener;
  /** Wait for all pending writes to complete. */
  flush(): Promise<void>;
  /** Detach the beforeExit handler. Call in tests / on shutdown. */
  dispose(): void;
}
