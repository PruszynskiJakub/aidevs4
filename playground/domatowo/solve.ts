/**
 * Domatowo rescue solver — searches all B3 (3-story) blocks for the partisan.
 *
 * Detection strategy: after each inspect, try callHelicopter (0 pts cost).
 * If the API accepts it, the partisan was found. No NLP needed.
 *
 * Usage: bun run playground/domatowo/solve.ts
 */

const API_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY!;
const TASK = "domatowo";

async function api(answer: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: API_KEY, task: TASK, answer }),
  });
  const data = await res.json();
  console.log(`[${answer.action}] code=${data.code} pts_left=${data.action_points_left ?? "?"}`);
  if (data.code < 0) {
    console.error(`  ERROR: ${data.message}`);
  }
  return data;
}

// B3 clusters with optimal road drop points
const CLUSTERS = [
  { dropPoint: "E2", blocks: ["F1", "G1", "F2", "G2"] },
  { dropPoint: "B9", blocks: ["B10", "A10", "C10", "B11", "A11", "C11"] },
  { dropPoint: "I9", blocks: ["I10", "H10", "I11", "H11"] },
];

function manhattan(a: string, b: string): number {
  return (
    Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) +
    Math.abs(Number(a.slice(1)) - Number(b.slice(1)))
  );
}

async function main() {
  // 1. Reset
  await api({ action: "reset" });
  console.log("\n--- Board reset ---\n");

  // 2. Create 3 transporters with 2 scouts each
  const transporters: Array<{ id: string; scouts: string[] }> = [];
  for (let i = 0; i < 3; i++) {
    const t = await api({ action: "create", type: "transporter", passengers: 2 });
    transporters.push({
      id: t.object,
      scouts: t.crew.map((c: any) => c.id),
    });
    console.log(`  T${i + 1}: ${t.object.slice(0, 8)} at ${t.spawn}`);
  }

  // 3. Move each transporter to its cluster's drop point
  for (let i = 0; i < 3; i++) {
    const mv = await api({
      action: "move",
      object: transporters[i].id,
      where: CLUSTERS[i].dropPoint,
    });
    console.log(`  T${i + 1} → ${CLUSTERS[i].dropPoint} (${mv.path_steps} steps)`);
  }

  // 4. Dismount all scouts
  for (let i = 0; i < 3; i++) {
    await api({ action: "dismount", object: transporters[i].id, passengers: 2 });
  }

  // 5. Get actual scout positions
  const objs = await api({ action: "getObjects" });
  const scoutPositions = new Map<string, string>();
  for (const o of objs.objects) {
    if (o.typ === "scout") {
      scoutPositions.set(o.id, o.position);
    }
  }
  console.log(`  ${scoutPositions.size} scouts deployed\n`);

  // 6. Search all B3 tiles cluster by cluster
  for (let ci = 0; ci < CLUSTERS.length; ci++) {
    const cluster = CLUSTERS[ci];
    console.log(`--- Cluster ${ci + 1} (${cluster.dropPoint}) ---`);

    // Get scouts near this cluster
    const nearby = new Map<string, string>();
    for (const [id, pos] of scoutPositions) {
      if (manhattan(pos, cluster.dropPoint) <= 3) {
        nearby.set(id, pos);
      }
    }

    for (const block of cluster.blocks) {
      // Find closest scout
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const [id, pos] of nearby) {
        const d = manhattan(pos, block);
        if (d < bestDist) { bestDist = d; bestId = id; }
      }
      if (!bestId) continue;

      // Move if needed
      if (nearby.get(bestId) !== block) {
        const mv = await api({ action: "move", object: bestId, where: block });
        if (mv.code < 0) continue; // skip if move failed
      }
      nearby.set(bestId, block);

      // Inspect
      await api({ action: "inspect", object: bestId });

      // Try helicopter — costs 0 pts, definitive check
      const heli = await api({ action: "callHelicopter", destination: block });
      if (heli.code >= 0) {
        console.log(`\n🚁 EVACUATED FROM ${block}: ${heli.message}`);
        return;
      }
      // Not found here, continue
    }

    // Sync positions back
    for (const [id, pos] of nearby) {
      scoutPositions.set(id, pos);
    }
  }

  console.log("\n❌ Partisan not found!");
}

main().catch(console.error);
