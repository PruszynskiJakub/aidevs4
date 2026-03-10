# SP-05 File Converter Tool

## Main objective

Replace the single-purpose `csv_to_json` tool with a generic `file_converter` tool that supports bidirectional CSV ↔ JSON conversion with optional column remapping and type coercion.

## Context

Today `csv_to_json` only converts CSV → JSON. The agent has no way to go the other direction (JSON → CSV) or to convert between other formats in the future. A generic `file_converter` tool with `from`/`to` format parameters provides a single, extensible entry point for all format conversions. The playground prototype at `playground/csv_to_json/` has already been promoted and can be removed.

## Out of scope

- Formats beyond CSV and JSON (YAML, XML, etc.) — add later via new converter functions
- Streaming / large-file support — current in-memory approach is sufficient
- Changes to `csv_processor` tool — it stays as-is

## Constraints

- Must use the `files` service for all I/O (no raw `fs`)
- Must use `ensureOutputDir()` + `outputPath()` for output files
- Must follow the existing single-handler tool pattern (not multi-action) — the `from`/`to` params already disambiguate
- Schema must set `additionalProperties: false` on every object
- Column mapping is optional — when omitted, all columns/keys pass through unchanged

## Acceptance criteria

- [ ] `file_converter` tool converts CSV → JSON (same behaviour as current `csv_to_json`)
- [ ] `file_converter` tool converts JSON → CSV (new)
- [ ] Column mapping (`from`/`to`/`type`) works for CSV → JSON (preserved)
- [ ] Column mapping (`from`/`to`) works for JSON → CSV (new — `type` ignored since CSV is always strings)
- [ ] When mapping is omitted, all fields pass through as-is in both directions
- [ ] Output file is written to `OUTPUT_DIR` with appropriate extension (`.json` or `.csv`)
- [ ] Old files removed: `src/tools/csv_to_json.ts`, `src/schemas/csv_to_json.json`, 
- [ ] `src/prompts/system.md` updated to reference `file_converter` instead of `csv_to_json`
- [ ] Tests cover both conversion directions, with and without mapping

## Implementation plan

1. Create `src/tools/file_converter.ts` with handler accepting `{ source_path, from_format, to_format, mapping? }`
   - `from_format` / `to_format`: `"csv"` | `"json"`
   - Route to internal `csvToJson()` or `jsonToCsv()` based on the pair
   - Reuse `parseCsv` from `src/utils/csv.ts` for CSV reading
   - Reuse `writeCsv` from `src/utils/csv.ts` for CSV writing
   - Keep `convertValue()` for type coercion on CSV → JSON path
2. Create `src/schemas/file_converter.json` with the new parameter shape
   - `mapping` is optional (omit from `required`)
3. Implement `jsonToCsv()`:
   - Read JSON array via `files.readJson()`
   - Apply mapping (rename keys) if provided
   - Write CSV via `writeCsv()` from `src/utils/csv.ts`
4. Delete `src/tools/csv_to_json.ts`, `src/schemas/csv_to_json.json`
5. Update `src/prompts/system.md` — replace `csv_to_json` references with `file_converter`
6. Write tests in `src/tools/file_converter.test.ts`:
   - CSV → JSON without mapping
   - CSV → JSON with mapping + type coercion
   - JSON → CSV without mapping
   - JSON → CSV with mapping
   - Error: unsupported format pair
   - Error: missing source file

## Testing scenarios

| Scenario | Input | Expected |
|---|---|---|
| CSV → JSON, no mapping | 3-row CSV | JSON array with all columns, string values |
| CSV → JSON, with mapping | CSV + mapping `[{from:"a", to:"x", type:"number"}]` | JSON with renamed key, numeric value |
| JSON → CSV, no mapping | JSON array of objects | CSV with all keys as headers |
| JSON → CSV, with mapping | JSON + mapping `[{from:"x", to:"a"}]` | CSV with renamed header |
| Omit mapping | Either direction | All fields pass through |
| Bad format pair | `from: "xml", to: "json"` | Error: unsupported conversion |
| Missing file | Non-existent path | Error from file service |
