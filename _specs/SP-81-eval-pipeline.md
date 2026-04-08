# SP-81 Evaluation Pipeline (Incremental)

## Main objective

Build an incremental eval pipeline that detects regressions in tool selection,
answer quality, and cost when prompts, tools, or models change. Each phase is
independently useful — Phase 1 alone delivers value.

## Context

### What exists today

- **Telemetry foundation is solid.** Typed event bus (`src/infra/events.ts`)
  emits `tool.called`, `tool.succeeded`, `tool.failed`, `turn.completed`,
  `generation.completed` with token counts, durations, tool names. JSONL
  persistence writes all events to `workspace/sessions/`.
- **Langfuse tracing exists** (`src/infra/langfuse-subscriber.ts`) using
  `@langfuse/otel` + `@langfuse/tracing` packages — OpenTelemetry-based
  trace export only. No dataset or experiment API. The `@langfuse/client`
  package (which provides `dataset.runExperiment()`) is **not installed**.
- **Empty `src/evals/` directory** — scaffolded but never populated.
- **Architecture audit (Revision 5)** lists "No Evaluation Pipeline" as
  **Critical severity, gap #2**.
- **57 unit test files** cover tool logic and agent mechanics, but nothing
  evaluates the agent's behavior end-to-end (does it pick the right tool?
  does it answer correctly? at what cost?).

### Course reference

`4th-devs/03_01_evals/` demonstrates the target pattern:
- Synthetic JSON datasets with `{ id, message, expect }` structure
- Langfuse `dataset.runExperiment()` with per-case tasks and evaluators
- Deterministic evaluators returning `{ name, value: 0-1, comment }[]`
- Run-level aggregation via `createAvgScoreEvaluator`
- Bootstrap context wiring (logger, adapter, Langfuse client)

`4th-devs/03_04_gmail/evals/` shows promptfoo-based approach with YAML
configs and JavaScript assertions — useful reference but we'll start with
the Langfuse-native pattern since we already have the integration.

`4th-devs/05_03_autoprompt/` shows LLM-as-judge scoring with section-based
rubrics and field-level matching (exact vs semantic).

### Why now

Every prompt edit, model swap, or tool refactor is a blind change. There's
no way to know if tool selection accuracy dropped, answers degraded, or cost
spiked. The telemetry infrastructure is mature enough to build on.

## Out of scope

- **Prompt optimization loop** (autoprompt-style hill climbing) — that's a
  future phase, not part of this spec
- **Online monitoring / alerting** — this spec covers offline eval runs only
- **UI dashboard** — Langfuse provides the visualization layer
- **Eval dataset generation** — datasets are hand-crafted or LLM-generated
  outside the pipeline; the pipeline consumes them

## Phases

Each phase is a separate deliverable. Later phases depend on earlier ones
but each is independently shippable.

---

### Phase 1: Runner + Tool Selection Eval

**Goal:** One working eval runnable from CLI with results in Langfuse.

#### New dependency

```bash
bun add @langfuse/client
```

Required for `dataset.runExperiment()` API. The existing `@langfuse/otel`
and `@langfuse/tracing` packages handle trace export only — they don't
expose datasets or experiments.

#### Files

```
src/evals/
  runner.ts                        # CLI entry point
  types.ts                         # EvalCase, EvalResult, Evaluator, ScoringMetric
  datasets/
    tool-selection.json            # 15-20 synthetic cases
  evaluators/
    tool-selection.ts              # Deterministic tool selection scoring
```

#### Dataset format

```json
[
  {
    "id": "ts-001",
    "message": "What files are in the workspace directory?",
    "expect": {
      "shouldUseTools": true,
      "requiredTools": ["glob"],
      "forbiddenTools": ["bash"],
      "maxToolCalls": 3
    }
  },
  {
    "id": "ts-010",
    "message": "What is 2 + 2?",
    "expect": {
      "shouldUseTools": false,
      "requiredTools": [],
      "maxToolCalls": 0
    }
  }
]
```

Cases should cover:
- Tool required vs. no tool needed (decision accuracy)
- Specific tool expected (e.g., `grep` not `bash` for search)
- Forbidden tool avoidance (e.g., `bash` when `glob` suffices)
- Multi-tool tasks (delegation, browser + file)
- Edge cases (ambiguous requests, empty inputs)

#### Types

```typescript
interface EvalCase {
  id: string
  message: string
  expect: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface ScoringMetric {
  name: string
  value: number    // 0-1
  comment?: string
}

type Evaluator = (params: {
  input: EvalCase
  output: AgentOutput
  expectedOutput: EvalCase["expect"]
}) => Promise<ScoringMetric[]>

interface AgentOutput {
  response: string
  toolNames: string[]
  toolCalls: number
  iterations: number
  tokens: { input: number; output: number; total: number }
  durationMs: number
}

interface EvalRunResult {
  dataset: string
  cases: Array<{
    caseId: string
    scores: ScoringMetric[]
    output: AgentOutput
  }>
  aggregated: Record<string, number>  // metric name → average
  timestamp: string
}
```

#### Evaluator: tool-selection

Scores per case (all 0 or 1, deterministic):
- `tool_decision` — did it use tools when expected (and not when not)?
- `required_tools` — were all required tools called?
- `forbidden_tools` — were no forbidden tools called?
- `call_count` — within min/max bounds?
- `tool_selection_overall` — average of above four

Mirrors `4th-devs/03_01_evals/experiments/tool-use.ts` evaluator logic.

#### Runner

```bash
bun run eval                              # Run all datasets
bun run eval --dataset tool-selection     # Run specific dataset
bun run eval --dataset tool-selection --langfuse   # Sync to Langfuse
bun run eval --dataset tool-selection --concurrency 3
```

Runner flow:
1. Load dataset JSON from `src/evals/datasets/`
2. For each case: run agent via `executeTurn` (or a lightweight harness
   that captures tool calls without full session overhead)
3. Collect `AgentOutput` from events
4. Run evaluator(s) on each case
5. Aggregate scores (mean per metric)
6. Print console table (case ID, pass/fail, per-metric scores)
7. If `--langfuse`: sync dataset + experiment + scores

#### Agent harness

The runner needs a thin wrapper around the agent that:
- Creates an ephemeral session per case
- Captures tool names and call counts from events
- Extracts token usage from `generation.completed` events
- Returns structured `AgentOutput`

This should reuse existing agent infrastructure (`executeTurn` from
`src/agent/orchestrator.ts`) rather than reimplementing the loop.

#### Package scripts

Add to `package.json`:
```json
{
  "scripts": {
    "eval": "bun run src/evals/runner.ts",
    "eval:tool-selection": "bun run src/evals/runner.ts --dataset tool-selection"
  }
}
```

---

### Phase 2: LLM-as-Judge + Response Quality

**Goal:** Evaluate answer correctness, not just tool mechanics.

#### Files

```
src/evals/
  evaluators/
    response-correctness.ts    # Deterministic checks
    llm-judge.ts               # LLM-based rubric scoring
  datasets/
    response-quality.json      # 15-20 cases with expected answers
src/prompts/
  eval-judge.md                # Judge prompt (YAML frontmatter + template)
```

#### Dataset format extension

```json
{
  "id": "rq-001",
  "message": "What is the capital of France?",
  "expect": {
    "answer": "Paris",
    "matchType": "contains",
    "rubric": {
      "correctness": "Answer must name Paris as the capital",
      "conciseness": "Answer should be 1-2 sentences max"
    }
  }
}
```

#### Scoring types

| Type | Implementation | Use case |
|------|---------------|----------|
| `exact` | String/number equality | Factual answers, IDs |
| `contains` | Substring match (case-insensitive) | Key terms present |
| `regex` | Pattern match | Format validation (dates, URLs) |
| `semantic` | LLM judge with rubric | Open-ended quality |

#### LLM judge

- Model: `gpt-4.1-mini` (cheap, sufficient for judging)
- Prompt in `src/prompts/eval-judge.md` with `{{response}}`, `{{expected}}`,
  `{{rubric}}` placeholders
- Returns structured JSON: `{ score: 0-1, reasoning: string }` per rubric
  dimension
- Uses existing `promptService.load()` + `llm.chatCompletion()` (the LLM
  provider singleton from `src/llm/llm.ts`)

#### Evaluator: response-correctness

Scores per case:
- `answer_match` — deterministic check (exact/contains/regex)
- `judge_correctness` — LLM judge score (if rubric provided)
- `judge_conciseness` — LLM judge score (if rubric provided)
- `response_quality_overall` — weighted average

---

### Phase 3: Cost & Efficiency Metrics

**Goal:** Track and baseline cost per eval case.

#### Files

```
src/evals/
  metrics/
    cost.ts              # Token → cost calculation
    efficiency.ts        # Iterations, tool call ratio
  reporters/
    console.ts           # Pretty table output
    langfuse.ts          # Langfuse sync
  baselines/
    .gitkeep             # Baseline snapshots saved here
```

#### Metrics per case

| Metric | Source | Unit |
|--------|--------|------|
| `input_tokens` | `generation.completed` usage.input | count |
| `output_tokens` | `generation.completed` usage.output | count |
| `total_tokens` | `generation.completed` usage.total | count |
| `estimated_cost_usd` | tokens × model pricing | USD |
| `iterations` | `turn.completed` event | count |
| `tool_calls` | `tool.called` events | count |
| `wall_time_ms` | start to finish | ms |

#### Baseline comparison

```bash
bun run eval --dataset tool-selection --save-baseline
# Saves baselines/tool-selection.baseline.json

bun run eval --dataset tool-selection
# Compares against baseline, flags:
#   - >20% cost increase (warning)
#   - >10% accuracy drop (failure)
#   - >50% iteration increase (warning)
```

Baseline file format:
```json
{
  "dataset": "tool-selection",
  "timestamp": "2026-04-08T12:00:00Z",
  "metrics": {
    "tool_selection_overall": 0.85,
    "avg_tokens": 1200,
    "avg_cost_usd": 0.003,
    "avg_iterations": 2.1
  }
}
```

---

### Phase 4: End-to-End Task Evals

**Goal:** Test full agent behavior on realistic multi-step tasks.

#### Files

```
src/evals/
  datasets/
    e2e-tasks.json         # Simplified AG3NTS-style tasks
    delegation.json        # Sub-agent handoff cases
  evaluators/
    e2e.ts                 # Composite scorer (tools + answer + cost)
    delegation.ts          # Delegation accuracy
```

#### E2E case format

```json
{
  "id": "e2e-001",
  "message": "Download the file from https://example.com/data.json, extract all email addresses, and save them to a file",
  "expect": {
    "requiredTools": ["web", "execute_code"],
    "answerContains": ["@"],
    "maxIterations": 5,
    "rubric": {
      "task_completion": "Agent must produce a file with extracted emails"
    }
  }
}
```

#### Composite evaluator

Combines scores from:
- Tool selection (Phase 1 evaluator)
- Response quality (Phase 2 evaluator)
- Cost efficiency (Phase 3 metrics)
- Task-specific assertions

Weighted overall score with configurable weights per dimension.

---

### Phase 5: CI Integration

**Goal:** Evals gate PRs automatically.

#### What to build

- GitHub Action: runs Phase 1-2 evals on PR (fast subset, ~5 min budget)
- Prompt version tagging: hash prompt content → Langfuse experiment metadata
- Failure threshold: configurable per dataset (e.g., `tool_selection_overall < 0.8` = fail)

#### GitHub Action sketch

```yaml
name: Eval Gate
on: pull_request
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run eval --dataset tool-selection --ci
      # --ci flag: exits non-zero if below baseline thresholds
```

---

## Implementation order

| Phase | Effort | Depends on | Deliverable |
|-------|--------|-----------|-------------|
| 1 | ~1 day | Nothing | `bun run eval` with tool selection dataset + Langfuse sync |
| 2 | ~1 day | Phase 1 | LLM judge + response quality dataset |
| 3 | ~0.5 day | Phase 1 | Cost metrics + baseline comparison |
| 4 | ~1 day | Phase 1-2 | E2E task evals |
| 5 | ~0.5 day | Phase 1-3 | GitHub Action + CI gating |

## Design decisions

### Why Langfuse-native over promptfoo

The project already has Langfuse tracing wired in (`@langfuse/otel` +
`@langfuse/tracing`). The course reference (`03_01_evals`) uses
`@langfuse/client` for dataset experiments. To get dataset/experiment
support, **`@langfuse/client` must be added as a new dependency** in
Phase 1. This is a small addition (one package) that unlocks: one platform
for traces + evals, dataset versioning, experiment comparison UI. Promptfoo
could be added later for YAML-driven smoke tests.

### Why deterministic-first

LLM-as-judge is expensive and non-deterministic. Phase 1 uses only
deterministic scoring (did tool X get called? yes/no). This is cheap to run,
fast to iterate on, and catches the most common regressions. LLM judging
comes in Phase 2 for cases where deterministic checks aren't sufficient.

### Why per-case agent runs (not event replay)

Evals must test current behavior, not replay past behavior. Each case
runs the agent fresh through `executeTurn`. This is slower but catches
real regressions. Event replay could supplement for cost analysis but
shouldn't replace live runs.

### Why ephemeral sessions

Each eval case gets its own session — no state leakage between cases.
The runner creates a minimal session, runs the agent, captures output,
and discards the session. This matches the course pattern where each
dataset item gets an independent `runAgent` call.