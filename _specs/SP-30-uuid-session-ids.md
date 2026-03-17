# SP-30 Use UUID v4 for session IDs

## Main objective

Replace the 8-character random hex session ID with a standard UUID v4 to eliminate collision risk and improve traceability across logs and API calls.

## Context

`randomSessionId()` in `src/services/markdown-logger.ts` currently generates an 8-char hex string via `randomBytes(4).toString("hex")` (32 bits of entropy). While functional, this gives only ~4 billion possible values — enough for collisions to become plausible at scale and hard to correlate across systems. UUID v4 provides 122 bits of entropy and is a universally recognized identifier format.

The existing validation regex (`/^[a-zA-Z0-9_\-]+$/`) already permits hyphens, so UUID strings pass without modification.

## Out of scope

- Changing how user-supplied `--session` IDs are handled (users can still pass arbitrary valid strings)
- Migrating existing log directories to new ID format
- Adding the `uuid` npm package (using built-in `crypto.randomUUID()`)

## Constraints

- Zero new dependencies — must use `crypto.randomUUID()` (available in Bun and Node 19+)
- Existing `--session <id>` CLI flag must continue to accept any string matching the SAFE_ID regex
- Log directory structure (`logs/{date}/{sessionId}/`) unchanged

## Acceptance criteria

- [ ] `randomSessionId()` returns a valid UUID v4 string (36 chars, 8-4-4-4-12 format)
- [ ] No new npm dependencies added
- [ ] All existing tests pass (updated where they assert on ID length/format)
- [ ] User-supplied session IDs via `--session` and HTTP API still work unchanged
- [ ] Log directories are created correctly with UUID-based names

## Implementation plan

1. In `src/services/markdown-logger.ts`, replace `randomBytes(4).toString("hex")` with `crypto.randomUUID()` inside `randomSessionId()`. Remove the `randomBytes` import if no longer used elsewhere in the file.
2. Update `src/services/markdown-logger.test.ts` — adjust any assertions that check for 8-char hex format to expect UUID v4 format (36 chars, matching `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`).
3. Run `bun test` to verify all tests pass.

## Testing scenarios

- `randomSessionId()` returns a string matching UUID v4 regex
- Generated IDs pass the existing `SAFE_ID` validation
- Two consecutive calls return different IDs (non-deterministic)
- Log directory creation works with UUID-length directory names
- Server and CLI flows continue to accept user-provided short session IDs
