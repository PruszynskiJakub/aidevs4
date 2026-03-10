# SP-01 Merge CSV tools into unified csv_processor

## Main objective

Replace three separate CSV tools (`read_csv_structure`, `search_csv`,
`transform_csv`) with a single `csv_processor` tool that dispatches by an
`action` parameter, reducing tool sprawl while keeping the same capabilities.

## Context

The agent currently has four CSV-related tools registered individually in
`src/tools/` with matching schemas in `src/schemas/`. Three of them
(`read_csv_structure`, `search_csv`, `transform_csv`) share the same CSV parsing
foundation (`src/utils/csv.ts`) and follow a similar pattern: take a path, do
something with the CSV, return results. Having them as separate tools clutters
the tool list and makes the agent's function-calling schema larger than
necessary.

`csv_to_json` remains a standalone tool — it converts between formats rather
than processing CSV data.

### Current tools → new actions

| Old tool file | Action name | Payload fields |
|---|---|---|
| `read_csv.ts` | `metadata` | `{ path }` |
| `search_csv.ts` | `search` | `{ path, filters }` |
| `transform_csv.ts` | `transform_column` | `{ path, column_name, instructions }` |

## Acceptance criteria

- [ ] Single file `src/tools/csv_processor.ts` exports a `ToolDefinition` with name `csv_processor`
- [ ] Single schema `src/schemas/csv_processor.json` using `oneOf` to define exact payload shapes per action
- [ ] Action `metadata` accepts `{ path }` and returns `{ file, rows, columns }[]` (same as current `read_csv_structure`)
- [ ] Action `search` accepts `{ path, filters }` and returns `{ matchCount, outputPath, preview }` (same as current `search_csv`)
- [ ] Action `transform_column` accepts `{ path, column_name, instructions }` and returns `{ rowCount, outputPath, preview }` (same as current `transform_csv`)
- [ ] Invalid action name returns a clear error listing available actions
- [ ] Old files deleted: `src/tools/read_csv.ts`, `src/tools/search_csv.ts`, `src/tools/transform_csv.ts` and their schemas
- [ ] `csv_to_json.ts` and its schema remain untouched
- [ ] Existing tests for the deleted tools are migrated to test `csv_processor` with corresponding actions
- [ ] Dispatcher auto-discovers `csv_processor` without changes (filename matches schema)

## Implementation plan

1. Create `src/schemas/csv_processor.json` using `oneOf` with precise per-action
   payload definitions:

   ```jsonc
   {
     "name": "csv_processor",
     "description": "Process CSV files. Use action to pick an operation.",
     "parameters": {
       "type": "object",
       "oneOf": [
         {
           // metadata — inspect CSV structure
           "properties": {
             "action": { "const": "metadata" },
             "payload": {
               "type": "object",
               "properties": {
                 "path": { "type": "string", "description": "Absolute path to a CSV file or directory" }
               },
               "required": ["path"],
               "additionalProperties": false
             }
           },
           "required": ["action", "payload"]
         },
         {
           // search — filter rows by column conditions
           "properties": {
             "action": { "const": "search" },
             "payload": {
               "type": "object",
               "properties": {
                 "path": { "type": "string", "description": "Absolute path to the CSV file" },
                 "filters": {
                   "type": "array",
                   "description": "Filters combined with AND logic",
                   "items": {
                     "type": "object",
                     "properties": {
                       "column": { "type": "string" },
                       "op": { "type": "string", "enum": ["eq","neq","contains","startsWith","endsWith","gt","lt","gte","lte"] },
                       "value": { "type": "string" }
                     },
                     "required": ["column", "op", "value"]
                   }
                 }
               },
               "required": ["path", "filters"],
               "additionalProperties": false
             }
           },
           "required": ["action", "payload"]
         },
         {
           // transform_column — LLM-powered column transformation
           "properties": {
             "action": { "const": "transform_column" },
             "payload": {
               "type": "object",
               "properties": {
                 "path": { "type": "string", "description": "Absolute path to the CSV file" },
                 "column_name": { "type": "string", "description": "Column to transform" },
                 "instructions": { "type": "string", "description": "Natural-language transformation instructions" }
               },
               "required": ["path", "column_name", "instructions"],
               "additionalProperties": false
             }
           },
           "required": ["action", "payload"]
         }
       ],
       "additionalProperties": false
     }
   }
   ```

   This gives the LLM exact field names, types, and descriptions for each
   action — no guessing.

2. Create `src/tools/csv_processor.ts`:
   - Import handler logic from the three existing tool files (move functions, not import the tools)
   - Main handler: switch on `action`, validate + destructure `payload`, delegate to the appropriate function
   - On unknown action: throw with message listing valid actions
   - Each action function preserves the exact same behaviour and return shape as the current tool

3. Delete old tool files and schemas:
   - `src/tools/read_csv.ts` + `src/schemas/read_csv_structure.json`
   - `src/tools/search_csv.ts` + `src/schemas/search_csv.json`
   - `src/tools/transform_csv.ts` + `src/schemas/transform_csv.json`

4. Migrate tests:
   - Move/adapt existing test cases from deleted tool test files to `src/tools/csv_processor.test.ts`
   - Each test calls `csv_processor` handler with the appropriate `{ action, payload }`

## Testing scenarios

- **metadata**: call with a valid CSV path → returns correct columns and row count (same assertions as old `read_csv_structure` tests)
- **metadata on directory**: call with a directory containing multiple CSVs → returns structure for each file
- **search**: call with filters → returns matching rows, correct matchCount, and output file exists
- **search with bad column**: call with non-existent column → throws descriptive error
- **transform_column**: call with column + instructions → returns transformed CSV with correct row count
- **unknown action**: call with `action: "nope"` → throws error listing valid actions
- **missing payload fields**: call `search` without `filters` → throws validation error
