# SP-47 Web scrape action (Serper)

## Main objective

Add a `scrape` action to the existing `web` tool that extracts page content from
any URL using the Serper.dev scraping API, enabling the agent to read web pages.

## Context

The current `web` tool only supports `download` — saving raw files from
allowlisted hosts (*.ag3nts.org). The agent has no way to read the textual
content of a web page. Tasks increasingly require fetching and reasoning about
arbitrary web content (HTML pages, documentation, external data).

Serper.dev provides a scraping endpoint (`POST https://scrape.serper.dev`) that
accepts a URL and returns clean page content. This avoids building a custom
scraper/parser and handles JS-rendered pages.

## Out of scope

- Search functionality (Serper search endpoint) — separate spec if needed
- Modifying the existing `download` action
- Caching or deduplication of scraped content
- HTML parsing or custom extraction logic — Serper handles this

## Constraints

- `SERPER_API_KEY` stored in `.env`, loaded via `env.ts` — never exposed as a
  tool parameter
- 30-second timeout per request (consistent with existing `fetchTimeout`)
- URL max length: 2048 characters
- Batch size capped at `config.limits.maxBatchRows` (currently 1000)
- Scrape results that exceed `MAX_OUTPUT` must be truncated
- No host allowlist restriction — scrape is meant for arbitrary URLs (unlike
  `download`)

## Acceptance criteria

- [ ] `SERPER_API_KEY` added to `.env`, `env.ts`, and `config`
- [ ] `web__scrape` action callable by the agent via the existing `web` tool
- [ ] Accepts an array of URLs (always batch), scrapes in parallel
- [ ] Each URL is independent — one failure does not abort others
- [ ] Returns a `Document[]` — one per URL with page text/markdown content
- [ ] Failed URLs return an error document (not thrown) so the agent sees
      partial results
- [ ] Input validation: URL format, max length, batch size cap
- [ ] 30-second timeout per individual request

## Implementation plan

1. **Environment** — Add `SERPER_API_KEY` to `.env`, update `env.ts` to export
   it (optional — not in `REQUIRED_VARS`), add to `config` object.

2. **Schema** — Extend `src/schemas/web.json` with a new `scrape` action:
   ```json
   "scrape": {
     "description": "Extract text content from web pages. Accepts an array of URLs and scrapes them in parallel. Returns page content for each URL. Use when you need to read or analyze web page content.",
     "parameters": {
       "type": "object",
       "properties": {
         "urls": {
           "type": "array",
           "items": { "type": "string" },
           "description": "URLs of web pages to scrape. Each is fetched independently — one failure won't affect others."
         }
       },
       "required": ["urls"],
       "additionalProperties": false
     }
   }
   ```

3. **Handler** — In `src/tools/web.ts`, add a `scrape` function:
   - Validate each URL (format, max length 2048)
   - Cap array at `config.limits.maxBatchRows`
   - `Promise.allSettled()` to scrape all URLs in parallel
   - Each request: `POST https://scrape.serper.dev` with
     `{ url }` body, `X-API-KEY` header from config, `Content-Type: application/json`,
     `AbortSignal.timeout(30_000)`
   - Parse response, extract text content
   - Return `Document[]` — success documents with content, error documents for
     failures (with URL and error message)

4. **Tool description** — Update the top-level `web` schema description to
   mention scraping capability alongside download.

5. **Wire** — Add `"scrape"` case to the `switch` in the `web` handler function.

## Testing scenarios

- **Happy path**: scrape a single URL → returns Document with page content
- **Batch**: scrape 3 URLs → returns 3 Documents
- **Partial failure**: scrape 2 valid + 1 invalid URL → 2 success + 1 error document
- **Validation**: URL exceeding 2048 chars → rejected
- **Validation**: empty `urls` array → error
- **Validation**: batch exceeding max size → error
- **Timeout**: mock a slow endpoint → request times out, returns error document
- **Invalid URL format**: non-URL string → error document (not thrown)