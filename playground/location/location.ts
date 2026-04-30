import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const HUB_API_KEY = process.env.HUB_API_KEY!;
const ENDPOINT = "https://hub.ag3nts.org/api/location";

interface Person {
  name: string;
  surname: string;
  gender: string;
  born: number;
  city: string;
  tags: string[];
}

interface LocationResult {
  name: string;
  surname: string;
  response: unknown;
}

const inputPath = join(import.meta.dir, "../../apps/server/src/output/results_job_contains_transport.json");
const outputPath = join(import.meta.dir, "output/locations.json");

const people: Person[] = JSON.parse(await readFile(inputPath, "utf-8"));

console.log(`Fetching locations for ${people.length} people...\n`);

const results: LocationResult[] = [];

for (const person of people) {
  const payload = {
    apikey: HUB_API_KEY,
    name: person.name,
    surname: person.surname,
  };

  console.log(`→ ${person.name} ${person.surname}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log(`  Status: ${res.status} | Response:`, JSON.stringify(data));

  results.push({
    name: person.name,
    surname: person.surname,
    response: data,
  });
}

await writeFile(outputPath, JSON.stringify(results, null, 2), "utf-8");
console.log(`\nResults saved to ${outputPath}`);
