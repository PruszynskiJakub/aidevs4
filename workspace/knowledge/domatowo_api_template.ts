/**
 * Template: How to call the AG3NTS hub /verify endpoint from a standalone Bun script.
 *
 * The body is always: { apikey, task, answer: { action, ...params } }
 * Responses are JSON with a `code` field (0 = success, negative = error).
 *
 * Usage: bun run <this_file>.ts
 */

const API_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY!;
const TASK = "domatowo"; // change per task

// Reusable API call function
async function api(answer: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: API_KEY, task: TASK, answer }),
  });
  const data = await res.json();
  if (data.code < 0) {
    console.error(`API ERROR [${data.code}]:`, data.message);
    throw new Error(data.message);
  }
  return data;
}

// Example: reset, create transporter, move, dismount, inspect, callHelicopter
async function main() {
  // Reset board
  const reset = await api({ action: "reset" });
  console.log("RESET:", reset.message);

  // Create transporter with 2 scout passengers (spawns at first free slot A6→D6)
  // Response: { object: "<hash>", crew: [{ id: "<scout_hash>", role: "scout" }], spawn: "A6" }
  const t1 = await api({ action: "create", type: "transporter", passengers: 2 });
  console.log("CREATED:", t1.object, "at", t1.spawn, "with crew:", t1.crew);
  const transporterHash = t1.object;
  const scoutHashes = t1.crew.map((c: any) => c.id);

  // Move transporter (road tiles only, 1pt per tile)
  // Response: { from, where, path_steps, action_points_left }
  const mv = await api({ action: "move", object: transporterHash, where: "E2" });
  console.log("MOVED transporter to E2:", mv.path_steps, "steps, pts left:", mv.action_points_left);

  // Dismount all scouts from transporter (0 pts, scouts appear on free adjacent tiles)
  // Response: { dismounted: [hashes], spawned: [{ scout, where }] }
  const dm = await api({ action: "dismount", object: transporterHash, passengers: 2 });
  console.log("DISMOUNTED:", dm.spawned);

  // Check where everyone is now
  const objs = await api({ action: "getObjects" });
  console.log("OBJECTS:", objs.objects);

  // Find scout positions from getObjects (more reliable than dismount.spawned)
  const scouts = objs.objects.filter((o: any) => o.typ === "scout");
  for (const scout of scouts) {
    console.log(`Scout ${scout.id} at ${scout.position}`);
  }

  // Move a scout to a target and inspect
  const target = "F1";
  await api({ action: "move", object: scouts[0].id, where: target });
  await api({ action: "inspect", object: scouts[0].id });

  // Check logs - look for "Odnalazłem osobę" meaning person found
  const logs = await api({ action: "getLogs" });
  const lastLog = logs.logs[logs.logs.length - 1];
  console.log("INSPECT LOG:", lastLog.msg, "at", lastLog.field);

  if (lastLog.msg.includes("Odnalaz")) {
    // Person found! Call helicopter to this location
    const heli = await api({ action: "callHelicopter", destination: lastLog.field });
    console.log("HELICOPTER:", heli.message);
    // heli.message contains the flag if successful
  }
}

main().catch(console.error);
