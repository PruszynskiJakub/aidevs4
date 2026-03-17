import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { ConsoleLogger } from "./console-logger.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

describe("ConsoleLogger", () => {
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

  describe("info/success/error/debug color codes", () => {
    it("info prints with cyan color", () => {
      const logger = new ConsoleLogger();
      logger.info("hello");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain(CYAN);
      expect(captured[0]).toContain("hello");
      expect(captured[0]).toContain(RESET);
    });

    it("success prints with green color", () => {
      const logger = new ConsoleLogger();
      logger.success("done");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain(GREEN);
      expect(captured[0]).toContain("done");
      expect(captured[0]).toContain(RESET);
    });

    it("error prints with red color", () => {
      const logger = new ConsoleLogger();
      logger.error("fail");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain(RED);
      expect(captured[0]).toContain("fail");
      expect(captured[0]).toContain(RESET);
    });

    it("debug prints with dim color", () => {
      const logger = new ConsoleLogger();
      logger.debug("trace");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain(DIM);
      expect(captured[0]).toContain("trace");
      expect(captured[0]).toContain(RESET);
    });
  });

  describe("step", () => {
    it("prints iteration info with model and message count", () => {
      const logger = new ConsoleLogger();
      logger.step(1, 10, "gpt-4o", 5);
      // step prints 3 lines: empty, BAR, step info, BAR
      expect(captured.length).toBeGreaterThanOrEqual(3);
      const stepLine = captured.find((l) => l.includes("Step 1/10"));
      expect(stepLine).toBeDefined();
      expect(stepLine).toContain("gpt-4o");
      expect(stepLine).toContain("5 msgs");
      expect(stepLine).toContain(BOLD);
    });
  });

  describe("toolCall", () => {
    it("prints tool name and summarized args", () => {
      const logger = new ConsoleLogger();
      logger.toolCall("my_tool", JSON.stringify({ key: "value" }));
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("my_tool");
      expect(captured[0]).toContain("key");
      expect(captured[0]).toContain("value");
    });

    it("truncates long arg values using truncateArgs option", () => {
      const logger = new ConsoleLogger({ truncateArgs: 10 });
      const longValue = "a".repeat(50);
      logger.toolCall("my_tool", JSON.stringify({ key: longValue }));
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("my_tool");
      // value should be truncated to 10 chars + ellipsis
      expect(captured[0]).toContain("aaaaaaaaaa…");
      expect(captured[0]).not.toContain("a".repeat(50));
    });
  });

  describe("toolOk", () => {
    it("prints green checkmark with name and elapsed", () => {
      const logger = new ConsoleLogger();
      logger.toolOk("my_tool", "1.23s", JSON.stringify({ status: "ok" }));
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const line = captured[0];
      expect(line).toContain(GREEN);
      expect(line).toContain("my_tool");
      expect(line).toContain("1.23s");
    });

    it("truncates result using truncateResult option", () => {
      const logger = new ConsoleLogger({ truncateResult: 10 });
      const longStr = "x".repeat(200);
      logger.toolOk("my_tool", "1.00s", JSON.stringify({ data: longStr }));
      // find the summary line
      const summaryLine = captured.find((l) => l.includes("data"));
      expect(summaryLine).toBeDefined();
      expect(summaryLine).not.toContain("x".repeat(50));
    });
  });

  describe("toolErr", () => {
    it("prints red error with tool name and message", () => {
      const logger = new ConsoleLogger();
      logger.toolErr("broken_tool", "something went wrong");
      expect(captured.length).toBeGreaterThanOrEqual(2);
      const nameLine = captured[0];
      const errLine = captured[1];
      expect(nameLine).toContain(RED);
      expect(nameLine).toContain("broken_tool");
      expect(errLine).toContain(RED);
      expect(errLine).toContain("something went wrong");
    });
  });

  describe("log level filtering", () => {
    it("debug is suppressed at level=info", () => {
      const logger = new ConsoleLogger({ level: "info" });
      logger.debug("trace msg");
      expect(captured).toHaveLength(0);
    });

    it("info is shown at level=info", () => {
      const logger = new ConsoleLogger({ level: "info" });
      logger.info("info msg");
      expect(captured).toHaveLength(1);
    });

    it("debug is suppressed at level=warn", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.debug("trace msg");
      expect(captured).toHaveLength(0);
    });

    it("info is suppressed at level=warn", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.info("info msg");
      expect(captured).toHaveLength(0);
    });

    it("success is suppressed at level=warn (maps to info level)", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.success("done");
      expect(captured).toHaveLength(0);
    });

    it("error is shown at level=warn", () => {
      const logger = new ConsoleLogger({ level: "warn" });
      logger.error("error msg");
      expect(captured).toHaveLength(1);
    });

    it("debug is shown at level=debug", () => {
      const logger = new ConsoleLogger({ level: "debug" });
      logger.debug("trace msg");
      expect(captured).toHaveLength(1);
    });
  });

  describe("agent-loop methods always shown regardless of level", () => {
    it("step is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.step(1, 10, "gpt-4o", 3);
      expect(captured.length).toBeGreaterThan(0);
    });

    it("llm is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.llm("0.50s");
      expect(captured).toHaveLength(1);
    });

    it("toolHeader is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.toolHeader(2);
      expect(captured).toHaveLength(1);
    });

    it("toolCall is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.toolCall("my_tool", "{}");
      expect(captured).toHaveLength(1);
    });

    it("toolOk is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.toolOk("my_tool", "1.00s", "{}");
      expect(captured.length).toBeGreaterThan(0);
    });

    it("answer is shown at level=error", () => {
      const logger = new ConsoleLogger({ level: "error" });
      logger.answer("final answer");
      expect(captured.length).toBeGreaterThan(0);
      const answerLine = captured.find((l) => l.includes("final answer"));
      expect(answerLine).toBeDefined();
    });
  });

  describe("configurable truncation defaults", () => {
    it("uses default truncateArgs of 50", () => {
      const logger = new ConsoleLogger();
      const value = "a".repeat(60);
      logger.toolCall("my_tool", JSON.stringify({ key: value }));
      expect(captured[0]).toContain("…");
      // Should be truncated at 50
      expect(captured[0]).not.toContain("a".repeat(51));
    });

    it("truncateArgs option respected", () => {
      const logger = new ConsoleLogger({ truncateArgs: 5 });
      const value = "abcdefghij";
      logger.toolCall("my_tool", JSON.stringify({ key: value }));
      expect(captured[0]).toContain("abcde…");
    });
  });
});
