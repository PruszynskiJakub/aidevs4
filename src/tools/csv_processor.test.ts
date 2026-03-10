import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import csvProcessor from "./csv_processor.ts";

const handler = csvProcessor.handler;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "csv-processor-test-"));

  await Bun.write(
    join(tmp, "people.csv"),
    "name,age,city\nAlice,30,Warsaw\nBob,25,Berlin\nCharlie,35,Warsaw\n"
  );

  await Bun.write(
    join(tmp, "empty_header.csv"),
    "col_a,col_b\n"
  );

  const subdir = join(tmp, "multi");
  await mkdir(subdir);
  await Bun.write(join(subdir, "a.csv"), "x,y\n1,2\n3,4\n");
  await Bun.write(join(subdir, "b.csv"), "p,q,r\n5,6,7\n");
  await Bun.write(join(subdir, "not_csv.txt"), "ignore me");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("csv_processor", () => {
  describe("metadata", () => {
    it("returns structure for a single CSV", async () => {
      const result = (await handler({ action: "metadata", payload: { path: join(tmp, "people.csv") } })) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].rows).toBe(3);
      expect(result[0].columns).toEqual(["name", "age", "city"]);
    });

    it("returns structure for a directory of CSVs", async () => {
      const result = (await handler({ action: "metadata", payload: { path: join(tmp, "multi") } })) as any[];
      expect(result).toHaveLength(2);
      const names = result.map((r: any) => r.file);
      expect(names.some((n: string) => n.endsWith("a.csv"))).toBe(true);
      expect(names.some((n: string) => n.endsWith("b.csv"))).toBe(true);
    });

    it("throws when directory has no CSVs", async () => {
      const emptyDir = join(tmp, "empty_dir");
      await mkdir(emptyDir, { recursive: true });
      await expect(handler({ action: "metadata", payload: { path: emptyDir } })).rejects.toThrow("No CSV files found");
    });
  });

  describe("search", () => {
    it("filters rows matching a condition", async () => {
      const result = (await handler({
        action: "search",
        payload: {
          path: join(tmp, "people.csv"),
          filters: [{ column: "city", op: "eq", value: "Warsaw" }],
        },
      })) as any;
      expect(result.matchCount).toBe(2);
      expect(result.preview).toHaveLength(2);
      expect(result.outputPath).toContain("results_");
    });

    it("throws on non-existent column", async () => {
      await expect(
        handler({
          action: "search",
          payload: {
            path: join(tmp, "people.csv"),
            filters: [{ column: "nonexistent", op: "eq", value: "x" }],
          },
        })
      ).rejects.toThrow('Column "nonexistent" not found');
    });
  });

  describe("unknown action", () => {
    it("throws listing valid actions", async () => {
      await expect(handler({ action: "nope", payload: {} })).rejects.toThrow(
        'Unknown action "nope". Valid actions: metadata, search, transform_column'
      );
    });
  });
});
