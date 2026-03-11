import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";

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

async function findNearby(payload: {
  references_file: string;
  queries_file: string;
  radius_km: number;
}): Promise<{ count: number; matches: { reference: GeoPoint; query: GeoPoint; distance_km: number }[] }> {
  const refsRaw = await files.readText(payload.references_file);
  const queriesRaw = await files.readText(payload.queries_file);

  const references = validatePoints(JSON.parse(refsRaw), "references");
  const queries = validatePoints(JSON.parse(queriesRaw), "queries");

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

  return { count: matches.length, matches };
}

function distance(payload: {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}): { distance_km: number } {
  return { distance_km: roundTo3(haversine(payload.lat1, payload.lon1, payload.lat2, payload.lon2)) };
}

async function geoDistance({ action, payload }: { action: string; payload: Record<string, any> }): Promise<unknown> {
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
  handler: geoDistance,
} satisfies ToolDefinition;
