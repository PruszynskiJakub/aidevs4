import { describe, it, expect, afterAll } from "bun:test";
import { join } from "path";
import { unlinkSync } from "fs";
import filesystem from "./filesystem.ts";

const tmpFile = join(import.meta.dir, `__filesystem-test-${Date.now()}.txt`);
afterAll(() => { try { unlinkSync(tmpFile); } catch {} });

describe("filesystem", () => {
  describe("read_file", () => {
    it("reads file content", async () => {
      const content = "hello\nworld";
      await Bun.write(tmpFile, content);

      const result = (await filesystem.handler({
        action: "read_file",
        payload: { path: tmpFile },
      })) as { path: string; content: string };

      expect(result.path).toBe(tmpFile);
      expect(result.content).toBe(content);
    });

    it("truncates with max_lines", async () => {
      const content = "a\nb\nc\nd\ne";
      await Bun.write(tmpFile, content);

      const result = (await filesystem.handler({
        action: "read_file",
        payload: { path: tmpFile, max_lines: 2 },
      })) as any;

      expect(result.content).toBe("a\nb");
      expect(result.truncated).toBe(true);
      expect(result.total_lines).toBe(5);
      expect(result.returned_lines).toBe(2);
    });

    it("throws on missing file", async () => {
      await expect(
        filesystem.handler({
          action: "read_file",
          payload: { path: "/nonexistent/file.txt" },
        }),
      ).rejects.toThrow();
    });
  });

  it("rejects unknown actions", async () => {
    await expect(
      filesystem.handler({ action: "bogus", payload: {} }),
    ).rejects.toThrow('Unknown action "bogus"');
  });
});
