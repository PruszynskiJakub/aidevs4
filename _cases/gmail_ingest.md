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
{ id, gmail_id, from, subject, date, tags[], urgency, archived,
  extracted_summary, processed_at }
```

- **tags**: freeform, LLM-assigned (e.g. `["finance", "invoice", "recurring"]`). No fixed enum — downstream processors query by tags they care about.
- **urgency**: urgent / normal / noise — the one classification ingest does need to make for Slack routing.

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
