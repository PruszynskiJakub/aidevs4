import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { log, elapsed, duration } from "./logger.ts";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

describe("logger singleton", () => {
  let spy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("log.info prints with cyan prefix", () => {
    log.info("hello");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(CYAN);
    expect(captured[0]).toContain("hello");
    expect(captured[0]).toContain(RESET);
  });

  it("log.success prints with green prefix", () => {
    log.success("done");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(GREEN);
    expect(captured[0]).toContain("done");
  });

  it("log.error prints with red prefix", () => {
    log.error("fail");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(RED);
    expect(captured[0]).toContain("fail");
  });

  it("log.debug prints with dim prefix", () => {
    log.debug("trace");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(DIM);
    expect(captured[0]).toContain("trace");
  });
});

describe("elapsed", () => {
  it("returns formatted elapsed time", () => {
    const start = performance.now() - 1500;
    const result = elapsed(start);
    expect(result).toMatch(/^\d+\.\d{2}s$/);
    const seconds = parseFloat(result);
    expect(seconds).toBeGreaterThan(1.0);
    expect(seconds).toBeLessThan(3.0);
  });

  it("duration is an alias for elapsed", () => {
    expect(duration).toBe(elapsed);
  });
});
