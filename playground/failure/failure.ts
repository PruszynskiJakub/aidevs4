/**
 * Failure task — condense power plant failure logs to ≤1500 tokens.
 * Strategy: chronological narrative of the failure, deduplicated,
 * with first occurrence of each event type + key escalation moments.
 */

const HUB_API_KEY = process.env.HUB_API_KEY!;
const HUB_BASE = "https://hub.ag3nts.org";
const VERIFY_URL = `${HUB_BASE}/verify`;
const LOG_URL = `${HUB_BASE}/data/${HUB_API_KEY}/failure.log`;
const OUTPUT_DIR = `${import.meta.dir}/output`;

// ── Helpers ──────────────────────────────────────────────────────────

/** Conservative token estimate: ~1 token per 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function downloadLog(): Promise<string> {
  console.log("Downloading log file...");
  const res = await fetch(LOG_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  await Bun.write(`${OUTPUT_DIR}/failure_full.log`, text);
  return text;
}

interface LogEntry {
  time: string;       // "HH:MM"
  date: string;       // "YYYY-MM-DD"
  level: string;      // WARN, ERRO, CRIT
  component: string;  // ECCS8, PWR01, etc.
  message: string;    // Full message after component
  raw: string;        // Original line
}

function parseLine(line: string): LogEntry | null {
  const m = line.match(
    /^\[(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}):\d{2}\]\s+\[(WARN|ERRO|CRIT)\]\s+(.*)/
  );
  if (!m) return null;
  const [, date, time, level, rest] = m;

  // Extract component ID (first word if it's ALLCAPS+digits)
  const compMatch = rest.match(/^([A-Z][A-Z0-9_]+)\b/);
  const component = compMatch ? compMatch[1] : "UNKNOWN";
  const message = rest;

  return { date, time, level, component, message, raw: line };
}

/** Create a signature for deduplication (level + normalized message) */
function signature(entry: LogEntry): string {
  return `${entry.level}|${entry.message}`;
}

/** Compress a log entry into a short line */
function compress(entry: LogEntry): string {
  const { date, time, level, message } = entry;
  // Shorten messages
  let short = message
    .replace(/Protection interlock initiated reactor trip\.?/, "Reactor trip.")
    .replace(/Immediate protective actions are required\.?/, "Immediate action required.")
    .replace(/Shutdown logic is moving to hard trip stage\.?/, "Hard trip initiated.")
    .replace(/Core loop continuity is compromised\.?/, "Core loop compromised.")
    .replace(/Heat rejection is no longer sufficient\.?/, "Heat rejection insufficient.")
    .replace(/Energy conversion is terminated\.?/, "Energy conversion terminated.")
    .replace(/Manual override is locked\.?/, "Manual override locked.")
    .replace(/entered emergency guard branch after repeated safety faults\.?/, "emergency guard active, safety faults.")
    .replace(/can no longer sustain stable feed for cooling auxiliaries\. Critical loads are shedding\.?/, "cooling feed lost. Load shedding.")
    .replace(/reported runaway outlet temperature\.?/, "runaway outlet temp.")
    .replace(/core cooling cannot maintain safe gradient\.?/, "cooling gradient unsafe.")
    .replace(/cannot remove heat with the current WTANK07 volume\. Reactor protection initiates critical stop\.?/, "insufficient WTANK07 for heat removal. Critical stop.")
    .replace(/lost stable prime under peak thermal demand\.?/, "lost prime under thermal demand.")
    .replace(/coolant level is below critical threshold\.?/, "coolant below critical.")
    .replace(/absorption path reached emergency boundary\.?/, "absorption at emergency limit.")
    .replace(/validation queue returned nonblocking fault set\. Runtime proceeds in constrained mode\.?/, "nonblocking fault. Constrained mode.")
    .replace(/feedback loop exceeded correction budget\. Thermal conversion rate is reduced\.?/, "correction budget exceeded. Reduced conversion.")
    .replace(/reported repeated cavitation signatures\. Output pressure cannot be held at requested level\.?/, "cavitation. Pressure unstable.")
    .replace(/failed a recovery step in the active sequence\. The subsystem remains in degraded operation mode\.?/, "recovery failed. Degraded mode.")
    .replace(/returned inconsistent feedback under load\. Automatic fallback path has been applied\.?/, "inconsistent feedback. Fallback active.")
    .replace(/Operational fault persisted on .+ after retry cycle\. Performance constraints are now enforced\.?/, (m) => {
      const comp = m.match(/on ([A-Z0-9]+)/)?.[1] || "";
      return `${comp} fault persisted. Constrained.`;
    })
    .replace(/transient disturbed auxiliary pump control\. Recovery completed with degraded margin\.?/, "transient disturbed aux pump. Degraded margin.")
    .replace(/suction profile is inconsistent with expected coolant volume\. Mechanical stress is increasing\.?/, "suction inconsistent. Mechanical stress rising.")
    .replace(/dropped below operational target\. Compensating commands did not recover nominal state\.?/, "below target. Compensation failed.")
    .replace(/indicates unstable refill trend\. Available coolant inventory is no longer guaranteed\.?/, "unstable refill. Coolant not guaranteed.")
    .replace(/level estimate dropped near minimum reserve line\. Automatic refill request timed out\.?/, "near minimum. Refill timed out.")
    .replace(/exceeded error budget\. Further recovery attempts are limited\.?/, "error budget exceeded. Recovery limited.")
    .replace(/return circuit temperature rose faster than prediction\. Emergency bias remains armed\.?/, "return temp rising fast. Emergency bias armed.")
    .replace(/is below critical reserve for sustained operation\. Protective shutdown path is being enforced\.?/, "below critical reserve. Shutdown enforced.")
    .replace(/fails to recover thermal margin while WTANK07 remains partially filled\. Shutdown criteria are approaching\.?/, "thermal margin unrecoverable. Shutdown approaching.")
    .replace(/Heat transfer path to WSTPOOL2 is saturated\. Dissipation lag continues to accumulate\.?/, "WSTPOOL2 heat path saturated. Lag accumulating.")
    .replace(/Cooling efficiency on ECCS8 /, "ECCS8 cooling ")
    .replace(/Pressure jitter near STMTURB12 is above baseline\. Automatic damping remains engaged\.?/, "STMTURB12 pressure jitter. Damping engaged.")
    .replace(/Thermal drift on ECCS8 exceeds advisory threshold\. Corrective ramp is queued\.?/, "ECCS8 thermal drift. Corrective ramp queued.")
    .replace(/Fill trajectory in WTANK07 is slower than expected\. Cooling reserve may become constrained\.?/, "WTANK07 fill slow. Cooling reserve constrained.")
    .replace(/Flow margin on WTRPMP is below preferred startup profile\. Monitoring continues without immediate trip\.?/, "WTRPMP flow margin low. Monitoring.")
    .replace(/Input ripple on PWR01 crossed warning limits\. Stability window is narrowed\.?/, "PWR01 input ripple. Stability narrowed.")
    .replace(/reports rising return temperature\. Cooling headroom is decreasing\.?/, "return temp rising. Headroom decreasing.")
    .replace(/shows moderate parameter drift during initialization\. Automatic correction remains active\.?/, "param drift at init. Auto-correction active.")
    .replace(/FIRMWARE reports a trend outside preferred startup envelope\. Monitoring intensity has been increased\.?/, "FIRMWARE trend outside envelope. Monitoring increased.")
    .replace(/FIRMWARE watchdog acknowledged delayed subsystem poll\. Retry timer is active\.?/, "FIRMWARE watchdog delayed poll. Retry active.")
    .replace(/duty cycle is elevated for current load\. Extended operation may reduce efficiency\.?/, "duty cycle elevated. Efficiency may drop.")
    .replace(/reports a trend outside preferred startup envelope\. Monitoring intensity has been increased\.?/, "trend outside envelope. Monitoring increased.")
    .replace(/Level sensor reconciliation for WTANK07 returned minor mismatch\. Secondary read is requested\.?/, "WTANK07 level sensor mismatch. Secondary read.")
    .replace(/Waste heat relay to WSTPOOL2 is approaching soft cap\. Throughput tuning is required\.?/, "WSTPOOL2 waste heat near cap. Tuning needed.")
    .replace(/Advisory threshold crossed on WTANK07\. Control loop continues with reduced tolerance\.?/, "WTANK07 advisory threshold. Reduced tolerance.")
    .replace(/Cooling reserve trend in WTANK07 keeps falling during load rise\. ECCS8 is approaching a nonrecoverable limit\.?/, "WTANK07 reserve falling. ECCS8 near limit.")
    .replace(/Preventive warning issued for .+ due to unstable short-term readings\. Escalation rules are armed\.?/, (m) => {
      const comp = m.match(/for ([A-Z0-9]+)/)?.[1] || "";
      return `${comp} unstable readings. Escalation armed.`;
    })
    .replace(/Power stability on PWR01 is highly unstable under startup load\. Adding an additional power source is strongly recommended\.?/, "PWR01 highly unstable. Additional power recommended.")
    .replace(/Cross-check between FIRMWARE and hardware interface map did not complete successfully\. Compatibility verification remains unresolved for startup state\.?/, "FIRMWARE hardware cross-check failed. Unresolved.")
    .replace(/Safety bootstrap read missing environment marker SAFETY_CHECK=pass\. FIRMWARE continues in restricted validation mode\.?/, "FIRMWARE missing SAFETY_CHECK=pass. Restricted mode.")
    .replace(/entered critical protection state during startup\. Immediate shutdown safeguards remain active\.?/, "critical protection at startup. Shutdown safeguards active.")
    .replace(/Critical boundary exceeded on ECCS8\. Emergency interlock keeps the reactor in protected mode\.?/, "ECCS8 boundary exceeded. Reactor protected.")
    .replace(/Coolant inventory in WTANK07 is below critical threshold for full-loop operation\. ECCS8 cannot guarantee reactor heat removal and automatic shutdown is mandatory\.?/, "WTANK07 below critical for loop. ECCS8 shutdown mandatory.")
    .replace(/Insufficient cooling capacity confirmed after incomplete WTANK07 refill\. Reactor protection system executes final shutdown sequence\.?/, "WTANK07 refill incomplete. Final shutdown.")
    .replace(/Final trip complete because WTANK07 remained under critical water level\. FIRMWARE confirms safe shutdown state with all core operations halted\.?/, "WTANK07 critical. FIRMWARE confirms safe shutdown. All ops halted.");

  return `[${date} ${time}] [${level}] ${short}`;
}

async function submitLogs(logs: string): Promise<any> {
  const body = {
    apikey: HUB_API_KEY,
    task: "failure",
    answer: { logs },
  };

  const tokens = estimateTokens(logs);
  const lineCount = logs.split("\n").length;
  console.log(`\nSubmitting ${lineCount} events, ~${tokens} est tokens...`);

  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const response = await res.json().catch(() => res.text());
  console.log("Response:", JSON.stringify(response, null, 2));
  return response;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const raw = await downloadLog();
  const allLines = raw.split("\n").filter((l) => l.trim());
  console.log(`Total lines: ${allLines.length}`);

  // Parse all non-INFO lines
  const entries: LogEntry[] = [];
  for (const line of allLines) {
    if (line.includes("[INFO]")) continue;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  console.log(`Non-INFO entries: ${entries.length}`);

  // Deduplicate: keep first occurrence of each unique message
  const seen = new Set<string>();
  const unique: LogEntry[] = [];
  for (const entry of entries) {
    const sig = signature(entry);
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(entry);
    }
  }
  console.log(`Unique event types: ${unique.length}`);

  // Compress each line
  const compressed = unique.map(compress);

  // Drop redundant WARN lines to fit budget (keep CRIT/ERRO, trim WARN)
  // Lines that are redundant with nearby ERRO/CRIT events:
  const dropPatterns = [
    "ECCS8 param drift at init",         // minor, already have many ECCS8 events
    "WSTPOOL2 param drift at init",       // minor init drift
    "WTANK07 advisory threshold",         // redundant with WTANK07 CRIT/ERRO
    "WTANK07 trend outside envelope",     // redundant
    "WTANK07 unstable readings",          // redundant with ERRO unstable refill
  ];
  const filtered = compressed.filter(
    (line) => !dropPatterns.some((p) => line.includes(p)),
  );

  let logsStr = filtered.join("\n");
  let tokens = estimateTokens(logsStr);
  console.log(`Compressed tokens: ${tokens}, lines: ${filtered.length}`);
  console.log(`Chars: ${logsStr.length}`);

  // Save
  await Bun.write(`${OUTPUT_DIR}/condensed.txt`, logsStr);
  console.log("\n--- CONDENSED LOGS ---");
  console.log(logsStr);
  console.log("--- END ---\n");

  // Submit
  const result = await submitLogs(logsStr);
  await Bun.write(`${OUTPUT_DIR}/result.json`, JSON.stringify(result, null, 2));
}

main().catch(console.error);
