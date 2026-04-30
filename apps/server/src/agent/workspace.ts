import { join } from "node:path";
import { config } from "../config/index.ts";
import { sandbox as files } from "../infra/sandbox.ts";

/** Resolved workspace paths (excluding system/) for programmatic use. */
export const workspace = {
  root: config.paths.workspaceDir,
  knowledge: {
    root: config.paths.knowledgeDir,
    index: join(config.paths.knowledgeDir, "_index.md"),
    procedures: join(config.paths.knowledgeDir, "procedures"),
    reference: join(config.paths.knowledgeDir, "reference"),
    insights: join(config.paths.knowledgeDir, "insights"),
    entities: join(config.paths.knowledgeDir, "entities"),
    datasets: join(config.paths.knowledgeDir, "datasets"),
  },
  scratch: config.paths.scratchDir,
  workflows: config.paths.workflowsDir,
  sessions: config.paths.sessionsDir,
  browser: {
    root: config.paths.browserDir,
    session: config.browser.sessionPath,
    pages: config.browser.pagesDir,
  },
} as const;

// ── Static navigation instructions ──────────────────────────────

/**
 * Universal workspace navigation instructions injected into every agent's system prompt.
 * Teaches the LLM how to use the workspace filesystem efficiently.
 */
const NAV_INSTRUCTIONS = `
## Workspace layout

You have a persistent workspace at \`workspace/\`. All paths you pass to read_file, write_file, edit_file, glob, and grep are **absolute** (the file service resolves them from project root).

\`\`\`
workspace/
├── knowledge/              ← Persistent, curated knowledge base
│   ├── _index.md           ← Auto-maintained index — read this FIRST
│   ├── procedures/         ← How-to guides, methodologies, reusable playbooks
│   ├── reference/          ← Lookup data, API docs, inventories, CSV datasets
│   ├── insights/           ← Patterns and non-obvious learnings you discover
│   ├── entities/           ← Known people, places, concepts, domain objects
│   └── datasets/           ← Structured data files (CSV, JSON) for tooling
│
├── scratch/                ← Freeform exploration (disposable)
│                             Use for drafts, intermediate results, brainstorming.
│                             Content here may be deleted without warning.
│
├── workflows/              ← Multi-step workflow definitions
│
├── sessions/{date}/{id}/   ← Ephemeral per-run output (auto-managed)
│   ├── log/                ← Markdown logs + JSONL events
│   ├── shared/             ← Inter-agent file exchange
│   └── {agentName}/output/ ← Your generated artifacts (images, files, etc.)
│
└── browser/                ← Browser automation state & page cache
    ├── session.json        ← Persistent browser session (cookies, etc.)
    └── pages/              ← Cached page content (text + structural extracts)
\`\`\`

## Knowledge base rules

The knowledge base is your long-term memory across sessions. Use it to persist facts, procedures, and reference data that will be valuable in future tasks.

1. **Always check the workspace index below** before using tools to search for knowledge. It lists every entry already available to you.
2. **Update the index** (\`workspace/knowledge/_index.md\`) when you add, rename, or remove a knowledge file.
3. **Place files in the right category:**
   - \`procedures/\` — repeatable processes ("how to solve task X")
   - \`reference/\` — lookup data, API specs, inventories
   - \`insights/\` — non-obvious patterns you discovered
   - \`entities/\` — people, places, concepts relevant to the domain
   - \`datasets/\` — structured CSV/JSON data for tooling
4. **Keep entries atomic.** One file per topic. Update existing files rather than creating duplicates.

## File operation rules

1. **Read before edit.** Always read_file before calling edit_file — you need the checksum and current content.
2. **Use edit_file for changes.** Never overwrite a file with write_file when you only need to change part of it.
3. **write_file for new files only.** Creates parent directories automatically.
4. **Use glob to discover files.** When you don't know what exists in a directory, glob it rather than guessing paths.
5. **Use grep to search content.** When looking for information across files, grep instead of reading files one by one.

## Efficiency rules

1. **Read each file once.** After reading a file, work from memory. Do not re-read unless the file may have changed.
2. **Use paths from tool responses.** When a tool saves a file, the response contains the exact path — use it directly.
3. **Never walk the tree level by level.** If you know a file path, read it directly. Only glob when you genuinely don't know what's inside.
4. **Write to your session output** for generated artifacts. Use the session output path provided by the system.
5. **Write to knowledge/** for information that should persist across sessions.
6. **Write to scratch/** for throwaway work within the current task.
`.trim();

// ── Dynamic workspace context (read from disk at runtime) ───────

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await files.readText(path);
  } catch {
    return null;
  }
}

async function loadWorkflows(): Promise<string | null> {
  const dir = workspace.workflows;
  try {
    const entries = await Array.fromAsync(
      new Bun.Glob("**/*.md").scan({ cwd: dir }),
    );
    if (entries.length === 0) return null;

    const parts: string[] = [];
    for (const entry of entries.sort()) {
      const content = await readFileSafe(join(dir, entry));
      if (content?.trim()) {
        parts.push(`### ${entry}\n\n${content.trim()}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
  } catch {
    return null;
  }
}

/**
 * Build the full workspace context block injected into the system prompt.
 * Reads live content from disk:
 * - knowledge/_index.md  → so the agent knows what knowledge is available
 * - workspace/workflows/  → loaded workflow definitions
 *
 * Called once per agent run (not per turn).
 */
export async function buildWorkspaceContext(): Promise<string> {
  const [knowledgeIndex, workflows] = await Promise.all([
    readFileSafe(workspace.knowledge.index),
    loadWorkflows(),
  ]);

  const sections: string[] = [`<workspace-navigation>`, NAV_INSTRUCTIONS];

  if (knowledgeIndex?.trim()) {
    sections.push(
      `## Workspace Index\n\n${knowledgeIndex.trim()}`,
    );
  }

  if (workflows) {
    sections.push(`## Available Workflows\n\n${workflows}`);
  }

  sections.push(`</workspace-navigation>`);

  return sections.join("\n\n");
}