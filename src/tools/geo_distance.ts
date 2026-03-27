import { z } from "zod";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { files } from "../infra/file.ts";
import { config } from "../config/index.ts";
import { safeParse, assertMaxLength, assertNumericBounds } from "../utils/parse.ts";
import { createDocument } from "../infra/document.ts";
import { getSessionId } from "../agent/context.ts";

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface GeoPoint {
  latitude: number;
  longitude: number;
  [key: string]: unknown;
}

function validatePoints(data: unknown, label: string): GeoPoint[] {
  if (!Array.isArray(data)) {
    throw new Error(`${label} must be a JSON array`);
  }
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item.latitude !== "number" || typeof item.longitude !== "number") {
      throw new Error(`${label}[${i}] must have numeric latitude and longitude`);
    }
  }
  return data as GeoPoint[];
}

function validateCoord(lat: number, lon: number, prefix: string): void {
  assertNumericBounds(lat, `${prefix}lat`, -90, 90);
  assertNumericBounds(lon, `${prefix}lon`, -180, 180);
}

async function findNearby(payload: {
  references_file: string;
  queries_file: string;
  radius_km: number;
}): Promise<Document> {
  assertMaxLength(payload.references_file, "references_file", 500);
  assertMaxLength(payload.queries_file, "queries_file", 500);
  assertNumericBounds(payload.radius_km, "radius_km", 0.001, 40_075);

  await files.checkFileSize(payload.references_file, config.limits.maxFileSize);
  await files.checkFileSize(payload.queries_file, config.limits.maxFileSize);

  const refsRaw = await files.readText(payload.references_file);
  const queriesRaw = await files.readText(payload.queries_file);

  const references = validatePoints(safeParse(refsRaw, "references"), "references");
  const queries = validatePoints(safeParse(queriesRaw, "queries"), "queries");

  const matches: { reference: GeoPoint; query: GeoPoint; distance_km: number }[] = [];

  for (const ref of references) {
    for (const query of queries) {
      const dist = haversine(ref.latitude, ref.longitude, query.latitude, query.longitude);
      if (dist <= payload.radius_km) {
        matches.push({
          reference: ref,
          query: query,
          distance_km: roundTo3(dist),
        });
      }
    }
  }

  matches.sort((a, b) => a.distance_km - b.distance_km);

  const text = JSON.stringify({ count: matches.length, matches });
  const note = matches.length > 50 ? " Many matches — consider narrowing the radius." : "";
  return createDocument(
    text,
    `${matches.length} matches within ${payload.radius_km} km.${note}`,
    { source: null, type: "document", mimeType: "application/json" },
    getSessionId(),
  );
}

function distance(payload: {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}): Document {
  validateCoord(payload.lat1, payload.lon1, "");
  validateCoord(payload.lat2, payload.lon2, "");
  const km = roundTo3(haversine(payload.lat1, payload.lon1, payload.lat2, payload.lon2));
  return createDocument(
    JSON.stringify({ distance_km: km }),
    `Distance: ${km} km`,
    { source: null, type: "document", mimeType: "application/json" },
    getSessionId(),
  );
}

async function geoDistance(args: Record<string, unknown>): Promise<Document> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "find_nearby":
      return findNearby(payload as { references_file: string; queries_file: string; radius_km: number });
    case "distance":
      return distance(payload as { lat1: number; lon1: number; lat2: number; lon2: number });
    default:
      throw new Error(`Unknown geo_distance action: ${action}`);
  }
}

export default {
  name: "geo_distance",
  schema: {
    name: "geo_distance",
    description: "Compute geographic distances between coordinates. Use when a task involves physical proximity, location matching, or distance calculations.",
    actions: {
      find_nearby: {
        description: "Match two sets of locations in bulk. Reads two JSON files (references + queries) and returns JSON array of matching pairs with distance_km, sorted by distance ascending. Empty array if no pairs within radius. Preferred over looping with distance — prepare the two files first, then match in one call.",
        schema: z.object({
          references_file: z.string().describe("Absolute path to a JSON array of reference points. Each item must have latitude and longitude (numbers). All other fields are passed through as metadata."),
          queries_file: z.string().describe("Absolute path to a JSON array of query points. Each item must have latitude and longitude (numbers). All other fields are passed through as metadata."),
          radius_km: z.number().describe("Maximum distance in kilometers. Only pairs within this radius are returned."),
        }),
      },
      distance: {
        description: "Compute haversine distance between a single pair of points. Returns distance in km. For comparing multiple points against multiple references, use find_nearby instead.",
        schema: z.object({
          lat1: z.number().describe("Latitude of the first point (-90 to 90)"),
          lon1: z.number().describe("Longitude of the first point (-180 to 180)"),
          lat2: z.number().describe("Latitude of the second point (-90 to 90)"),
          lon2: z.number().describe("Longitude of the second point (-180 to 180)"),
        }),
      },
    },
  },
  handler: geoDistance,
} satisfies ToolDefinition;
