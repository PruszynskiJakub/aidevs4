import { join } from "path";
import { haversine } from "../../src/tools/geo_distance.ts";

const HUB_API_KEY = process.env.HUB_API_KEY!;
const BASE = "https://hub.ag3nts.org";
const OUT = join(import.meta.dir, "output");
await Bun.write(join(OUT, ".keep"), ""); // ensure dir exists

// --- Step 1: Load suspects from previous task ---
const suspects: { name: string; surname: string; born: number }[] = JSON.parse(
  await Bun.file(join(import.meta.dir, "../../src/output/results_job_contains_transport.json")).text(),
);
console.log(`Suspects: ${suspects.map((s) => `${s.name} ${s.surname}`).join(", ")}`);

// --- Step 2: Download power plant locations ---
const plantsRes = await fetch(`${BASE}/data/${HUB_API_KEY}/findhim_locations.json`);
const plantsData = (await plantsRes.json()) as {
  power_plants: Record<string, { is_active: boolean; power: string; code: string }>;
};
const plants = plantsData.power_plants;
console.log("\n=== Power Plants ===");
for (const [city, info] of Object.entries(plants)) {
  console.log(`  ${city} → ${info.code} (active=${info.is_active})`);
}

// Known coordinates for power-plant cities
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  Zabrze: { lat: 50.3246, lon: 18.7856 },
  "Piotrków Trybunalski": { lat: 51.4053, lon: 19.7031 },
  Grudziądz: { lat: 53.4837, lon: 18.7536 },
  Tczew: { lat: 54.0929, lon: 18.7953 },
  Radom: { lat: 51.4027, lon: 21.1471 },
  Chełmno: { lat: 53.3492, lon: 18.426 },
  Żarnowiec: { lat: 54.7594, lon: 18.0528 },
};

// --- Step 3: Get locations for all suspects ---
console.log("\n=== Fetching locations ===");
const personLocations: { name: string; surname: string; coords: { latitude: number; longitude: number }[] }[] = [];

for (const s of suspects) {
  const res = await fetch(`${BASE}/api/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: HUB_API_KEY, name: s.name, surname: s.surname }),
  });
  const data = await res.json();
  console.log(`  ${s.name} ${s.surname}: ${JSON.stringify(data)}`);
  personLocations.push({ name: s.name, surname: s.surname, coords: data as any });
}

// --- Step 4: Find who was near a power plant ---
const THRESHOLD_KM = 50;

type Match = {
  name: string;
  surname: string;
  city: string;
  code: string;
  distKm: number;
  coord: { latitude: number; longitude: number };
};

const matches: Match[] = [];

for (const person of personLocations) {
  const coords = Array.isArray(person.coords) ? person.coords : [];
  for (const coord of coords) {
    for (const [city, plant] of Object.entries(plants)) {
      const cityCoord = CITY_COORDS[city];
      if (!cityCoord) {
        console.log(`  WARNING: No coords for city "${city}"`);
        continue;
      }
      const dist = haversine(coord.latitude, coord.longitude, cityCoord.lat, cityCoord.lon);
      if (dist < THRESHOLD_KM) {
        matches.push({
          name: person.name,
          surname: person.surname,
          city,
          code: plant.code,
          distKm: Math.round(dist * 100) / 100,
          coord,
        });
      }
    }
  }
}

matches.sort((a, b) => a.distKm - b.distKm);

console.log(`\n=== Matches within ${THRESHOLD_KM} km ===`);
for (const m of matches) {
  console.log(
    `  ${m.name} ${m.surname} @ (${m.coord.latitude}, ${m.coord.longitude})` +
      ` → ${m.city} (${m.code}) = ${m.distKm} km`,
  );
}

if (matches.length === 0) {
  console.log("No matches found!");
  process.exit(1);
}

// --- Step 5: Get access level for the matched person ---
// Pick the closest match (excluding home city Grudziądz matches if there are better ones)
const best = matches[0];
console.log(`\n=== Best match: ${best.name} ${best.surname} → ${best.city} (${best.code}) ===`);

const suspect = suspects.find((s) => s.name === best.name && s.surname === best.surname)!;
const accessRes = await fetch(`${BASE}/api/accesslevel`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    apikey: HUB_API_KEY,
    name: best.name,
    surname: best.surname,
    birthYear: suspect.born,
  }),
});
const accessData = (await accessRes.json()) as any;
console.log(`Access level response: ${JSON.stringify(accessData)}`);

const accessLevel = accessData.accessLevel ?? accessData.access_level ?? accessData;

// --- Step 6: Submit answer ---
const answer = {
  name: best.name,
  surname: best.surname,
  accessLevel,
  powerPlant: best.code,
};

console.log("\n=== Submitting ===");
console.log(JSON.stringify(answer, null, 2));

const verifyRes = await fetch(`${BASE}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ apikey: HUB_API_KEY, task: "findhim", answer }),
});

const verifyData = await verifyRes.json();
console.log("\n=== Verify Response ===");
console.log(JSON.stringify(verifyData, null, 2));
