import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ALLOWED_READ_PATHS, ALLOWED_WRITE_PATHS } from "../config.ts";

// Mock batchTransform before importing the tool
mock.module("../utils/llm.ts", () => ({
  batchTransform: async (values: string[], _instructions: string) =>
    values.map(() => "mocked-value"),
}));

const { default: dataTransformer } = await import("./data_transformer.ts");
const handler = dataTransformer.handler;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "data-transformer-test-"));
  ALLOWED_READ_PATHS.push(tmp);
  ALLOWED_WRITE_PATHS.push(tmp);

  await Bun.write(
    join(tmp, "people.csv"),
    "name,age,city\nAlice,30,Warsaw\nBob,25,Berlin\nCharlie,35,Warsaw\nDave,28,Paris\n",
  );

  await Bun.write(
    join(tmp, "people.json"),
    JSON.stringify([
      { name: "Alice", age: 30, city: "Warsaw" },
      { name: "Bob", age: 25, city: "Berlin" },
      { name: "Charlie", age: 35, city: "Warsaw" },
      { name: "Dave", age: 28, city: "Paris" },
    ]),
  );

  await Bun.write(
    join(tmp, "tags.csv"),
    'id,tags\n1,"[""a"",""b""]"\n2,"[""c""]"\n',
  );

  await Bun.write(
    join(tmp, "mapped.json"),
    JSON.stringify([
      { full_name: "Alice", location: "Warsaw" },
      { full_name: "Bob", location: "Berlin" },
    ]),
  );

  await Bun.write(
    join(tmp, "with_arrays.json"),
    JSON.stringify([
      { name: "Alice", tags: ["transport", "IT"] },
      { name: "Bob", tags: ["edukacja"] },
    ]),
  );
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
  ALLOWED_WRITE_PATHS.splice(ALLOWED_WRITE_PATHS.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
});

describe("data_transformer", () => {
  describe("filter", () => {
    it("filters CSV with AND logic", async () => {
      const result = (await handler({
        action: "filter",
        payload: {
          path: join(tmp, "people.csv"),
          format: "csv",
          conditions: [
            { field: "city", op: "eq", value: "Warsaw" },
            { field: "age", op: "gte", value: "30" },
          ],
          logic: "and",
        },
      })) as any;
      expect(result.count).toBe(2);
      expect(result.preview.map((r: any) => r.name)).toEqual(["Alice", "Charlie"]);
    });

    it("filters JSON with OR logic", async () => {
      const result = (await handler({
        action: "filter",
        payload: {
          path: join(tmp, "people.json"),
          format: "json",
          conditions: [
            { field: "city", op: "eq", value: "Warsaw" },
            { field: "city", op: "eq", value: "Paris" },
          ],
          logic: "or",
        },
      })) as any;
      expect(result.count).toBe(3);
      const names = result.preview.map((r: any) => r.name);
      expect(names).toContain("Alice");
      expect(names).toContain("Charlie");
      expect(names).toContain("Dave");
    });

    it("throws on unknown field", async () => {
      await expect(
        handler({
          action: "filter",
          payload: {
            path: join(tmp, "people.csv"),
            format: "csv",
            conditions: [{ field: "nonexistent", op: "eq", value: "x" }],
            logic: "and",
          },
        }),
      ).rejects.toThrow('Field "nonexistent" not found');
    });
  });

  describe("sort", () => {
    it("sorts ascending alphabetically", async () => {
      const result = (await handler({
        action: "sort",
        payload: {
          path: join(tmp, "people.csv"),
          format: "csv",
          sort_by: [{ field: "name", direction: "asc" }],
        },
      })) as any;
      expect(result.count).toBe(4);
      expect(result.preview.map((r: any) => r.name)).toEqual(["Alice", "Bob", "Charlie", "Dave"]);
    });

    it("sorts numeric descending", async () => {
      const result = (await handler({
        action: "sort",
        payload: {
          path: join(tmp, "people.csv"),
          format: "csv",
          sort_by: [{ field: "age", direction: "desc" }],
        },
      })) as any;
      expect(result.preview.map((r: any) => r.name)).toEqual(["Charlie", "Alice", "Dave", "Bob"]);
    });

    it("sorts by multiple fields", async () => {
      const result = (await handler({
        action: "sort",
        payload: {
          path: join(tmp, "people.csv"),
          format: "csv",
          sort_by: [
            { field: "city", direction: "asc" },
            { field: "name", direction: "asc" },
          ],
        },
      })) as any;
      // Berlin(Bob), Paris(Dave), Warsaw(Alice, Charlie)
      expect(result.preview.map((r: any) => r.name)).toEqual(["Bob", "Dave", "Alice", "Charlie"]);
    });
  });

  describe("add_field", () => {
    it("adds a new field using LLM (mocked)", async () => {
      const result = (await handler({
        action: "add_field",
        payload: {
          path: join(tmp, "people.csv"),
          format: "csv",
          field_name: "category",
          instructions: "Categorize this person",
          context_fields: ["name", "city"],
        },
      })) as any;
      expect(result.count).toBe(4);
      expect(result.preview[0].category).toBe("mocked-value");
      expect(result.preview[0].name).toBe("Alice");
    });
  });

  describe("convert", () => {
    it("converts CSV to JSON", async () => {
      const result = (await handler({
        action: "convert",
        payload: {
          source_path: join(tmp, "people.csv"),
          from_format: "csv",
          to_format: "json",
          mapping: [],
        },
      })) as any;
      expect(result.count).toBe(4);
      expect(result.outputPath).toContain("people.json");
      expect(result.preview[0]).toEqual({ name: "Alice", age: "30", city: "Warsaw" });
    });

    it("converts JSON to CSV", async () => {
      const result = (await handler({
        action: "convert",
        payload: {
          source_path: join(tmp, "people.json"),
          from_format: "json",
          to_format: "csv",
          mapping: [],
        },
      })) as any;
      expect(result.count).toBe(4);
      expect(result.outputPath).toContain("people.csv");
      expect(result.preview).toContain("name,age,city");
    });

    it("converts with mapping and type coercion", async () => {
      const result = (await handler({
        action: "convert",
        payload: {
          source_path: join(tmp, "people.csv"),
          from_format: "csv",
          to_format: "json",
          mapping: [
            { from: "name", to: "full_name", type: "string" },
            { from: "age", to: "years", type: "number" },
          ],
        },
      })) as any;
      expect(result.count).toBe(4);
      expect(result.preview[0]).toEqual({ full_name: "Alice", years: 30 });
    });

    it("converts with json type coercion", async () => {
      const result = (await handler({
        action: "convert",
        payload: {
          source_path: join(tmp, "tags.csv"),
          from_format: "csv",
          to_format: "json",
          mapping: [
            { from: "id", to: "id", type: "number" },
            { from: "tags", to: "tags", type: "json" },
          ],
        },
      })) as any;
      expect(result.preview[0]).toEqual({ id: 1, tags: ["a", "b"] });
    });

    it("rejects unsupported format pair", async () => {
      await expect(
        handler({
          action: "convert",
          payload: {
            source_path: join(tmp, "people.csv"),
            from_format: "xml",
            to_format: "json",
            mapping: [],
          },
        }),
      ).rejects.toThrow("Unsupported conversion");
    });
  });

  it("rejects unknown actions", async () => {
    await expect(handler({ action: "bogus", payload: {} })).rejects.toThrow(
      'Unknown action "bogus"',
    );
  });
});
