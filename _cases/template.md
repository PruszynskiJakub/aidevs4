# {Case Name}

## Purpose

Why this exists. North-star goal.

## Decision Card

| Question | Answer |
|---|---|
| **What triggers this?** | Arrival of event, cron schedule, user command, etc. |
| **What's the decision?** | The core choice the workflow makes. |
| **What's the output?** | Artifacts, side effects, notifications, state changes. |
| **What's the cost of a mistake?** | Low (missed newsletter) vs high (wrong invoice). Informs how conservative the system should be. |
| **Expected volume?** | Items per run, per day. Drives architecture and cost. |

## Input

Data shape, sources, what's available at trigger time.

## Output

Artifacts, side effects, stored records, notifications.
Schema/contract for anything downstream consumers depend on.

## Downstream

Who/what consumes the output. Interface contract.

## Dependencies

External systems, APIs, credentials, infrastructure prerequisites.

## Process Logic

How the decision gets made — rules engine, LLM classification,
sequencing, fallback behavior.

## Feedback Loop

How the process learns — user corrections, rule accumulation,
accuracy tracking.

## Failure Modes

| Mode | Effect | Severity | Detection | Mitigation |
|---|---|---|---|---|
| | | | | |

## Edge Cases

- Unusual but valid scenarios and how to handle them.

## Open Questions

- Unresolved decisions that block or shape implementation.
