# Daily Newsletter Digest

## Purpose

Stay on top of newsletters and articles without drowning in them. The agent
reads all newsletter/article emails from Gmail, scores and triages them, and
publishes a single daily digest to a dedicated Slack channel — ready to consume
with morning coffee.

Meta goal: never open a newsletter email directly. The digest is the interface.

## Decision Card

| Question | Answer |
|---|---|
| **What triggers this?** | Cron — once daily (early morning, before work starts). |
| **What's the decision?** | For each article/newsletter item: READ (worth full attention), RUN THROUGH (skim-worthy), or SKIP (noise). |
| **What's the output?** | Slack message on a dedicated channel with two visible sections (READ, RUN THROUGH) and a collapsed/threaded SKIP section with reasons. |
| **What's the cost of a mistake?** | False SKIP = missed valuable content — **medium**. False READ = wasted 5 min — **low**. Bias toward promoting items up a tier rather than skipping. |
| **Expected volume?** | ~10-30 newsletter emails/day, expanding to ~30-80 individual articles/items after extraction. Digest should surface 3-8 READ, 5-15 RUN THROUGH. |

## Input

- Emails classified as `content/newsletter` or `content/learning` by Gmail
  Ingest (upstream case). Fetched since last successful digest run.
- Per email: sender, subject, date, body (plain text / HTML), links.
- Many newsletters are aggregators (e.g. AlphaSignal, TLDR) — a single email
  contains multiple distinct items. These must be exploded into individual
  entries before scoring.
- User interest profile (accumulated from feedback — topics, senders, keywords
  that matter).

## Output

### Slack Message Structure

```
:newspaper: Daily Newsletter Digest — 2026-04-07
3 to READ · 8 to RUN THROUGH · 14 skipped

───── READ ─────
1. [Article Title](url) — 2-sentence summary
   Source: AlphaSignal · Topic: agent tooling
   Why: directly relevant to current agent architecture work

2. [Article Title](url) — 2-sentence summary
   Source: Substack/Author · Topic: RAG patterns
   Why: new technique applicable to knowledge retrieval

───── RUN THROUGH ─────
1. [Article Title](url) — 1-sentence summary
   Source: TLDR · Topic: LLM benchmarks

2. ...
```

**SKIP section**: posted as a Slack thread reply on the main digest message.
Contains all skipped items with one-line reasons (e.g. "promotional content",
"already covered yesterday", "off-topic: frontend CSS"). Useful for debugging
the scoring but doesn't clutter the main view.

### Stored record per item

```
{ id, source_email_id, title, url, source_name,
  summary, topics[], tier (read|run_through|skip),
  score, skip_reason?, published_at, digest_date }
```

## Downstream

- User reads the Slack digest and acts on it (clicks links, saves to Readwise,
  etc.)
- Feedback loop (Slack reactions) feeds back into scoring model
- Potential future: weekly rollup of best READ items

## Dependencies

- **Gmail Ingest** (upstream case) — provides classified newsletter emails
- **LLM access** — for article extraction, summarization, and scoring
- **Slack API** — for posting the digest to a dedicated channel
- **Storage** — for tracking processed items, deduplication, feedback history
- **User interest profile** — stored in workspace/knowledge/ (bootstrapped
  manually, refined by feedback)

## Process Logic

### 1. Collect

Fetch all emails tagged `content/newsletter` or `content/learning` since last
digest run. Pull from Gmail Ingest stored records or directly from Gmail if
ingest hasn't run yet.

### 2. Extract

For each email, extract individual articles/items:
- Aggregator newsletters (AlphaSignal, TLDR, etc.) → multiple items with
  separate titles, URLs, blurbs
- Single-article newsletters (Substack posts, blog digests) → one item
- Dedup by URL — same link from multiple sources counts once (pick best summary)

### 3. Score & Classify

Each item gets a relevance score (0-100) based on:

**Signal boosters** (increase score):
- Topic matches user interest profile (AI agents, TypeScript, system design, etc.)
- Source historically rated highly by user
- Mentions tools/frameworks the user actively works with
- Actionable content (tutorial, technique, tool release)

**Signal dampeners** (decrease score):
- Pure news/announcements with no actionable insight
- Topics user has explicitly deprioritized
- Duplicate/rehash of previously surfaced content
- Promotional or vendor-driven content

**Tier assignment**:
- Score 70+ → READ
- Score 30-69 → RUN THROUGH
- Score <30 → SKIP (with reason logged)

### 4. Summarize

- READ items: 2-sentence summary + why it matters to the user
- RUN THROUGH items: 1-sentence summary
- SKIP items: skip reason only (no summary needed)

### 5. Publish

Compose and post Slack message. Main message has READ + RUN THROUGH sections.
SKIP section goes as a thread reply.

## Feedback Loop

- **Slack reactions on digest items**:
  - Thumbs up on a RUN THROUGH item → boost that topic/source score
  - Thumbs down on a READ item → dampen that topic/source
  - "skip this source" reaction → add to dampened sources
- **Explicit commands** (Slack message in thread):
  - "more like this" → extract topics, boost in profile
  - "never from {source}" → permanent dampener
- Feedback persists in workspace/knowledge/newsletter_preferences.yaml (or
  similar)
- Over time, scoring becomes more personalized with less LLM involvement for
  clear-cut cases

## Failure Modes

| Mode | Effect | Severity | Detection | Mitigation |
|---|---|---|---|---|
| Gmail Ingest didn't run | No newsletter emails to process | Medium | Zero input emails | Fall back to direct Gmail fetch with `content/newsletter` heuristic |
| Newsletter format changed | Article extraction fails, items missed | Medium | Low item count from known high-volume source | Fallback: treat entire email as single item |
| LLM scoring inconsistent | READ/SKIP boundary drifts day-to-day | Low | Score distribution anomalies over time | Calibration set of known-good items, periodic re-anchor |
| Slack API failure | Digest not posted | High | Post error in logs | Retry with backoff, fall back to file output |
| All items scored as SKIP | Empty digest — user misses everything | High | Zero READ + RUN THROUGH items | Force top-N items into RUN THROUGH regardless of score |
| Dedup too aggressive | Distinct articles merged, content lost | Low | Item count much lower than email count | Dedup on exact URL only, not fuzzy title match |

## Edge Cases

- Newsletter arrives after digest already posted for the day — queue for
  tomorrow or post a supplement?
- Extremely long newsletter (50+ items) — cap extraction at reasonable limit?
- Newsletter in non-English language — translate summary or skip?
- Newsletter with no links (pure prose, e.g. some Substacks) — still score
  and include, use email body as the "article"
- Same article linked by 3+ sources — how to credit/attribute?
- First run with no feedback history — cold start scoring relies purely on
  topic matching against bootstrapped interest profile

## Open Questions

- Which Slack channel? New `#newsletter-digest` or reuse existing?
- Digest timing — fixed schedule (e.g. 7:00 AM) or adaptive based on when
  newsletters typically arrive?
- Should READ items include estimated reading time?
- How to bootstrap the user interest profile — manual YAML? Infer from
  browsing history / starred items?
- Should the digest link to original email or directly to article URL?
- Weekly rollup of best items — separate case or feature of this one?
- Integration with Readwise — auto-save READ items?