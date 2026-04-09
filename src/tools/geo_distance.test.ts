import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolResult } from "../types/tool-result.ts";
import geoDistance from "./geo_distance.ts";
import { haversine } from "./geo_distance.ts";
import { createSandbox, _setSandboxForTest } from "../infra/sandbox.ts";
import { config } from "../config/index.ts";

const handler = geoDistance.handler;

let tmp: string;
let restoreFiles: () => void;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "geo-distance-test-"));
  restoreFiles = _setSandboxForTest(
    createSandbox({
      readPaths: [...config.sandbox.allowedReadPaths, tmp],
      writePaths: [...config.sandbox.allowedWritePaths, tmp],
      blockedWritePaths: [],
    }),
  );
});

afterAll(async () => {
  restoreFiles();
  await rm(tmp, { recursive: true, force: true });
});

describe("haversine", () => {
  it("computes Warsaw → Kraków ≈ 252 km", () => {
    const dist = haversine(52.23, 21.01, 50.06, 19.94);
    expect(dist).toBeGreaterThan(247);
    expect(dist).toBeLessThan(257);
  });

  it("returns 0 for same point", () => {
    const dist = haversine(50.0, 20.0, 50.0, 20.0);
    expect(dist).toBe(0);
  });
});

describe("geo_distance distance", () => {
  it("returns correct distance for inline points", async () => {
    const result = await handler({
      action: "distance",
      payload: { lat1: 52.23, lon1: 21.01, lat2: 50.06, lon2: 19.94 },
    });

    const data = JSON.parse(getText(result));
    expect(data.distance_km).toBeGreaterThan(247);
    expect(data.distance_km).toBeLessThan(257);
  });

  it("returns 0.000 for same point", async () => {
    const result = await handler({
      action: "distance",
      payload: { lat1: 50.0, lon1: 20.0, lat2: 50.0, lon2: 20.0 },
    });

    const data = JSON.parse(getText(result));
    expect(data.distance_km).toBe(0);
  });
});

describe("geo_distance find_nearby", () => {
  it("returns only matches within radius, sorted by distance", async () => {
    const refs = [
      { latitude: 52.23, longitude: 21.01, name: "Warsaw" },
      { latitude: 50.06, longitude: 19.94, name: "Kraków" },
    ];
    const queries = [
      { latitude: 52.25, longitude: 21.0, person: "Alice" },
      { latitude: 50.05, longitude: 19.95, person: "Bob" },
      { latitude: 40.0, longitude: 10.0, person: "Charlie" },
    ];

    const refsFile = join(tmp, "refs.json");
    const queriesFile = join(tmp, "queries.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 10 },
    });

    const data = JSON.parse(getText(result));
    expect(data.count).toBe(2);
    expect(data.matches[0].query.person).toBe("Bob");
    expect(data.matches[0].reference.name).toBe("Kraków");
    expect(data.matches[1].query.person).toBe("Alice");
    expect(data.matches[1].reference.name).toBe("Warsaw");
    expect(data.matches.every((m: any) => m.query.person !== "Charlie")).toBe(true);
  });

  it("returns empty matches when nothing is within radius", async () => {
    const refs = [{ latitude: 0, longitude: 0 }];
    const queries = [{ latitude: 45, longitude: 45 }];

    const refsFile = join(tmp, "refs_far.json");
    const queriesFile = join(tmp, "queries_far.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 1 },
    });

    const data = JSON.parse(getText(result));
    expect(data.count).toBe(0);
    expect(data.matches).toEqual([]);
  });

  it("preserves metadata fields in output", async () => {
    const refs = [{ latitude: 50.0, longitude: 20.0, code: "PL-01", type: "plant" }];
    const queries = [{ latitude: 50.001, longitude: 20.001, name: "John", surname: "Doe" }];

    const refsFile = join(tmp, "refs_meta.json");
    const queriesFile = join(tmp, "queries_meta.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 1 },
    });

    const data = JSON.parse(getText(result));
    expect(data.count).toBe(1);
    expect(data.matches[0].reference.code).toBe("PL-01");
    expect(data.matches[0].reference.type).toBe("plant");
    expect(data.matches[0].query.name).toBe("John");
    expect(data.matches[0].query.surname).toBe("Doe");
  });

  it("throws when item lacks latitude/longitude", async () => {
    const refs = [{ latitude: 50.0 }];
    const refsFile = join(tmp, "refs_bad.json");
    const queriesFile = join(tmp, "queries_ok.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify([{ latitude: 50.0, longitude: 20.0 }]));

    await expect(
      handler({ action: "find_nearby", payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 10 } }),
    ).rejects.toThrow("references[0] must have numeric latitude and longitude");
  });

  it("throws when file is not found", async () => {
    await expect(
      handler({
        action: "find_nearby",
        payload: { references_file: join(tmp, "nonexistent.json"), queries_file: join(tmp, "also_missing.json"), radius_km: 10 },
      }),
    ).rejects.toThrow();
  });

  it("throws when file is not an array", async () => {
    const refsFile = join(tmp, "refs_obj.json");
    const queriesFile = join(tmp, "queries_arr.json");
    await Bun.write(refsFile, JSON.stringify({ not: "array" }));
    await Bun.write(queriesFile, JSON.stringify([{ latitude: 50.0, longitude: 20.0 }]));

    await expect(
      handler({ action: "find_nearby", payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 10 } }),
    ).rejects.toThrow("references must be a JSON array");
  });
});
