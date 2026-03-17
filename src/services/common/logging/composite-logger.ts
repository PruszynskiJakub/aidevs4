import type { Logger } from "../../../types/logger.ts";

export class CompositeLogger implements Logger {
  constructor(private readonly targets: Logger[]) {}

  step(iter: number, max: number, model: string, msgCount: number): void {
    for (const t of this.targets) t.step(iter, max, model, msgCount);
  }

  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    for (const t of this.targets) t.llm(elapsed, tokensIn, tokensOut);
  }

  plan(planText: string, model: string, elapsed: string, tokensIn?: number, tokensOut?: number): void {
    for (const t of this.targets) t.plan(planText, model, elapsed, tokensIn, tokensOut);
  }

  toolHeader(count: number): void {
    for (const t of this.targets) t.toolHeader(count);
  }

  toolCall(name: string, rawArgs: string): void {
    for (const t of this.targets) t.toolCall(name, rawArgs);
  }

  toolOk(name: string, elapsed: string, rawResult: string, hints?: string[]): void {
    for (const t of this.targets) t.toolOk(name, elapsed, rawResult, hints);
  }

  toolErr(name: string, errorMsg: string): void {
    for (const t of this.targets) t.toolErr(name, errorMsg);
  }

  batchDone(count: number, elapsed: string): void {
    for (const t of this.targets) t.batchDone(count, elapsed);
  }

  answer(text: string | null): void {
    for (const t of this.targets) t.answer(text);
  }

  maxIter(max: number): void {
    for (const t of this.targets) t.maxIter(max);
  }

  info(message: string): void {
    for (const t of this.targets) t.info(message);
  }

  success(message: string): void {
    for (const t of this.targets) t.success(message);
  }

  error(message: string): void {
    for (const t of this.targets) t.error(message);
  }

  debug(message: string): void {
    for (const t of this.targets) t.debug(message);
  }
}
