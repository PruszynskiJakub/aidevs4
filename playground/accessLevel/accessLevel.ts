import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const HUB_API_KEY = process.env.HUB_API_KEY!;
const ENDPOINT = "https://hub.ag3nts.org/api/accesslevel";

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
  birthYear: number;
  response: unknown;
}

const inputPath = join(import.meta.dir, "../../apps/server/src/output/results_job_contains_transport.json");
const outputPath = join(import.meta.dir, "output/access_level.json");

const people: Person[] = JSON.parse(await readFile(inputPath, "utf-8"));

console.log(`Fetching access levels for ${people.length} people...\n`);

const results: LocationResult[] = [];

for (const person of people) {
  const payload = {
    apikey: HUB_API_KEY,
    name: person.name,
    surname: person.surname,
    birthYear: person.born,
  };

  console.log(`→ ${person.name} ${person.surname} (born ${person.born})`);

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
    birthYear: person.born,
    response: data,
  });
}

await writeFile(outputPath, JSON.stringify(results, null, 2), "utf-8");
console.log(`\nResults saved to ${outputPath}`);
