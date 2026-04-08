// ── Eval pipeline core types ──────────────────────────────────

export interface EvalCase {
  id: string;
  message: string;
  expect: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ScoringMetric {
  name: string;
  value: number; // 0–1
  comment?: string;
}

export interface AgentOutput {
  response: string;
  toolNames: string[];
  toolCalls: number;
  iterations: number;
  tokens: { input: number; output: number; total: number };
  durationMs: number;
}

export type Evaluator = (params: {
  input: EvalCase;
  output: AgentOutput;
  expectedOutput: EvalCase["expect"];
}) => Promise<ScoringMetric[]>;

export interface EvalCaseResult {
  caseId: string;
  scores: ScoringMetric[];
  output: AgentOutput;
}

export interface EvalRunResult {
  dataset: string;
  cases: EvalCaseResult[];
  aggregated: Record<string, number>; // metric name → average
  timestamp: string;
}