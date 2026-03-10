# SP-10 Toolset Reorganization — filesystem inspect + data_transformer

## Main objective

Replace `csv_processor`, `file_converter`, and `filesystem.read_file` with two focused tools: a rewritten `filesystem` (single `inspect` action that auto-detects CSV/JSON/MD) and a new `data_transformer` (filter, sort, add_field, convert for CSV and JSON).

## Context

Today the agent has three data-related tools that overlap and are CSV-centric:

- **csv_processor** (3 actions: metadata, search, transform_column) — CSV only
- **file_converter** (simple tool) — CSV ↔ JSON conversion
- **filesystem** (1 action: read_file) — raw text reading, already deprecated (schema removed)

The agent cannot inspect JSON or Markdown structure, cannot sort data, cannot filter JSON, and cannot generate new fields with multi-field context. Consolidating into two tools with format-aware logic solves all of these gaps while reducing tool count.

## Out of scope

- New file formats beyond CSV, JSON, Markdown (add later by extending inspect/transformer)
- Streaming or chunked processing for large files
- Changes to `agents_hub` tool
- Changes to shared utilities (`csv.ts`, `llm.ts`, `output.ts`) — reuse as-is
- Prompt (`system.md`) updates — handled separately if needed

## Constraints

- Must use `files` service for all I/O (no raw `fs`)
- Must use `ensureOutputDir()` + `outputPath()` for output files
- Must follow multi-action tool pattern (see `csv_processor` as reference)
- Schemas: `additionalProperties: false` on every object, all properties in `required`, no `oneOf`/`anyOf`/type arrays
- Bun runtime, TypeScript strict mode
- `batchTransform` from `src/utils/llm.ts` for LLM-powered field generation

## Acceptance criteria

- [ ] `filesystem__inspect` auto-detects CSV/JSON/MD from file extension and returns format-specific structure
- [ ] `filesystem__inspect` on a directory inspects all supported files (.csv, .json, .md) within it
- [ ] CSV inspect returns: file, format, rows count, column names, 3 sample rows
- [ ] JSON inspect returns: file, format, structure (array/object), item/key count, schema (key+type), sample
- [ ] Markdown inspect returns: file, format, totalLines, headings (level+text), linkCount, codeBlockCount
- [ ] `data_transformer__filter` filters CSV and JSON with conditions (eq, neq, contains, startsWith, endsWith, gt, lt, gte, lte) and AND/OR logic
- [ ] `data_transformer__sort` sorts CSV and JSON by one or more fields with numeric-aware comparison
- [ ] `data_transformer__add_field` generates a new field using LLM (via `batchTransform`) with configurable context fields
- [ ] `data_transformer__convert` converts CSV ↔ JSON with optional column mapping and type coercion (port from file_converter)
- [ ] All transformer actions write output to `OUTPUT_DIR` and return `{ count, outputPath, preview }`
- [ ] Old files deleted: `csv_processor.ts/.test.ts/.json`, `file_converter.ts/.test.ts/.json`
- [ ] `filesystem` rewritten: `read_file` removed, `inspect` added, schema recreated
- [ ] `dispatcher.test.ts` updated for new tool names and count
- [ ] All tests pass (`bun test src/tools/`)

## Implementation plan

1. Delete old tools:
   - `src/tools/csv_processor.ts`, `src/tools/csv_processor.test.ts`, `src/schemas/csv_processor.json`
   - `src/tools/file_converter.ts`, `src/tools/file_converter.test.ts`, `src/schemas/file_converter.json`

2. Rewrite `src/schemas/filesystem.json` — multi-action schema with single `inspect` action:
   - Parameters: `{ path: string }` (file or directory)

3. Rewrite `src/tools/filesystem.ts` — single `inspect` action:
   - `files.stat()` to detect file vs directory
   - For directories: `files.readdir()`, filter for `.csv`/`.json`/`.md`, inspect each
   - For files: detect format from `extname()`, dispatch to format-specific logic
   - CSV: `parseCsv()` → `{ file, format:"csv", rows, columns, sample }`
   - JSON: `files.readJson()` → detect array vs object, infer schema from first item's keys+types, `{ file, format:"json", structure, count, schema, sample }`
   - Markdown: `files.readText()` → regex for headings (`/^#{1,6}\s+/`), links (`/\[.*?\]\(.*?\)/g`), code blocks (``` pairs), `{ file, format:"markdown", totalLines, headings, linkCount, codeBlockCount }`
   - Throw on unsupported extensions

4. Create `src/schemas/data_transformer.json` — multi-action schema with 4 actions:
   - `filter`: `{ path, format, conditions[], logic }`
   - `sort`: `{ path, format, sort_by[] }`
   - `add_field`: `{ path, format, field_name, instructions, context_fields }`
   - `convert`: `{ source_path, from_format, to_format, mapping }`

5. Create `src/tools/data_transformer.ts`:
   - Shared helpers: `loadRecords(path, format)` normalizes CSV/JSON into `Record<string,string>[]`, `writeRecords(records, format, filename)` writes back
   - `filter`: port matchers from csv_processor, add AND/OR logic toggle
   - `sort`: multi-field sort with `Number()` detection for numeric comparison
   - `add_field`: build context strings from selected fields, call `batchTransform`, append new field
   - `convert`: port `csvToJson`/`jsonToCsv`/`stringifyValue`/`convertValue` from file_converter

6. Write tests:
   - `src/tools/filesystem.test.ts` — inspect CSV file, JSON array, JSON object, Markdown, directory, unsupported extension, unknown action
   - `src/tools/data_transformer.test.ts` — filter AND/OR, sort asc/desc/numeric/multi-field, add_field (skip/mock LLM), convert both directions with/without mapping, unknown action

7. Update `src/tools/dispatcher.test.ts`:
   - Tool count: 9 → 9 (agents_hub 4 + filesystem 1 + data_transformer 4)
   - Replace old tool name assertions with new ones

## Testing scenarios

| Scenario | Tool | Input | Expected |
|---|---|---|---|
| Inspect CSV file | filesystem__inspect | path to .csv | `[{ format:"csv", rows, columns, sample }]` |
| Inspect JSON array | filesystem__inspect | path to .json (array) | `[{ format:"json", structure:"array", count, schema }]` |
| Inspect JSON object | filesystem__inspect | path to .json (object) | `[{ format:"json", structure:"object", count, schema }]` |
| Inspect Markdown | filesystem__inspect | path to .md | `[{ format:"markdown", headings, linkCount, codeBlockCount }]` |
| Inspect directory | filesystem__inspect | path to dir with mixed files | Array with entries for each supported file |
| Unsupported extension | filesystem__inspect | path to .xml | Error |
| Filter CSV AND | data_transformer__filter | CSV + 2 conditions, logic:"and" | Only rows matching both |
| Filter JSON OR | data_transformer__filter | JSON + 2 conditions, logic:"or" | Rows matching either |
| Filter unknown field | data_transformer__filter | Non-existent field | Error listing available fields |
| Sort ascending | data_transformer__sort | CSV + sort_by name asc | Alphabetically sorted |
| Sort numeric desc | data_transformer__sort | CSV + sort_by age desc | Numerically sorted descending |
| Sort multi-field | data_transformer__sort | CSV + city asc, name asc | Sorted by city then name |
| Add field (LLM) | data_transformer__add_field | CSV + instructions | New column appended (mock LLM in test) |
| Convert CSV→JSON | data_transformer__convert | CSV file | JSON array output |
| Convert JSON→CSV | data_transformer__convert | JSON file | CSV output |
| Convert with mapping | data_transformer__convert | CSV + mapping with type coercion | Renamed keys, typed values |
