import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import fileConverter from "./file_converter.ts";
import { ALLOWED_READ_PATHS, ALLOWED_WRITE_PATHS } from "../config.ts";

const handler = fileConverter.handler;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file-converter-test-"));
  ALLOWED_READ_PATHS.push(tmp);
  ALLOWED_WRITE_PATHS.push(tmp);

  await Bun.write(
    join(tmp, "people.csv"),
    "name,age,city\nAlice,30,Warsaw\nBob,25,Berlin\n",
  );

  await Bun.write(
    join(tmp, "tags.csv"),
    'id,tags\n1,"[""a"",""b""]"\n2,"[""c""]"\n',
  );

  await Bun.write(
    join(tmp, "people.json"),
    JSON.stringify([
      { name: "Alice", age: 30, city: "Warsaw" },
      { name: "Bob", age: 25, city: "Berlin" },
    ]),
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
      { name: "Charlie", tags: [] },
    ]),
  );
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
  ALLOWED_WRITE_PATHS.splice(ALLOWED_WRITE_PATHS.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
});

describe("file_converter", () => {
  describe("CSV → JSON", () => {
    it("converts without mapping (all fields pass through)", async () => {
      const result = (await handler({
        source_path: join(tmp, "people.csv"),
        from_format: "csv",
        to_format: "json",
      })) as any;

      expect(result.rowCount).toBe(2);
      expect(result.outputPath).toContain("people.json");
      expect(result.preview).toEqual([
        { name: "Alice", age: "30", city: "Warsaw" },
        { name: "Bob", age: "25", city: "Berlin" },
      ]);
    });

    it("converts with mapping and type coercion", async () => {
      const result = (await handler({
        source_path: join(tmp, "people.csv"),
        from_format: "csv",
        to_format: "json",
        mapping: [
          { from: "name", to: "full_name", type: "string" },
          { from: "age", to: "years", type: "number" },
        ],
      })) as any;

      expect(result.rowCount).toBe(2);
      expect(result.preview[0]).toEqual({ full_name: "Alice", years: 30 });
      expect(result.preview[1]).toEqual({ full_name: "Bob", years: 25 });
    });

    it("converts with json type coercion", async () => {
      const result = (await handler({
        source_path: join(tmp, "tags.csv"),
        from_format: "csv",
        to_format: "json",
        mapping: [
          { from: "id", to: "id", type: "number" },
          { from: "tags", to: "tags", type: "json" },
        ],
      })) as any;

      expect(result.preview[0]).toEqual({ id: 1, tags: ["a", "b"] });
      expect(result.preview[1]).toEqual({ id: 2, tags: ["c"] });
    });

    it("throws on missing column", async () => {
      await expect(
        handler({
          source_path: join(tmp, "people.csv"),
          from_format: "csv",
          to_format: "json",
          mapping: [{ from: "nonexistent", to: "x" }],
        }),
      ).rejects.toThrow('Column "nonexistent" not found in CSV');
    });
  });

  describe("JSON → CSV", () => {
    it("converts without mapping (all fields pass through)", async () => {
      const result = (await handler({
        source_path: join(tmp, "people.json"),
        from_format: "json",
        to_format: "csv",
      })) as any;

      expect(result.rowCount).toBe(2);
      expect(result.outputPath).toContain("people.csv");
      expect(result.preview).toContain("name,age,city");
      expect(result.preview).toContain("Alice,30,Warsaw");
    });

    it("properly quotes array values as JSON strings", async () => {
      const result = (await handler({
        source_path: join(tmp, "with_arrays.json"),
        from_format: "json",
        to_format: "csv",
      })) as any;

      expect(result.rowCount).toBe(3);
      // Arrays should be serialized as JSON, not String() which loses brackets
      expect(result.preview).toContain('"[""transport"",""IT""]"');
      expect(result.preview).toContain('"[""edukacja""]"');
      expect(result.preview).toContain("[]");
    });

    it("roundtrips arrays through CSV→JSON", async () => {
      // First: JSON → CSV
      const csvResult = (await handler({
        source_path: join(tmp, "with_arrays.json"),
        from_format: "json",
        to_format: "csv",
      })) as any;

      // Then: CSV → JSON with json type
      const jsonResult = (await handler({
        source_path: csvResult.outputPath,
        from_format: "csv",
        to_format: "json",
        mapping: [
          { from: "name", to: "name", type: "string" },
          { from: "tags", to: "tags", type: "json" },
        ],
      })) as any;

      expect(jsonResult.preview[0]).toEqual({ name: "Alice", tags: ["transport", "IT"] });
      expect(jsonResult.preview[1]).toEqual({ name: "Bob", tags: ["edukacja"] });
      expect(jsonResult.preview[2]).toEqual({ name: "Charlie", tags: [] });
    });

    it("converts with mapping (rename keys)", async () => {
      const result = (await handler({
        source_path: join(tmp, "mapped.json"),
        from_format: "json",
        to_format: "csv",
        mapping: [
          { from: "full_name", to: "name" },
          { from: "location", to: "city" },
        ],
      })) as any;

      expect(result.rowCount).toBe(2);
      expect(result.preview).toContain("name,city");
      expect(result.preview).toContain("Alice,Warsaw");
    });
  });

  describe("errors", () => {
    it("rejects unsupported format pair", async () => {
      await expect(
        handler({
          source_path: join(tmp, "people.csv"),
          from_format: "xml" as any,
          to_format: "json",
        }),
      ).rejects.toThrow("Unsupported conversion: xml → json");
    });

    it("rejects missing source file", async () => {
      await expect(
        handler({
          source_path: join(tmp, "no_such_file.csv"),
          from_format: "csv",
          to_format: "json",
        }),
      ).rejects.toThrow();
    });
  });
});
