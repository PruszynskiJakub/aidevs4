/**
 * Windpower timed task solver
 *
 * Reactive event-loop approach:
 * 1. Fire all async requests immediately after start
 * 2. Poll getResult in tight loop, dispatching work as results arrive
 * 3. Submit config + turbinecheck + done at the end
 */

const VERIFY_URL = "https://hub.ag3nts.org/verify";
const TASK = "windpower";
const API_KEY = process.env.HUB_API_KEY;
if (!API_KEY) throw new Error("HUB_API_KEY env var not set");

// ─── API helper ───

async function post(answer: Record<string, unknown>): Promise<any> {
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: API_KEY, task: TASK, answer }),
  });
  const json = await res.json();
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Types ───

interface Slot {
  startDate: string;   // YYYY-MM-DD
  startHour: number;   // 0-23
  hourStr: string;     // "HH:00"
  windMs: number;
  pitchAngle: number;  // 0, 45, or 90
  turbineMode: "production" | "idle";
  unlockCode?: string;
}

// ─── Main ───

async function main() {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const remaining = () => 39_000 - elapsed();

  // Phase 1: Start session
  const startResp = await post({ action: "start" });
  console.log("[start]", JSON.stringify(startResp));

  // Phase 2: Fire all async requests in parallel
  const [docResp] = await Promise.all([
    post({ action: "get", param: "documentation" }),
    post({ action: "get", param: "weather" }),
    post({ action: "get", param: "powerplantcheck" }),
  ]);
  console.log("[docs]", JSON.stringify(docResp));

  // Extract safety rules from documentation
  const cutoffWind = docResp?.safety?.cutoffWindMs ?? 14;
  const minOperationalWind = docResp?.safety?.minOperationalWindMs ?? 4;
  console.log(`[rules] cutoff=${cutoffWind} m/s, minOp=${minOperationalWind} m/s`);

  // Phase 3: Reactive polling loop
  let weatherData: any = null;
  let powerplantData: any = null;
  let turbinecheckData: any = null;
  const slots: Slot[] = [];
  let slotsBuilt = false;
  let unlockCodesRequested = false;
  let unlockCodesReceived = 0;
  let configSubmitted = false;
  let turbinecheckRequested = false;
  let weatherRetryAt = [12_000, 20_000]; // retry weather at these elapsed times
  let weatherRetryIdx = 0;

  while (remaining() > 1000) {
    const res = await post({ action: "getResult" });

    // Rate limit
    if (res?.code === -9999) {
      await sleep(500);
      continue;
    }

    // Nothing ready
    if (res?.code === 11) {
      // Retry weather at scheduled times
      if (!weatherData && weatherRetryIdx < weatherRetryAt.length && elapsed() > weatherRetryAt[weatherRetryIdx]) {
        weatherRetryIdx++;
        console.log(`[weather-retry-${weatherRetryIdx}]`);
        await post({ action: "get", param: "weather" });
      }

      // Check if ALL unlock codes are in and we can submit
      if (slotsBuilt && !configSubmitted) {
        const ready = slots.filter((s) => s.unlockCode);
        const needed = slots.filter((s) => !s.unlockCode);
        // Submit when all codes received, or as last resort with <3s left
        if (needed.length === 0 || (ready.length > 0 && remaining() < 3000)) {
          await submitConfig(ready);
          configSubmitted = true;
        }
      }

      // Request turbinecheck after config submitted
      if (configSubmitted && !turbinecheckRequested) {
        console.log("[requesting turbinecheck]");
        await post({ action: "get", param: "turbinecheck" });
        turbinecheckRequested = true;
      }

      // If turbinecheck done, send done
      if (turbinecheckRequested && turbinecheckData && remaining() > 1000) {
        break; // exit loop, send done below
      }

      await sleep(200);
      continue;
    }

    // Got a result — classify it
    const src = res?.sourceFunction || "";
    console.log(`[result:${src}]`, JSON.stringify(res).slice(0, 200));

    if (src === "weather") {
      weatherData = res;
    } else if (src === "powerplantcheck") {
      powerplantData = res;
    } else if (src === "turbinecheck") {
      turbinecheckData = res;
    } else if (src === "unlockCodeGenerator") {
      // Match unlock code back to slot
      const sp = res.signedParams || res;
      const sd = sp.startDate || res.startDate;
      const sh = sp.startHour || res.startHour; // "HH:00:00"
      const code = res.unlockCode;

      if (sd && sh && code) {
        // Normalize hour: "18:00:00" → 18, "18:00" → 18
        const hourNum = parseInt(String(sh).split(":")[0], 10);
        const match = slots.find(
          (s) => s.startDate === sd && s.startHour === hourNum && !s.unlockCode
        );
        if (match) {
          match.unlockCode = code;
          unlockCodesReceived++;
          console.log(`[unlock matched] ${sd} ${sh} → ${code.slice(0, 8)}...`);
        } else {
          console.log(`[unlock unmatched] ${sd} ${sh} code=${code.slice(0, 8)}...`);
        }
      }
    }

    // Build slots when weather arrives
    if (weatherData && !slotsBuilt) {
      buildSlots(weatherData, cutoffWind, minOperationalWind);
      slotsBuilt = true;
    }

    // Request unlock codes once slots are built
    if (slotsBuilt && !unlockCodesRequested) {
      requestUnlockCodes();
      unlockCodesRequested = true;
    }

    await sleep(100);
  }

  // Final: submit config if not done yet
  if (!configSubmitted && slotsBuilt) {
    const ready = slots.filter((s) => s.unlockCode);
    if (ready.length > 0) {
      await submitConfig(ready);
      configSubmitted = true;
    }
  }

  // Turbinecheck if not requested
  if (configSubmitted && !turbinecheckRequested) {
    console.log("[requesting turbinecheck late]");
    await post({ action: "get", param: "turbinecheck" });
    turbinecheckRequested = true;
    // Quick poll for turbinecheck
    const deadline = Date.now() + Math.min(5000, remaining() - 1000);
    while (Date.now() < deadline) {
      const res = await post({ action: "getResult" });
      if (res?.sourceFunction === "turbinecheck") {
        turbinecheckData = res;
        console.log("[turbinecheck]", JSON.stringify(res).slice(0, 200));
        break;
      }
      await sleep(200);
    }
  }

  // Only send done if we actually submitted config and have turbinecheck
  if (!configSubmitted) {
    console.log("[ABORT] No config submitted");
  } else if (!turbinecheckData) {
    console.log("[ABORT] No turbinecheck result received");
  } else if (remaining() > 500) {
    const doneResp = await post({ action: "done" });
    console.log("[DONE]", JSON.stringify(doneResp));
  } else {
    console.log("[TIMEOUT] Not enough time to send done");
  }

  console.log(`\nTotal elapsed: ${elapsed()}ms`);
  console.log(`Slots: ${slots.length}, with codes: ${slots.filter((s) => s.unlockCode).length}`);

  // ─── Helpers (closures over slots) ───

  function buildSlots(
    weather: any,
    cutoff: number,
    minOp: number
  ) {
    const forecast = weather.forecast || [];
    console.log(`[buildSlots] forecast entries: ${forecast.length}`);

    for (const entry of forecast) {
      const ts = String(entry.timestamp || "");
      const m = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/);
      if (!m) continue;

      const startDate = m[1];
      const hour = parseInt(m[2], 10);
      const windMs = Number(entry.windMs);
      if (!Number.isFinite(windMs)) continue;

      let pitchAngle: number;
      let turbineMode: "production" | "idle";

      if (windMs > cutoff) {
        // Storm: feather blades, disable generation
        pitchAngle = 90;
        turbineMode = "idle";
      } else if (windMs >= minOp) {
        // Potential production: maximize generation
        pitchAngle = 0;
        turbineMode = "production";
      } else {
        // Too little wind — skip
        continue;
      }

      slots.push({
        startDate,
        startHour: hour,
        hourStr: `${String(hour).padStart(2, "0")}:00`,
        windMs,
        pitchAngle,
        turbineMode,
      });
    }

    // Keep ALL storm slots but only the BEST production slot (highest wind)
    const storms = slots.filter((s) => s.turbineMode === "idle");
    const prods = slots
      .filter((s) => s.turbineMode === "production")
      .sort((a, b) => b.windMs - a.windMs);

    const bestProd = prods[0];
    slots.length = 0;
    slots.push(...storms);
    if (bestProd) slots.push(bestProd);

    console.log(
      `[buildSlots] ${slots.length} final slots: ` +
        `${slots.filter((s) => s.turbineMode === "production").length} production (best: ${bestProd?.windMs} m/s), ` +
        `${storms.length} storm-idle`
    );
  }

  async function requestUnlockCodes() {
    console.log(`[requestUnlockCodes] requesting ${slots.length} codes`);
    await Promise.all(
      slots.map((s) =>
        post({
          action: "unlockCodeGenerator",
          startDate: s.startDate,
          startHour: s.hourStr,
          windMs: s.windMs,
          pitchAngle: s.pitchAngle,
        })
      )
    );
  }

  async function submitConfig(readySlots: Slot[]) {
    // Build configs object keyed by "YYYY-MM-DD HH:00:00"
    const configs: Record<string, any> = {};
    for (const s of readySlots) {
      const key = `${s.startDate} ${s.hourStr}:00`;
      configs[key] = {
        pitchAngle: s.pitchAngle,
        turbineMode: s.turbineMode,
        unlockCode: s.unlockCode!,
      };
    }

    console.log(`[submitConfig] ${Object.keys(configs).length} entries`);
    const resp = await post({ action: "config", configs });
    console.log("[config response]", JSON.stringify(resp).slice(0, 300));
  }
}

main().catch((err) => {
  console.error("FATAL:", err?.stack || String(err));
  process.exit(1);
});