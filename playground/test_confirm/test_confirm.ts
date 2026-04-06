/**
 * Manual integration test for the HTTP confirmation gate.
 *
 * 1. Opens an SSE stream to /chat with a prompt that triggers web__scrape
 * 2. Waits for a confirmation.requested event
 * 3. Posts approval (or denial) to /chat/:sessionId/confirm
 * 4. Waits for the final "done" event and prints the answer
 *
 * Usage:
 *   bun run playground/test_confirm/test_confirm.ts [approve|deny]
 */

const BASE = "http://localhost:3000";
const API_SECRET = process.env.API_SECRET ?? "";
const SESSION_ID = `confirm-test-${Date.now()}`;
const DECISION = (process.argv[2] ?? "approve") as "approve" | "deny";

function authHeaders(): Record<string, string> {
  return API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {};
}

console.log(`Session:  ${SESSION_ID}`);
console.log(`Decision: ${DECISION}`);
console.log(`---`);

// ── Step 1: Open SSE stream ──────────────────────────────────

const res = await fetch(`${BASE}/chat`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...authHeaders(),
  },
  body: JSON.stringify({
    sessionId: SESSION_ID,
    msg: "Scrape https://example.com and summarize it in one sentence",
    stream: true,
  }),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
let confirmed = false;
let done = false;

while (!done) {
  const { value, done: streamDone } = await reader.read();
  if (streamDone) break;

  buffer += decoder.decode(value, { stream: true });

  // Parse SSE events from buffer
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // keep incomplete line in buffer

  let currentEvent = "";
  let currentData = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent) {
      // End of event
      await handleEvent(currentEvent, currentData);
      currentEvent = "";
      currentData = "";
    }
  }
}

console.log("\n--- Stream ended ---");

async function handleEvent(event: string, data: string) {
  if (event === "heartbeat") return;

  if (event === "agent_event") {
    try {
      const parsed = JSON.parse(data);
      const type = parsed.type as string;

      console.log(`[SSE] ${type}`);

      if (type === "confirmation.requested" && !confirmed) {
        confirmed = true;
        const calls = parsed.data.calls as Array<{ callId: string; toolName: string }>;
        console.log(`\n  Confirmation requested for:`);
        for (const c of calls) {
          console.log(`    - ${c.toolName} (${c.callId})`);
        }

        // Build decisions
        const decisions: Record<string, string> = {};
        for (const c of calls) {
          decisions[c.callId] = DECISION;
        }

        console.log(`  Sending decision: ${DECISION}`);
        const confirmRes = await fetch(`${BASE}/chat/${SESSION_ID}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisions }),
        });
        const confirmJson = await confirmRes.json();
        console.log(`  Confirm response: ${JSON.stringify(confirmJson)}\n`);
      }

      if (type === "confirmation.resolved") {
        console.log(`  Resolved — approved: ${parsed.data.approved?.length ?? 0}, denied: ${parsed.data.denied?.length ?? 0}`);
      }

      if (type === "tool.succeeded") {
        console.log(`  Tool succeeded: ${parsed.data.name} (${Math.round(parsed.data.durationMs)}ms)`);
      }
      if (type === "tool.failed") {
        console.log(`  Tool failed: ${parsed.data.name} — ${parsed.data.error?.slice(0, 100)}`);
      }
    } catch {
      console.log(`[SSE] ${event}: (parse error) ${data.slice(0, 100)}`);
    }
  } else if (event === "done") {
    try {
      const parsed = JSON.parse(data);
      console.log(`\n=== ANSWER ===\n${parsed.answer}\n`);
    } catch {
      console.log(`[done] ${data}`);
    }
    done = true;
  } else if (event === "error") {
    console.error(`[error] ${data}`);
    done = true;
  }
}