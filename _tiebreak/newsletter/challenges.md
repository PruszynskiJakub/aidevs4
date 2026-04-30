# Newsletter Digest — Challenge Series

Three challenges. Each one delivers value the moment it's done.
Refinements come later, driven by real friction.

---

## CH01 — What should I read today?

**Concept:** Classification with personal context and structured outputs.

**Lesson:** "Classify these newsletters" sounds like a sorting exercise.
It's not. It's a taste extraction problem. You need to pull what "read
worthy" means out of your head and encode it in a prompt — your interests,
your current work, what you find actionable vs. noise. Too vague and the
model keyword-matches ("AI" = read!). Too rigid and it can't handle the
newsletter you didn't anticipate. The trick: few-shot examples from YOUR
perspective. Not "this is a good article" but "this matters to me because
I'm building an agent system in TypeScript and this technique is directly
applicable." The model needs your reasoning, not just your labels.

**Task:** Take 10 real newsletter emails from your inbox. The agent reads
each one, classifies every item as read / run_through / skip, and returns
`{ title, url, tier, reason }` per item.

**What makes it hard:**
- Aggregator newsletters (TLDR, AlphaSignal) contain 10+ items per email —
  the agent must handle both the whole email and individual items
- An article titled "AI agents" that's a product launch with no substance
  (skip, despite matching your interests)
- An article about a TypeScript runtime that's directly relevant to your
  Bun stack (read, not just run_through — the model needs to connect the
  dots)
- Your interest profile doesn't exist yet — you're building it as part of
  this challenge

**Pass:** You review the output. ≥80% of the tier assignments match your
gut. The reasons make sense — they reflect YOUR priorities, not generic
"this is interesting."

**What it builds:** The classification prompt + your interest profile.
The core judgment of the entire pipeline.

**When it's valuable:** Immediately. Run it manually on today's emails.
You know what to read. That's the point.

---

## CH02 — The morning digest

**Concept:** Output design and the Slack integration.

**Lesson:** The digest is the product, not the classification. A JSON
array of `{ title, tier }` is useless — you won't read it at 7am. The
format needs to work with how Slack renders: bold, links, line breaks,
emoji as visual anchors, thread replies for noise. READ items need
2-sentence summaries that answer "why should I care?" RUN THROUGH items
need one line that gives you the headline. SKIP goes in a thread — out
of sight but available. The format should be scannable in 30 seconds.
If it takes longer, you'll stop reading it, and then the whole thing is
dead.

**Task:** Take CH01's output. Build a Slack tool. Post a digest to a
test channel. Main message: READ + RUN THROUGH. Thread reply: SKIP.

**What makes it hard:**
- 0 READ items today — the digest should still be useful, not empty
- 12 RUN THROUGH items — needs to stay scannable, not become a wall
- Summaries that sound generic ("This article discusses AI trends")
  vs. summaries that hook you ("New approach to tool validation — directly
  applicable to your agents_hub handler pattern")
- Slack formatting constraints (no tables, limited markdown)

**Pass:** You look at the Slack message and want to click something.
You can scan it in 30 seconds.

**What it builds:** The Slack tool + digest formatter + tier-appropriate
summarization.

**When it's valuable:** The moment it posts. You have a digest. It's
manual (you trigger it), but it works.

---

## CH03 — It just runs

**Concept:** Gmail integration, end-to-end pipeline, real-world messiness.

**Lesson:** The first two challenges worked on emails you hand-picked. Now
the agent fetches its own input. Gmail's API returns threads, labels, MIME
parts, multipart bodies — the agent needs none of that. It needs `{ sender,
subject, body, date }`. The tool's job: call the messy API, return the clean
structure. But the real challenge isn't the API — it's what happens when
unfiltered reality hits the pipeline. A newsletter in a format you haven't
seen. HTML-only body with no plain text. An email that's half newsletter,
half product announcement. The pipeline you built in CH01-CH02 will break
in specific ways. Those breaks tell you what to refine.

**Task:** Build the Gmail tool. Wire the full pipeline: fetch today's
newsletters → classify → summarize → format → post to Slack. Run it for
3 consecutive days.

**What makes it hard:**
- Gmail OAuth setup and token management
- Newsletter you've never seen before hits the pipeline
- Email body too large for context window
- Day 2: the same article from yesterday appears again (no dedup yet —
  you'll feel the need for it)
- Day 3: a newsletter changes format (they do that)

**Pass:** You read the Slack digest instead of opening Gmail. Three days
in a row. Not because you're testing — because it's better.

**What it builds:** The Gmail tool + the full pipeline. The thing from
the scratchpad is done.

**When it's valuable:** Every morning after this.

---

## What comes after

You don't plan these. They emerge from using the thing:

- Dedup bothers you → build dedup
- Extraction misses items → improve extraction
- Your interests shift → refine the interest profile
- You want feedback via Slack reactions → build the feedback loop
- A specific newsletter always breaks → add a format handler

Each refinement is its own mini-challenge with a clear finish line.
But you don't build them until the friction is real.