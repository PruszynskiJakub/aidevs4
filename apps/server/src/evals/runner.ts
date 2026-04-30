import { resolve, basename } from "node:path";
import * as fs from "../infra/fs.ts";
import { initServices, shutdownServices } from "../infra/bootstrap.ts";
import { setConfirmationProvider } from "../agent/confirmation.ts";
import { runEvalCase } from "./harness.ts";
import { toolSelectionEvaluator } from "./evaluators/tool-selection.ts";
import type { EvalCase, Evaluator, EvalCaseResult, EvalRunResult, ScoringMetric } from "./types.ts";

// ── Config ───────────────────────────────────────────────────

const DATASETS_DIR = resolve(import.meta.dir, "datasets"); // evals-local, not workspace

const EVALUATOR_MAP: Record<string, Evaluator> = {
  "tool-selection": toolSelectionEvaluator,
};

// ── CLI arg parsing ──────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let dataset: string | undefined;
  let concurrency = 1;
  let langfuse = false;
  let ci = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dataset":
        dataset = args[++i];
        break;
      case "--concurrency":
        concurrency = Math.max(1, parseInt(args[++i] ?? "1", 10) || 1);
        break;
      case "--langfuse":
        langfuse = true;
        break;
      case "--ci":
        ci = true;
        break;
    }
  }

  return { dataset, concurrency, langfuse, ci };
}

// ── Dataset loading ──────────────────────────────────────────

async function loadDataset(name: string): Promise<EvalCase[]> {
  const path = resolve(DATASETS_DIR, `${name}.json`);
  const raw = await fs.readText(path);
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Dataset ${name} must be a JSON array`);
  }

  return parsed.filter(
    (item: unknown): item is EvalCase =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as EvalCase).id === "string" &&
      typeof (item as EvalCase).message === "string" &&
      typeof (item as EvalCase).expect === "object",
  );
}

function discoverDatasets(): string[] {
  return Object.keys(EVALUATOR_MAP);
}

// ── Execution ────────────────────────────────────────────────

async function runDataset(
  name: string,
  cases: EvalCase[],
  evaluator: Evaluator,
  concurrency: number,
): Promise<EvalRunResult> {
  const results: EvalCaseResult[] = [];

  // Run cases with concurrency control
  const queue = [...cases];
  const running: Promise<void>[] = [];

  async function processCase(evalCase: EvalCase): Promise<void> {
    const caseId = evalCase.id;
    console.log(`  [${caseId}] Running: "${evalCase.message.slice(0, 60)}..."`);

    try {
      const output = await runEvalCase(evalCase.message);
      const scores = await evaluator({
        input: evalCase,
        output,
        expectedOutput: evalCase.expect,
      });

      results.push({ caseId, scores, output });

      const overall = scores.find((s) => s.name.endsWith("_overall"));
      const status = overall && overall.value >= 0.75 ? "PASS" : "FAIL";
      console.log(
        `  [${caseId}] ${status} — overall=${overall?.value.toFixed(2) ?? "?"} tools=[${output.toolNames.join(", ")}]`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${caseId}] ERROR: ${msg}`);
      results.push({
        caseId,
        scores: [{ name: "error", value: 0, comment: msg }],
        output: {
          response: "",
          toolNames: [],
          toolCalls: 0,
          iterations: 0,
          tokens: { input: 0, output: 0, total: 0 },
          durationMs: 0,
        },
      });
    }
  }

  for (const evalCase of queue) {
    if (running.length >= concurrency) {
      await Promise.race(running);
    }
    const promise = processCase(evalCase).then(() => {
      running.splice(running.indexOf(promise), 1);
    });
    running.push(promise);
  }
  await Promise.all(running);

  // Aggregate scores
  const metricSums = new Map<string, { sum: number; count: number }>();
  for (const result of results) {
    for (const score of result.scores) {
      const entry = metricSums.get(score.name) ?? { sum: 0, count: 0 };
      entry.sum += score.value;
      entry.count += 1;
      metricSums.set(score.name, entry);
    }
  }

  const aggregated: Record<string, number> = {};
  for (const [name, { sum, count }] of metricSums) {
    aggregated[name] = sum / count;
  }

  return {
    dataset: name,
    cases: results,
    aggregated,
    timestamp: new Date().toISOString(),
  };
}

// ── Reporting ────────────────────────────────────────────────

function printReport(result: EvalRunResult): void {
  console.log("\n" + "═".repeat(70));
  console.log(`  Dataset: ${result.dataset}`);
  console.log(`  Cases:   ${result.cases.length}`);
  console.log(`  Time:    ${result.timestamp}`);
  console.log("═".repeat(70));

  // Per-case table
  console.log("\n  Case Results:");
  console.log("  " + "-".repeat(66));
  console.log(
    "  " +
      "Case ID".padEnd(12) +
      "Overall".padEnd(10) +
      "Decision".padEnd(10) +
      "Required".padEnd(10) +
      "Forbidden".padEnd(11) +
      "Count".padEnd(8) +
      "Tools",
  );
  console.log("  " + "-".repeat(66));

  for (const c of result.cases) {
    const get = (name: string) =>
      c.scores.find((s) => s.name === name)?.value;

    const overall = get("tool_selection_overall");
    const decision = get("tool_decision");
    const required = get("required_tools");
    const forbidden = get("forbidden_tools");
    const callCount = get("call_count");

    const fmt = (v: number | undefined) =>
      v === undefined ? "—" : v === 1 ? "✓" : "✗";

    const overallFmt =
      overall === undefined ? "ERR" : (overall * 100).toFixed(0) + "%";

    console.log(
      "  " +
        c.caseId.padEnd(12) +
        overallFmt.padEnd(10) +
        fmt(decision).padEnd(10) +
        fmt(required).padEnd(10) +
        fmt(forbidden).padEnd(11) +
        fmt(callCount).padEnd(8) +
        c.output.toolNames.join(", "),
    );
  }

  // Aggregate scores
  console.log("\n  Aggregated Scores:");
  console.log("  " + "-".repeat(40));
  for (const [name, value] of Object.entries(result.aggregated)) {
    console.log(`  ${name.padEnd(30)} ${(value * 100).toFixed(1)}%`);
  }
  console.log("  " + "-".repeat(40));

  const overall = result.aggregated["tool_selection_overall"];
  if (overall !== undefined) {
    console.log(
      `\n  ${overall >= 0.8 ? "✓ PASS" : "✗ FAIL"} — tool_selection_overall: ${(overall * 100).toFixed(1)}%`,
    );
  }
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  const datasetNames = opts.dataset ? [opts.dataset] : discoverDatasets();

  if (datasetNames.length === 0) {
    console.error("No datasets found. Use --dataset <name> or register evaluators.");
    process.exit(1);
  }

  // Auto-approve all tool calls in eval mode (no interactive confirmation)
  setConfirmationProvider({
    async confirm(requests) {
      const results = new Map<string, "approve">();
      for (const req of requests) results.set(req.toolCallId, "approve");
      return results;
    },
  });

  await initServices();

  try {
    for (const name of datasetNames) {
      const evaluator = EVALUATOR_MAP[name];
      if (!evaluator) {
        console.error(`No evaluator registered for dataset "${name}", skipping.`);
        continue;
      }

      console.log(`\nRunning eval: ${name}`);
      console.log("-".repeat(40));

      const cases = await loadDataset(name);
      console.log(`Loaded ${cases.length} cases from ${name}.json\n`);

      const result = await runDataset(name, cases, evaluator, opts.concurrency);
      printReport(result);

      if (opts.ci) {
        const overall = result.aggregated["tool_selection_overall"];
        if (overall !== undefined && overall < 0.8) {
          console.error(`CI gate failed: tool_selection_overall=${(overall * 100).toFixed(1)}% < 80%`);
          process.exit(1);
        }
      }
    }
  } finally {
    await shutdownServices();
  }
}

main().catch((err) => {
  console.error("Eval runner failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
