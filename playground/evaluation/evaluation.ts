/**
 * Evaluation task: Find anomalies in 10,000 sensor readings.
 *
 * Anomaly types:
 * 1. Active sensor value out of valid range
 * 2. Inactive sensor field is non-zero (sensor returns data it shouldn't)
 * 3. Operator says OK but data has issues
 * 4. Operator says problems but data is actually fine
 */

import { join } from "path";
import { readdir, mkdir } from "fs/promises";

const DIR = import.meta.dir;
const OUTPUT_DIR = join(DIR, "output");
const SENSORS_DIR = join(OUTPUT_DIR, "sensors");
const ZIP_PATH = join(OUTPUT_DIR, "sensors.zip");

// --- Config ---
const HUB_API_KEY = process.env.HUB_API_KEY!;
const SENSORS_URL = "https://hub.ag3nts.org/dane/sensors.zip";
const VERIFY_URL = "https://hub.ag3nts.org/verify";

// --- Sensor field mapping ---
const SENSOR_FIELD_MAP: Record<string, string> = {
  temperature: "temperature_K",
  pressure: "pressure_bar",
  water: "water_level_meters",
  voltage: "voltage_supply_v",
  humidity: "humidity_percent",
};

// --- Valid ranges for active sensors ---
const VALID_RANGES: Record<string, [number, number]> = {
  temperature_K: [553, 873],
  pressure_bar: [60, 160],
  water_level_meters: [5.0, 15.0],
  voltage_supply_v: [229.0, 231.0],
  humidity_percent: [40.0, 80.0],
};

const ALL_FIELDS = Object.values(SENSOR_FIELD_MAP);

interface SensorData {
  sensor_type: string;
  timestamp: number;
  temperature_K: number;
  pressure_bar: number;
  water_level_meters: number;
  voltage_supply_v: number;
  humidity_percent: number;
  operator_notes: string;
}

// --- Step 1: Download & extract ---
async function downloadAndExtract() {
  if (await Bun.file(ZIP_PATH).exists()) {
    console.log("ZIP already downloaded");
  } else {
    console.log("Downloading sensors.zip...");
    const resp = await fetch(SENSORS_URL);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    await Bun.write(ZIP_PATH, resp);
    console.log("Downloaded.");
  }

  await mkdir(SENSORS_DIR, { recursive: true });
  const existing = await readdir(SENSORS_DIR);
  if (existing.length > 100) {
    console.log(`Already extracted (${existing.length} files)`);
    return;
  }

  console.log("Extracting...");
  const proc = Bun.spawn(["unzip", "-o", ZIP_PATH, "-d", SENSORS_DIR], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  console.log("Extracted.");
}

// --- Step 2: Parse active sensors from sensor_type ---
function getActiveFields(sensorType: string): Set<string> {
  const types = sensorType.split("/").map((s) => s.trim().toLowerCase());
  const fields = new Set<string>();
  for (const t of types) {
    const field = SENSOR_FIELD_MAP[t];
    if (field) fields.add(field);
  }
  return fields;
}

// --- Step 3: Check data anomalies ---
interface AnomalyResult {
  fileId: string;
  reasons: string[];
}

function checkDataAnomalies(data: SensorData): string[] {
  const reasons: string[] = [];
  const activeFields = getActiveFields(data.sensor_type);

  // Check unknown sensor types
  const types = data.sensor_type.split("/").map((s) => s.trim().toLowerCase());
  for (const t of types) {
    if (!SENSOR_FIELD_MAP[t]) {
      reasons.push(`Unknown sensor type: ${t}`);
    }
  }

  // Check active sensor values are within range
  for (const field of activeFields) {
    const value = (data as any)[field];
    const [min, max] = VALID_RANGES[field];
    if (value < min || value > max) {
      reasons.push(`${field}=${value} out of range [${min}, ${max}]`);
    }
  }

  // Check inactive sensor fields are zero
  for (const field of ALL_FIELDS) {
    if (!activeFields.has(field)) {
      const value = (data as any)[field];
      if (value !== 0) {
        reasons.push(`Inactive ${field}=${value} should be 0`);
      }
    }
  }

  return reasons;
}

// --- Step 4: Classify operator notes ---
// Notes are templated: 3 clauses separated by commas.
// OK notes have positive first clauses. Problem notes assert something is wrong.
function classifyNote(note: string): "ok" | "problem" {
  const lower = note.toLowerCase();

  // Genuine problem indicators — first-clause patterns that positively assert an issue
  const problemPatterns = [
    "looks unstable",
    "seems unreliable",
    "feel inconsistent",
    "feels inconsistent",
    "requires attention",
    "raises serious doubts",
    "look suspicious",
    "looks suspicious",
    "questionable behavior",
    "visible anomaly",
    "looks unusual",
    "not the pattern i expected",
    "does not look healthy",
    "clear irregularity",
    "did not look right",
    "behavior is concerning",
    "not look right",
    "unreliable",
    "suspicious",
    "serious doubts",
    "questionable",
    "irregularity",
    "not healthy",
    "clearly off",
    "unexpected pattern",
    "quality is doubtful",
    "not comfortable with this result",
  ];

  const hasProblem = problemPatterns.some((p) => lower.includes(p));
  return hasProblem ? "problem" : "ok";
}

// --- Main ---
async function main() {
  await downloadAndExtract();

  // Read all sensor files
  const files = (await readdir(SENSORS_DIR)).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} sensor files`);

  const anomalies: AnomalyResult[] = [];
  const uniqueNotes = new Map<string, { count: number; classification: string }>();

  // First pass: check all files
  for (const file of files) {
    const data: SensorData = await Bun.file(join(SENSORS_DIR, file)).json();
    const fileId = file.replace(".json", "");

    // Check data anomalies
    const dataIssues = checkDataAnomalies(data);
    const dataIsOk = dataIssues.length === 0;

    // Classify operator note
    const noteClass = classifyNote(data.operator_notes);

    // Track unique notes
    if (!uniqueNotes.has(data.operator_notes)) {
      uniqueNotes.set(data.operator_notes, { count: 0, classification: noteClass });
    }
    uniqueNotes.get(data.operator_notes)!.count++;

    // Determine anomalies
    const reasons: string[] = [];

    // Data out of range or inactive sensor returning data
    if (!dataIsOk) {
      reasons.push(...dataIssues);
    }

    // Mismatch: operator says OK but data is bad
    if (noteClass === "ok" && !dataIsOk) {
      reasons.push("Operator says OK but data has issues");
    }

    // Mismatch: operator says problem but data is fine
    if (noteClass === "problem" && dataIsOk) {
      reasons.push("Operator reports problems but data is within range");
    }

    // Check for non-standard note format (doesn't follow 3-clause template)
    // The note "The report looks completely normal. I will go to check status of all other devices."
    // is suspicious - weird format, mentions checking other devices
    // Uncomment if needed:
    // const commaCount = (data.operator_notes.match(/,/g) || []).length;
    // if (commaCount < 2) {
    //   reasons.push(`Non-standard note format (${commaCount} commas, expected 2+)`);
    // }

    if (reasons.length > 0) {
      anomalies.push({ fileId, reasons });
    }
  }

  // Report
  console.log(`\n--- Results ---`);
  console.log(`Total files: ${files.length}`);
  console.log(`Anomalies found: ${anomalies.length}`);
  console.log(`Unique operator notes: ${uniqueNotes.size}`);
  console.log(`Problem notes classified: ${Array.from(uniqueNotes.values()).filter(v => v.classification === "problem").length} unique`);

  // Show problem notes for verification
  const problemNotes = Array.from(uniqueNotes.entries())
    .filter(([, info]) => info.classification === "problem");
  console.log(`\nProblem notes (${problemNotes.length} unique):`);
  for (const [note, info] of problemNotes.slice(0, 30)) {
    console.log(`  [${info.count}x] "${note}"`);
  }

  // Show sample anomalies
  console.log(`\n--- Sample anomalies (first 20) ---`);
  for (const a of anomalies.slice(0, 20)) {
    console.log(`  ${a.fileId}: ${a.reasons.join("; ")}`);
  }

  // Show unique note classifications
  console.log(`\n--- Note classifications ---`);
  const notesByClass = { ok: 0, problem: 0 };
  for (const [, info] of uniqueNotes) {
    notesByClass[info.classification as keyof typeof notesByClass] += info.count;
  }
  console.log(`  OK notes: ${notesByClass.ok}`);
  console.log(`  Problem notes: ${notesByClass.problem}`);

  // Save full anomaly list
  const anomalyIds = anomalies.map((a) => a.fileId);
  await Bun.write(
    join(OUTPUT_DIR, "anomalies.json"),
    JSON.stringify(anomalies, null, 2)
  );
  await Bun.write(
    join(OUTPUT_DIR, "anomaly_ids.json"),
    JSON.stringify(anomalyIds, null, 2)
  );

  console.log(`\nAnomaly IDs saved to output/anomaly_ids.json`);
  console.log(`Full details saved to output/anomalies.json`);

  // Also save unique notes for review
  const notesArray = Array.from(uniqueNotes.entries())
    .map(([note, info]) => ({ note, ...info }))
    .sort((a, b) => b.count - a.count);
  await Bun.write(
    join(OUTPUT_DIR, "unique_notes.json"),
    JSON.stringify(notesArray, null, 2)
  );

  return anomalyIds;
}

// --- Submit answer ---
async function submitAnswer(ids: string[]) {
  console.log(`\nSubmitting ${ids.length} anomaly IDs...`);
  const body = {
    apikey: HUB_API_KEY,
    task: "evaluation",
    answer: {
      recheck: ids,
    },
  };

  const resp = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  console.log("Response:", JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  const ids = await main();

  // Auto-submit if --submit flag is passed
  if (process.argv.includes("--submit")) {
    await submitAnswer(ids);
  }
}

export { main, submitAnswer };
