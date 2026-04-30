Can# Newsletter Digest — Problem Brief

## The problem

Tech newsletters pile up in Gmail unread. There's good stuff in there —
AI agents, TypeScript, system design, tool releases — but the volume kills
the habit. I want a daily Slack digest that does the reading for me.

## Three tiers

- **Read** — full attention, this matters to my work
- **Run through** — worth a skim, stay informed
- **Skip** — noise, don't waste my time

The exact boundary between tiers is fuzzy and personal. Part of the problem
is figuring out what those boundaries are for me.

## The end state

Every morning, a Slack message with today's digest. READ items on top with
summaries and links. RUN THROUGH below. SKIP collapsed or in a thread.
I never open a newsletter email directly.

## What makes it hard

- Aggregator newsletters (TLDR, AlphaSignal) pack 10-20 items in one email.
  Each item needs separate classification.
- Single-article newsletters (Substacks) are one item but buried in
  formatting.
- My interests shift — what's "read" today might be "skip" next month.
- Some newsletters mix gold and noise in the same email.
- Deduplication — the same article appears in 3 newsletters.

## The agent solves it

The agent built in `src/` will eventually run this end-to-end: fetch from
Gmail, extract items, classify, summarize, post to Slack. Each challenge
below builds toward a piece of that pipeline.