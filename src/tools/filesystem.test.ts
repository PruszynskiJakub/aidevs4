import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import filesystem from "./filesystem.ts";
import { ALLOWED_READ_PATHS } from "../config.ts";

const handler = filesystem.handler;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "filesystem-test-"));
  ALLOWED_READ_PATHS.push(tmp);

  await Bun.write(
    join(tmp, "people.csv"),
    "name,age,city\nAlice,30,Warsaw\nBob,25,Berlin\nCharlie,35,Warsaw\nDave,28,Paris\n",
  );

  await Bun.write(
    join(tmp, "items.json"),
    JSON.stringify([
      { id: 1, name: "Widget", price: 9.99 },
      { id: 2, name: "Gadget", price: 19.99 },
    ]),
  );

  await Bun.write(
    join(tmp, "config.json"),
    JSON.stringify({ host: "localhost", port: 3000, debug: true }),
  );

  await Bun.write(
    join(tmp, "readme.md"),
    [
      "# Title",
      "",
      "Some text with a [link](https://example.com) and another [link2](https://test.com).",
      "",
      "## Section",
      "",
      "```js",
      "console.log('hello');",
      "```",
      "",
      "### Subsection",
      "",
      "More text.",
    ].join("\n"),
  );

  const subdir = join(tmp, "mixed");
  await mkdir(subdir);
  await Bun.write(join(subdir, "data.csv"), "x,y\n1,2\n");
  await Bun.write(join(subdir, "info.json"), JSON.stringify([{ a: 1 }]));
  await Bun.write(join(subdir, "notes.md"), "# Notes\n");
  await Bun.write(join(subdir, "ignore.txt"), "not supported");

  const emptyDir = join(tmp, "empty");
  await mkdir(emptyDir);

  await Bun.write(join(tmp, "data.xml"), "<root/>");
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
});

describe("filesystem", () => {
  describe("inspect CSV", () => {
    it("returns rows, columns, and sample", async () => {
      const result = (await handler({ action: "inspect", payload: { path: join(tmp, "people.csv") } })) as any[];
      expect(result).toHaveLength(1);
      const r = result[0];
      expect(r.format).toBe("csv");
      expect(r.rows).toBe(4);
      expect(r.columns).toEqual(["name", "age", "city"]);
      expect(r.sample).toHaveLength(3);
      expect(r.sample[0].name).toBe("Alice");
    });
  });

  describe("inspect JSON array", () => {
    it("returns structure, count, schema, and sample", async () => {
      const result = (await handler({ action: "inspect", payload: { path: join(tmp, "items.json") } })) as any[];
      expect(result).toHaveLength(1);
      const r = result[0];
      expect(r.format).toBe("json");
      expect(r.structure).toBe("array");
      expect(r.count).toBe(2);
      expect(r.schema).toEqual([
        { key: "id", type: "number" },
        { key: "name", type: "string" },
        { key: "price", type: "number" },
      ]);
      expect(r.sample).toHaveLength(2);
    });
  });

  describe("inspect JSON object", () => {
    it("returns structure, count, schema, and sample", async () => {
      const result = (await handler({ action: "inspect", payload: { path: join(tmp, "config.json") } })) as any[];
      expect(result).toHaveLength(1);
      const r = result[0];
      expect(r.format).toBe("json");
      expect(r.structure).toBe("object");
      expect(r.count).toBe(3);
      expect(r.schema.map((s: any) => s.key)).toEqual(["host", "port", "debug"]);
    });
  });

  describe("inspect Markdown", () => {
    it("returns headings, linkCount, codeBlockCount", async () => {
      const result = (await handler({ action: "inspect", payload: { path: join(tmp, "readme.md") } })) as any[];
      expect(result).toHaveLength(1);
      const r = result[0];
      expect(r.format).toBe("markdown");
      expect(r.headings).toEqual([
        { level: 1, text: "Title" },
        { level: 2, text: "Section" },
        { level: 3, text: "Subsection" },
      ]);
      expect(r.linkCount).toBe(2);
      expect(r.codeBlockCount).toBe(1);
    });
  });

  describe("inspect directory", () => {
    it("inspects all supported files in the directory", async () => {
      const result = (await handler({ action: "inspect", payload: { path: join(tmp, "mixed") } })) as any[];
      expect(result).toHaveLength(3);
      const formats = result.map((r: any) => r.format).sort();
      expect(formats).toEqual(["csv", "json", "markdown"]);
    });

    it("throws when directory has no supported files", async () => {
      await expect(
        handler({ action: "inspect", payload: { path: join(tmp, "empty") } }),
      ).rejects.toThrow("No supported files");
    });
  });

  describe("unsupported extension", () => {
    it("throws on .xml", async () => {
      await expect(
        handler({ action: "inspect", payload: { path: join(tmp, "data.xml") } }),
      ).rejects.toThrow('Unsupported file extension ".xml"');
    });
  });

  it("rejects unknown actions", async () => {
    await expect(
      handler({ action: "bogus", payload: {} }),
    ).rejects.toThrow('Unknown action "bogus"');
  });
});
