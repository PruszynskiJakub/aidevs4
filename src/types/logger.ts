export type LogLevel = "debug" | "info" | "warn" | "error";

export interface GeneralLogger {
  info(message: string): void;
  success(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface Logger extends GeneralLogger {
  step(iter: number, max: number, model: string, msgCount: number): void;
  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void;
  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void;
  toolHeader(count: number): void;
  toolCall(name: string, rawArgs: string): void;
  toolOk(name: string, elapsed: string, rawResult: string): void;
  toolErr(name: string, errorMsg: string): void;
  batchDone(count: number, elapsed: string): void;
  answer(text: string | null): void;
  maxIter(max: number): void;
}
