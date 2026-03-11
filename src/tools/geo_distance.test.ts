import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import geoDistance from "./geo_distance.ts";
import { haversine } from "./geo_distance.ts";
import { ALLOWED_READ_PATHS } from "../config.ts";

const handler = geoDistance.handler;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "geo-distance-test-"));
  ALLOWED_READ_PATHS.push(tmp);
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
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
    const result = (await handler({
      action: "distance",
      payload: { lat1: 52.23, lon1: 21.01, lat2: 50.06, lon2: 19.94 },
    })) as any;

    expect(result.distance_km).toBeGreaterThan(247);
    expect(result.distance_km).toBeLessThan(257);
  });

  it("returns 0.000 for same point", async () => {
    const result = (await handler({
      action: "distance",
      payload: { lat1: 50.0, lon1: 20.0, lat2: 50.0, lon2: 20.0 },
    })) as any;

    expect(result.distance_km).toBe(0);
  });
});

describe("geo_distance find_nearby", () => {
  it("returns only matches within radius, sorted by distance", async () => {
    const refs = [
      { latitude: 52.23, longitude: 21.01, name: "Warsaw" },
      { latitude: 50.06, longitude: 19.94, name: "Kraków" },
    ];
    const queries = [
      { latitude: 52.25, longitude: 21.0, person: "Alice" },   // ~2 km from Warsaw
      { latitude: 50.05, longitude: 19.95, person: "Bob" },     // ~1 km from Kraków
      { latitude: 40.0, longitude: 10.0, person: "Charlie" },   // far from both
    ];

    const refsFile = join(tmp, "refs.json");
    const queriesFile = join(tmp, "queries.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = (await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 10 },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.count).toBe(2);
    expect(result.hints).toContain("2 matches found within 10 km.");
    // Sorted ascending by distance — closest first
    expect(result.data.matches[0].query.person).toBe("Bob");
    expect(result.data.matches[0].reference.name).toBe("Kraków");
    expect(result.data.matches[1].query.person).toBe("Alice");
    expect(result.data.matches[1].reference.name).toBe("Warsaw");
    // Charlie should not appear
    expect(result.data.matches.every((m: any) => m.query.person !== "Charlie")).toBe(true);
  });

  it("returns empty matches when nothing is within radius", async () => {
    const refs = [{ latitude: 0, longitude: 0 }];
    const queries = [{ latitude: 45, longitude: 45 }];

    const refsFile = join(tmp, "refs_far.json");
    const queriesFile = join(tmp, "queries_far.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = (await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 1 },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.count).toBe(0);
    expect(result.data.matches).toEqual([]);
  });

  it("preserves metadata fields in output", async () => {
    const refs = [{ latitude: 50.0, longitude: 20.0, code: "PL-01", type: "plant" }];
    const queries = [{ latitude: 50.001, longitude: 20.001, name: "John", surname: "Doe" }];

    const refsFile = join(tmp, "refs_meta.json");
    const queriesFile = join(tmp, "queries_meta.json");
    await Bun.write(refsFile, JSON.stringify(refs));
    await Bun.write(queriesFile, JSON.stringify(queries));

    const result = (await handler({
      action: "find_nearby",
      payload: { references_file: refsFile, queries_file: queriesFile, radius_km: 1 },
    })) as any;

    expect(result.data.count).toBe(1);
    expect(result.data.matches[0].reference.code).toBe("PL-01");
    expect(result.data.matches[0].reference.type).toBe("plant");
    expect(result.data.matches[0].query.name).toBe("John");
    expect(result.data.matches[0].query.surname).toBe("Doe");
  });

  it("throws when item lacks latitude/longitude", async () => {
    const refs = [{ latitude: 50.0 }]; // missing longitude
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
