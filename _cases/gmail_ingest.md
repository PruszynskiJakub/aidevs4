# Gmail Ingest

## Purpose

First stage of the email pipeline. Fetches new emails, triages them: archive
what's noise, store metadata for everything else, leave unread for downstream
processors.

Meta goal: the user never opens Gmail. The agent is the email interface.

## Decision Card

| Question | Answer |
|---|---|
| **What triggers this?** | Cron (every 15-30 min). No external event — purely pull-based. |
| **What's the decision?** | Archive (noise) or keep (everything else). Single binary gate. |
| **What's the output?** | Archived label in Gmail, structured record in storage, optional Slack ping. |
| **What's the cost of a mistake?** | False archive (missed important email) = **high**. False keep (noise stays) = **low**. Bias toward keeping. |
| **Expected volume?** | ~50-150 emails/day, 5-15 per run. Mostly noise (promos, GitHub notifications). |

## Classification Taxonomy

Three orthogonal dimensions — an email gets one label from each. This supports
retrieval along any axis: "all invoices", "everything from accountant",
"what needs action today".

### 0. Context (personal or business?)

Top-level split — affects downstream routing, retention, and urgency defaults.

| Label | Signal |
|---|---|
| `context/business` | Invoices, clients, accountant, employer, recruiting, SaaS tools used for work |
| `context/personal` | Shopping, personal subscriptions, friends/family, personal banking |

Emails can be ambiguous (e.g. a SaaS receipt for a tool used both personally and
for work). Default to `context/business` when unclear — easier to reclassify down
than to recover a missed business email.

### 1. Content (what is it?)

| Label | Examples |
|---|---|
| `content/newsletter` | AlphaSignal, Medium digests, Substack, Superhuman tips |
| `content/learning` | BRAVE Education / AI_devs 4, Readwise, Coursera |
| `content/invoice` | next step studio invoices, księgowość, SaaS receipts |
| `content/taxes` | Tax filings, PIT declarations, accountant tax docs |
| `content/job-offer` | LinkedIn alerts, NoFluffJobs listings |
| `content/transactional` | Shipping confirmations, password resets, 2FA codes, order status |
| `content/promotion` | ERLI, Frisco, Empik, Vistula — shopping promos |
| `content/dev-alert` | Vercel deploys, GitHub notifications, Google Apps Script errors |
| `content/personal` | Direct human correspondence not fitting other categories |
| `content/other` | Catch-all for unclassified content |

### 2. Participants (who is it from?)

Flat dimension — no sub-nesting. Fine-grained sender filtering is Gmail search's
job (`from:sender`), not the taxonomy's.

| Label | Examples |
|---|---|
| `participant/accountant` | Księgowość, tax advisor |
| `participant/employer` | Current/past employer comms |
| `participant/recruiter` | LinkedIn recruiters, job board senders |
| `participant/service` | Autopay, InPost, bank, SaaS platforms |
| `participant/community` | Course peers, Slack/Discord digests, meetup groups |
| `participant/personal` | Friends, family, direct contacts |
| `participant/bot` | Automated senders with no human behind them |

### 3. Priority (do I need to act?)

Three-valued — binary loses "waiting" which matters for freelance/consulting
(invoices awaiting payment, job applications pending, course deadlines).
Collapse to binary at query time if needed (`!= fyi`).

| Label | Signal | Examples |
|---|---|---|
| `priority/action` | Requires a response or decision within 24-48h | Invoice to pay, direct question, deadline reminder |
| `priority/waiting` | Ball is in someone else's court, track for follow-up | Sent proposal awaiting reply, support ticket open, application submitted |
| `priority/fyi` | No action needed, reference only | Newsletters, promos, deploy notifications, shipping updates |

### Design Rationale

- **Three dimensions over flat labels**: flat labels like `autopay` or `linkedin`
  tell you _who_, not _what_ or _how urgent_. Multi-dimensional lets you query
  along any axis without mutual exclusion.
- **content/newsletter vs content/learning**: split because consumption reading
  (AlphaSignal, Medium) and active learning (AI_devs, Coursera) are treated
  differently — different urgency, different follow-up.
- **content/transactional**: high volume, almost always noise, but occasionally
  needed for retrieval (tracking numbers, password resets). Without this bucket
  they'd fall through the cracks.
- **Flat participants**: `participant/service/autopay` is three levels deep for
  something `from:autopay` handles natively. Keep it flat, let sender metadata
  do fine-grained filtering.
- **Retire existing Gmail labels** (`autopay`, `inpost`, `proko`, `padi`) in
  favor of this taxonomy. The AI classifier + sender metadata replaces them.

## Input

- All new emails since last successful run (tracked via Gmail historyId)
- Per email: sender, subject, date, body (plain text preferred, HTML fallback), attachments metadata
- Learned rules from previous runs

## Output

### Decision table

| Decision | What happens | Mark read? |
|---|---|---|
| archive | Apply Gmail label, archive (promos, GitHub noise, known junk) | Yes |
| keep | Store metadata, assign freeform tags, leave in inbox | No |

For **kept** emails, ingest also:
- Posts to Slack for urgent/actionable items (brief summary, not full processing)
- Stores a structured record for downstream processors

### Stored record per email

```
{ id, gmail_id, from, subject, date,
  context_label, content_label, participant_label, priority_label,
  tags[], archived, extracted_summary, processed_at }
```

- **content_label**: one value from the `content/*` dimension (e.g. `content/invoice`).
- **participant_label**: one value from the `participant/*` dimension (e.g. `participant/service`).
- **priority_label**: one value from the `priority/*` dimension — drives Slack routing (`priority/action` → notify, `priority/fyi` → silent).
- **tags**: freeform, LLM-assigned (e.g. `["recurring", "kotlin", "remote"]`). Supplementary to the taxonomy — captures specifics that don't fit the fixed dimensions. Downstream processors can query by tags for domain logic.

## Downstream

Category-specific processors pick up emails by tags and handle domain logic:
- Finance processor — invoices, YNAB entries
- Reply drafter — emails needing a response
- Job board processor — role filtering

Contract: processors query stored records by `tags[]` and expect the schema above. Ingest owns classification; processors own action.

## Dependencies

- Gmail API — OAuth2 credentials, Google Cloud project
- LLM access — for classification of emails not matched by rules
- Storage backend — SQLite or similar for structured records
- Slack webhook — for urgent/actionable notifications

## Process Logic

Two-layer classification:

1. **Deterministic rules** run first — cheaper, faster, predictable.
   Rules accumulate from user feedback via Slack:
   - "Always archive from sender X"
   - "Newsletters from Y are high value"
   - "Only surface remote Kotlin roles"

2. **LLM classification** handles everything rules don't match.
   Assigns tags, urgency, archive/keep decision.

## Feedback Loop

- User reacts in Slack: "archive this" / "this was important" — corrections feed back as new deterministic rules
- Rules persistence in workspace/knowledge/ (format TBD)
- Over time, rules handle more traffic → fewer LLM calls → lower cost and latency

## Failure Modes

| Mode | Effect | Severity | Detection | Mitigation |
|---|---|---|---|---|
| Gmail API token expired | No emails fetched, silent gap | High | Zero emails processed for 3+ runs | Alert + auto-refresh token flow |
| API rate limit mid-run | Partial fetch, some emails missed | Medium | HTTP 429 in logs | Resume from last historyId, backoff |
| LLM returns garbage classification | Wrong archive/keep decision | High | Anomalous archive rate spike | Bias toward keep, flag low-confidence |
| LLM timeout / outage | Unclassified emails pile up | Medium | Classification error count | Queue for next run, don't skip |
| Storage write failure | Record lost, downstream never sees it | High | Write error in logs | Retry + leave email unread as fallback |

## Edge Cases

- Email body too large for LLM context — truncation strategy needed
- Duplicate emails — forwarded threads, CC chains with same content
- HTML-only emails with no plain text — extraction quality varies
- Rule conflicts — two rules match the same email with different actions
- Agent downtime — gap in cron runs, large batch to catch up on (historyId handles this)
- First run — no historyId, how far back to look?

## Open Questions

- Storage format — SQLite for structured records?
- Slack routing — single `#email` channel with urgency-based formatting?
- How to handle attachments — store locally? Just metadata?
- Rate limits — Gmail API quotas vs. polling frequency
- Rules persistence format — JSON/YAML in workspace/knowledge/?
