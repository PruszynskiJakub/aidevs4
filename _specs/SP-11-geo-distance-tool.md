# SP-11 geo_distance tool + agents_hub api_batch

## Main objective

1. Add a `geo_distance` tool that compares two sets of named geographic points and returns all pairs within a given radius. Designed for the agent to answer "which of these entities was near which of these locations?" in a single tool call.
2. Add an `api_batch` action to `agents_hub` that iterates over rows in a CSV/JSON file and POSTs each to a hub API endpoint — replacing N individual `api_request_body` calls with one batch call.

## Context

The findhim task (and likely future tasks) requires matching people's GPS coordinates against named locations (power plants, cities, buildings). Today the agent has no way to compute geographic distances — it would need to either guess from coordinates or make dozens of pairwise comparisons manually.

A file-based batch tool is the right fit because:
- The agent already works with JSON files (via `agents_hub`, `csv_processor`)
- Reference and query datasets can carry arbitrary metadata (names, codes, access levels) that gets passed through to results
- One tool call replaces O(n×m) individual distance checks
- Strict-mode schema stays simple (just file paths + a number) — no need to define every possible metadata field inline

The `api_batch` action solves a recurring pattern: the agent has a list of entities (people, items) and needs to call the same API endpoint for each one. Today it makes N separate `api_request_body` tool calls. With `api_batch`, it writes the list to a file, provides a field mapping, and gets all results back in one call.

## Out of scope

- Built-in geocoding (city name → coordinates) — the LLM can approximate coords for well-known cities, or a geocoding tool can be added later
- Route/driving distance — haversine (straight-line) is sufficient
- Elevation-aware distance
- Parallel/concurrent API requests (sequential is safer, avoids rate-limiting)

## Constraints

- Must use `files` service for all I/O (no raw `fs`)
- Must use `ensureOutputDir()` + `outputPath()` for output files
- Must follow multi-action tool pattern (dispatcher expands `${tool}__${action}`)
- Schemas: `additionalProperties: false` on every object, all properties in `required`, no `oneOf`/`anyOf`/type arrays
- Bun runtime, TypeScript strict mode
- Haversine formula for distance calculation (Earth radius = 6371 km)

## Acceptance criteria

### geo_distance tool

- [ ] `geo_distance__find_nearby` reads two JSON files (references + queries), computes all pairwise haversine distances, returns matches within `radius_km`
- [ ] Both input files must be JSON arrays where each item has at least `latitude` (number) and `longitude` (number) — all other fields are treated as pass-through metadata
- [ ] Throws if either file is missing, not an array, or items lack `latitude`/`longitude`
- [ ] Output: `{ count, matches }` where each match is `{ reference: {...}, query: {...}, distance_km: number }`, sorted ascending by `distance_km`
- [ ] `distance_km` is rounded to 3 decimal places
- [ ] `geo_distance__distance` computes distance between two inline points — returns `{ distance_km: number }`
- [ ] Haversine implementation is correct (validated against known city pairs in tests)
- [ ] Tests pass (`bun test src/tools/geo_distance.test.ts`)

### agents_hub api_batch action

- [ ] `agents_hub__api_batch` reads a data file (CSV or JSON array), iterates over rows, POSTs each to `/api/{path}` with `apikey` auto-injected
- [ ] Supports both `.csv` (parsed to array of objects) and `.json` (validated as array) input, detected by file extension
- [ ] `field_map_json` parameter (required, JSON string): renames source keys to target keys before sending. `"{}"` means no renaming. Unmapped fields are included as-is.
- [ ] Each API call is made sequentially (no concurrent requests)
- [ ] Results written to `output_file` as JSON array: `[{ input: {...}, response: {...} }, ...]`
- [ ] Returns `{ path, count, output_file }`
- [ ] Throws on: file not found, JSON not an array, API errors (includes partial results up to the failure)
- [ ] Schema and handler added to existing `agents_hub` tool + schema files
- [ ] Tests pass (`bun test src/tools/agents_hub.test.ts`)

## Implementation plan

### Step 1 — `agents_hub__api_batch` (extend existing tool)

1. Update `src/schemas/agents_hub.json` — add `api_batch` action:
   ```json
   "api_batch": {
     "description": "POST to /api/* for each row in a CSV/JSON array file. Apikey auto-injected. Calls made sequentially.",
     "parameters": {
       "type": "object",
       "properties": {
         "path": { "type": "string", "description": "API path segment after /api/ (e.g. \"location\")" },
         "data_file": { "type": "string", "description": "Absolute path to a CSV or JSON array file. Each row/item becomes one API call." },
         "field_map_json": { "type": "string", "description": "JSON object mapping source field names to target field names, e.g. {\"born\":\"birthYear\"}. Unmapped fields pass through. Use \"{}\" for no renaming." },
         "output_file": { "type": "string", "description": "Absolute path to write the results JSON array" }
       },
       "required": ["path", "data_file", "field_map_json", "output_file"],
       "additionalProperties": false
     }
   }
   ```

2. Update `src/tools/agents_hub.ts`:
   - Add `apiBatch(payload)` function:
     - Read `data_file` via `files.readText()` + parse (`.csv` → use csv util, `.json` → `JSON.parse()` + validate array)
     - For each row: apply `field_map` (rename keys per mapping, keep unmapped as-is), inject `apikey`
     - POST sequentially to `/api/{path}`
     - Collect `[{ input, response }]`
     - Write results to `output_file` via `files.write()`
     - Return `{ path, count, output_file }`
   - Add `"api_batch"` case to handler switch

3. Add tests to `src/tools/agents_hub.test.ts`:
   - JSON input with field mapping → correct payloads sent, results written
   - CSV input → parsed and sent correctly
   - Empty field map `"{}"` → fields pass through unchanged
   - Non-array JSON → throws
   - File not found → throws

### Step 2 — `geo_distance` tool (new tool)

1. Create `src/schemas/geo_distance.json` — multi-action schema with 2 actions:
   - `find_nearby`: `{ references_file: string, queries_file: string, radius_km: number }`
   - `distance`: `{ lat1: number, lon1: number, lat2: number, lon2: number }`

2. Create `src/tools/geo_distance.ts`:
   - `haversine(lat1, lon1, lat2, lon2): number` — pure function, returns km
   - `findNearby(payload)`:
     - Read both JSON files via `files.readText()` + `JSON.parse()`
     - Validate: must be arrays, each item must have numeric `latitude` + `longitude`
     - For every (reference, query) pair, compute haversine distance
     - Collect pairs where distance ≤ `radius_km`
     - Sort by `distance_km` ascending
     - Return `{ count, matches }` with full metadata from both sides
   - `distance(payload)`:
     - Compute and return `{ distance_km }` rounded to 3 decimals
   - Handler switches on `action`

3. Write tests `src/tools/geo_distance.test.ts`:
   - Haversine: Warsaw→Kraków ≈ 252 km (within ±5 km tolerance)
   - Haversine: same point → 0 km
   - `find_nearby`: 2 references + 3 queries, radius 10 km → correct matches only
   - `find_nearby`: no matches within radius → `{ count: 0, matches: [] }`
   - `find_nearby`: metadata pass-through (extra fields preserved in output)
   - `find_nearby`: missing latitude/longitude → throws
   - `find_nearby`: file not found → throws
   - `distance`: inline point pair → correct km

### Step 3 — Update dispatcher tests

- Update `src/tools/dispatcher.test.ts`:
  - Increment tool count by 2 (find_nearby + distance) + 1 (api_batch) = +3 total
  - Add assertions for `geo_distance__find_nearby`, `geo_distance__distance`, `agents_hub__api_batch`

## Agent workflow for findhim

```
1. agents_hub__download → findhim_locations.json (power plants by city name + code)
2. agents_hub__api_batch(path="location", data_file=suspects.json, field_map="{}", output_file=locations.json)
   → all person GPS locations in one call
3. agents_hub__api_batch(path="accesslevel", data_file=suspects.json, field_map="{\"born\":\"birthYear\"}", output_file=access_levels.json)
   → all access levels in one call
4. Agent writes references.json — power plant cities with approximate coords + codes
   (LLM knows Polish city coords within a few km — sufficient for 25 km radius)
5. Agent writes queries.json — flattened person locations with name/surname
6. geo_distance__find_nearby(references.json, queries.json, 25) → matches
7. agents_hub__verify → submit { name, surname, accessLevel, powerPlant }
```

Total: 5 tool calls instead of 12+

## Testing scenarios

### geo_distance

| Scenario            | Action       | Input                                            | Expected                            |
| ------------------- | ------------ | ------------------------------------------------ | ----------------------------------- |
| Known city pair     | distance     | Warsaw (52.23, 21.01) → Kraków (50.06, 19.94)   | ~252 km                             |
| Same point          | distance     | (50.0, 20.0) → (50.0, 20.0)                     | 0.000 km                            |
| Batch — matches     | find_nearby  | 2 refs + 3 queries, radius 10 km                 | Only close pairs returned, sorted   |
| Batch — no matches  | find_nearby  | Distant points, radius 1 km                      | `{ count: 0, matches: [] }`         |
| Metadata preserved  | find_nearby  | Refs with `code` field, queries with `name` field | Both fields in output matches       |
| Missing coords      | find_nearby  | Item without `latitude`                           | Error thrown                         |
| File not found      | find_nearby  | Non-existent path                                 | Error thrown                         |
| Inline distance     | distance     | Two lat/lon pairs                                 | `{ distance_km }`                    |

### agents_hub api_batch

| Scenario              | Input                                                   | Expected                                            |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| JSON + field mapping  | 3-item JSON array, `{"born":"birthYear"}`               | 3 API calls with renamed field, results in file     |
| JSON + empty map      | 2-item JSON array, `"{}"`                               | Fields pass through unchanged                       |
| CSV input             | 3-row CSV file                                          | Parsed to objects, 3 API calls                      |
| Non-array JSON        | JSON file containing an object instead of array          | Error thrown                                         |
| File not found        | Non-existent data_file path                              | Error thrown                                         |
