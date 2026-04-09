import { join } from "node:path";
import { config } from "../config/index.ts";

const W = config.paths.workspaceDir;

/** Resolved workspace paths (excluding system/) for programmatic use. */
export const workspace = {
  root: W,
  knowledge: {
    root: join(W, "knowledge"),
    index: join(W, "knowledge", "_index.md"),
    procedures: join(W, "knowledge", "procedures"),
    reference: join(W, "knowledge", "reference"),
    insights: join(W, "knowledge", "insights"),
    entities: join(W, "knowledge", "entities"),
    datasets: join(W, "knowledge", "datasets"),
  },
  scratch: join(W, "scratch"),
  workflows: join(W, "workflows"),
  sessions: join(W, "sessions"),
  browser: {
    root: join(W, "browser"),
    session: join(W, "browser", "session.json"),
    pages: join(W, "browser", "pages"),
  },
} as const;

/**
 * Universal workspace navigation instructions injected into every agent's system prompt.
 * Teaches the LLM how to use the workspace filesystem efficiently.
 */
export const WORKSPACE_NAV_INSTRUCTIONS = `
<workspace-navigation>
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

1. **Always read \`workspace/knowledge/_index.md\` first** when looking for stored knowledge. It lists every entry with a one-line description.
2. **Update the index** when you add, rename, or remove a knowledge file.
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
</workspace-navigation>
`.trim();