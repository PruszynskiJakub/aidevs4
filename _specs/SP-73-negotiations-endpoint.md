# SP-73 Negotiations endpoint

## Main objective

Add a `POST /api/negotiations/search` endpoint that delegates natural-language
item queries to a dedicated subagent, enabling an external agent from
hub.ag3nts.org to discover which Polish cities sell specific electronic
components.

## Context

Task **negotiations** (s03e04) requires exposing 1-2 HTTP tool endpoints that
an external hub agent calls to locate cities offering all items it needs for a
wind turbine. The external agent sends up to 10 requests with natural-language
Polish queries like *"potrzebuję rezystora 10 ohm"* and expects concise city
lists back.

Three CSV reference files already exist in `workspace/knowledge/reference/`:

| File | Columns | Rows | Purpose |
|---|---|---|---|
| `Cities Data.csv` | name, code | 51 | City name ↔ city code |
| `s03e04 items.csv` | name, code | 2 137 | Item name ↔ item code |
| `Connections s03e04.csv` | itemCode, cityCode | 5 349 | Which city sells which item |

The project already has `grep`, `glob`, `read_file`, and `think` tools
registered. The agent loop no longer includes a plan phase (SP-72), so a single
turn costs 1 LLM call + tool dispatch.

## Out of scope

- Custom CSV-search tool — the subagent uses existing `grep`/`read_file` tools
- Persistent sessions across queries — each request is stateless
- Automatic ngrok/tunnel setup — user manages public URL exposure
- Modifying grep tool limits — the subagent prompt instructs narrow patterns

## Constraints

- Response body (`output` field) must be 4-500 bytes
- External agent has max 10 steps total (across all tool calls)
- Max 2 tool URLs can be registered with the hub (we use 1)
- `gpt-4.1-mini` model for the subagent (fast, cheap, handles Polish)
- Memory subsystem disabled for this subagent (stateless, minimal latency)
- Subagent may only read files in `workspace/knowledge/reference/`

## Acceptance criteria

- [ ] `POST /api/negotiations/search` endpoint exists in `src/server.ts`
- [ ] Endpoint accepts `{ "params": "..." }` and returns `{ "output": "..." }`
- [ ] Returns 4-500 byte output containing comma-separated city names
- [ ] Subagent resolves Polish natural-language queries to matching items via
      case-insensitive grep on `s03e04 items.csv`
- [ ] Subagent cross-references item codes → city codes → city names across all
      3 CSV files
- [ ] Works for specific queries like "rezystor 10 ohm" and inflected forms
      like "potrzebuję kabla długości 10 metrów"
- [ ] Subagent uses `gpt-4.1-mini` with memory disabled
- [ ] `playground/negotiations/submit.ts` submits tool URL to hub and polls
      for result
- [ ] `workspace/agents/negotiations.agent.md` created with correct
      frontmatter and system prompt
- [ ] `workspace/knowledge/_index.md` updated with references to all 3 CSV
      files

## Implementation plan

### 1. Create the subagent definition

**File:** `workspace/agents/negotiations.agent.md`

```yaml
---
name: negotiations
model: gpt-4.1-mini
tools:
  - think
  - grep
  - read_file
memory: false
---
```

System prompt teaches the agent:
- **Data model:** item name → item code (`s03e04 items.csv`), item code →
  city code (`Connections s03e04.csv`), city code → city name
  (`Cities Data.csv`)
- **File paths:** absolute paths to all 3 CSVs in
  `workspace/knowledge/reference/`
- **Search strategy:** use `grep` with case-insensitive flag on the items CSV
  to find matching item codes, then grep connections CSV for those codes, then
  resolve city codes to names via the cities CSV
- **Narrow patterns:** always grep with specific multi-word patterns (e.g.
  `rezystor.*10.*ohm`) to avoid hitting the 200-line cap; if a broad term
  returns too many results, add more qualifiers from the query
- **Polish morphology:** strip inflectional suffixes mentally — search for
  word stems (e.g. query says "kabla" → grep for `kabel` or `kabl`)
- **Output format:** return ONLY a comma-separated list of city names, nothing
  else — response must fit in 500 bytes

### 2. Add the endpoint to the server

**File:** `src/server.ts`

Add `POST /api/negotiations/search`:

```typescript
app.post("/api/negotiations/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const params = body?.params;
  if (!params || typeof params !== "string") {
    return c.json({ output: "Error: params field required" }, 400);
  }

  const { answer } = await executeTurn({
    prompt: params,
    assistant: "negotiations",
  });

  // Truncate to 500 bytes if needed
  const output = new TextEncoder().encode(answer).slice(0, 500);
  return c.json({ output: new TextDecoder().decode(output) });
});
```

Key details:
- No session queueing (stateless, concurrent requests OK)
- No session ID passed — each call gets a fresh auto-generated session
- Wraps `executeTurn` result in `{ output }` format expected by the hub agent
- Truncates to 500-byte limit as safety net

### 3. Disable memory for the subagent

Check how the agent loop reads the `memory` frontmatter field. If not already
supported, add a check in `src/agent/loop.ts` or `src/agent/orchestrator.ts`
to skip `processMemory()` and `flushMemory()` when
`agentConfig.memory === false`.

### 4. Create the submission script

**File:** `playground/negotiations/submit.ts`

```typescript
// 1. POST tool URLs to /verify
fetch(VERIFY_URL, {
  method: "POST",
  body: JSON.stringify({
    apikey: HUB_API_KEY,
    task: "negotiations",
    answer: {
      tools: [{
        URL: `${BASE_URL}/api/negotiations/search`,
        description: "Search for electronic components by name or description (in Polish). Pass the item name or natural language description in the 'params' field. Returns a comma-separated list of Polish city names where the item is available for purchase."
      }]
    }
  })
});

// 2. Wait 30-60 seconds, then poll with action: "check"
fetch(VERIFY_URL, {
  method: "POST",
  body: JSON.stringify({
    apikey: HUB_API_KEY,
    task: "negotiations",
    answer: { action: "check" }
  })
});
```

Reads `HUB_API_KEY` from env and `BASE_URL` from env or CLI arg
(the public ngrok/tunnel URL).

### 5. Update knowledge index

**File:** `workspace/knowledge/_index.md`

Add entries for all 3 CSV files under the Reference section with brief
descriptions of their schema and purpose.

## Testing scenarios

1. **Happy path — specific item query:**
   `curl -X POST localhost:3000/api/negotiations/search -d '{"params":"rezystor 10 ohm"}'`
   → response contains `{ "output": "CityA, CityB, ..." }` with valid city
   names from Cities Data.csv

2. **Polish inflected query:**
   `curl -d '{"params":"potrzebuję kondensatora ceramicznego 10 pF"}'`
   → returns cities that sell matching capacitors

3. **Missing params field:**
   `curl -d '{"foo":"bar"}'` → returns 400 with error message

4. **Output size:** verify response `output` field is between 4 and 500 bytes

5. **End-to-end submission:**
   Run `submit.ts` with ngrok URL → hub agent calls our endpoint → poll with
   `action: "check"` → receive flag

6. **Broad query doesn't break:**
   `curl -d '{"params":"dioda"}'` → returns results without grep truncation
   errors (agent narrows the pattern automatically)