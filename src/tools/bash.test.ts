import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { OUTPUT_DIR } from "../config.ts";
import bash from "./bash.ts";

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const result = await bash.handler({ command: "echo hello" });
    expect(result).toBe("hello");
  });

  it("reports non-zero exit codes without throwing", async () => {
    const result = await bash.handler({ command: "exit 42" });
    expect(result).toContain("[exit code 42]");
  });

  it("truncates output longer than 20,000 characters", async () => {
    const result = await bash.handler({ command: "seq 1 100000" });
    expect(result.length).toBeLessThanOrEqual(20_000 + "\n...(truncated)".length);
    expect(result).toEndWith("...(truncated)");
  });

  it("runs with CWD set to output directory", async () => {
    const result = await bash.handler({ command: "pwd" });
    expect(result).toBe(resolve(OUTPUT_DIR));
  });
});
