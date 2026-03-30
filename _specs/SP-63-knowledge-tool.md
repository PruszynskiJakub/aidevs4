# SP-63 Knowledge Tool (Reverse RAG)

## Main objective

Give agents a `knowledge` tool for navigating a curated, agent-friendly
knowledge base stored as plain markdown files in `workspace/knowledge/`. No
vector DB, no embeddings, no chunking — just structured files the agent
traverses by following explicit cross-references embedded in document content.

This is the "Reverse RAG" pattern from S02E03: instead of connecting agents to
existing human docs via search, we **build the knowledge base for agents** so
they always know where to look.

## Context

The agent already navigates code effectively using `read_file`, `glob`, and
`grep`. But there's no dedicated mechanism for curated domain knowledge —
procedures, project context, reference data. The `workspace/knowledge/`
directory exists but is empty.

The course material (S02E03) shows that agent-oriented knowledge bases
outperform traditional RAG for bounded domains because:

- Navigation is deterministic (follow links) vs. probabilistic (similarity)
- Documents contain explicit cross-references → no "lost context" problem
- No indexing pipeline to maintain
- Works with the existing file service sandbox (read-only from `PROJECT_ROOT`)

### Why a dedicated tool instead of just `read_file` + `glob`

1. **Scoped discovery** — `knowledge__list` shows only knowledge base contents,
   not the entire project tree. Reduces noise and token waste.
2. **Cross-reference extraction** — `knowledge__read` parses `See also:` links
   and returns them as structured metadata, nudging the agent to follow them.
3. **Agent prompt integration** — agents can be told "your domain knowledge is
   available via the knowledge tool" instead of "grep around in workspace/".

## Out of scope

- Automated indexing / ingestion pipeline (docs are authored manually or by a
  separate playground script — that's a future spec)
- Vector search / embeddings / semantic matching
- Write access (agents don't modify the knowledge base at runtime)
- Graph database integration
- Knowledge base versioning or sync

## Constraints

- Read-only — the tool never writes to `workspace/knowledge/`
- Uses `files` service for all I/O (sandbox enforced)
- No new runtime dependencies
- Documents are plain `.md` files with optional YAML frontmatter
- Max file size enforced by `files.checkFileSize()`
- Cross-references use relative paths within `workspace/knowledge/`

## Knowledge base structure

```
workspace/knowledge/
├── _index.md              # Root map — topics, short descriptions, entry points
├── procedures/
│   ├── task-management.md
│   └── code-review.md
├── projects/
│   ├── overview.md
│   └── aidevs4.md
└── reference/
    ├── api-endpoints.md
    └── glossary.md
```

### Document format

Every document is markdown with optional YAML frontmatter:

```markdown
---
title: Task Management Procedure
tags: [linear, tasks, workflow]
---

## Purpose

Describes how to create, assign, and track tasks in Linear.

## Steps

1. Check project context in [projects/overview.md](../projects/overview.md)
2. ...

## See also

- [Code Review Procedure](./code-review.md) — related workflow
- [Project Overview](../projects/overview.md) — project assignments
```

**Cross-reference convention**: Standard markdown links with relative paths.
The tool extracts these from `## See also` sections and from inline links
throughout the document body.

### Root index (`_index.md`)

```markdown
---
title: Knowledge Base Index
---

## Procedures
- [Task Management](procedures/task-management.md) — creating and tracking tasks
- [Code Review](procedures/code-review.md) — review workflow and checklist

## Projects
- [Overview](projects/overview.md) — all active projects
- [AI Devs 4](projects/aidevs4.md) — course project details

## Reference
- [API Endpoints](reference/api-endpoints.md) — hub API reference
- [Glossary](reference/glossary.md) — domain terms
```

The agent starts here. Each entry is a signpost — the agent reads only what
it needs.

## Tool design

Multi-action tool: `knowledge` with actions `list` and `read`.

### `knowledge__list`

**Purpose**: Show what's available. Returns `_index.md` content if it exists,
otherwise a flat file listing of `workspace/knowledge/`.

**Parameters**:
```
path  string  optional  Subdirectory to list (relative to knowledge root).
                        Defaults to "" (root). e.g. "procedures"
```

**Returns**: Index content or directory listing with relative paths and file
sizes.

**Behavior**:
1. Resolve `path` within `workspace/knowledge/` (reject `..`, absolute paths)
2. If `_index.md` exists at that level, return its content
3. Otherwise, `readdir` recursively and return a flat listing
4. Hint: "Read a specific document to see its full content and cross-references."

### `knowledge__read`

**Purpose**: Read a knowledge document and extract its cross-references.

**Parameters**:
```
path  string  required  Path to the document relative to knowledge root.
                        e.g. "procedures/task-management.md"
```

**Returns**: Document content (with line numbers) + extracted cross-reference
list.

**Behavior**:
1. Validate `path` — reject `..`, absolute paths, non-`.md` extensions
2. Resolve to `workspace/knowledge/{path}`
3. `checkFileSize()`, `readText()`
4. Parse YAML frontmatter (title, tags) if present
5. Extract cross-references: all markdown links `[text](relative-path.md)`
   where the target is within the knowledge base
6. Return:
   ```
   # {title or filename}
   Tags: {tags if present}

   {document content with line numbers}

   ## Cross-references
   - procedures/code-review.md — "Code Review Procedure"
   - projects/overview.md — "Project Overview"

   Note: Follow cross-references to explore related topics, or list a
   directory to discover other documents.
   ```

## Input validation

| Check | Rule |
|---|---|
| `path` type | Must be string, max 256 chars |
| Path traversal | Reject if contains `..` or starts with `/` |
| Char allowlist | `/^[a-zA-Z0-9_.\-\/]+$/` (alphanumeric + `_.-/`) |
| Extension | `read` action: must end with `.md` |
| Existence | Throw descriptive error if file/dir not found |

## Implementation

### File: `src/tools/knowledge.ts`

```typescript
import { z } from "zod";
import { join, resolve, relative, extname, basename } from "path";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { files } from "../infra/file.ts";
import { config } from "../config/index.ts";
import { assertMaxLength, validateKeys } from "../utils/parse.ts";

const KNOWLEDGE_ROOT = join(config.paths.workspaceDir, "knowledge");
const PATH_RE = /^[a-zA-Z0-9_.\-\/]+$/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

function safePath(inputPath: string): string {
  assertMaxLength(inputPath, "path", 256);
  if (inputPath.includes("..") || inputPath.startsWith("/")) {
    throw new Error("Path must be relative and cannot contain '..'");
  }
  if (inputPath && !PATH_RE.test(inputPath)) {
    throw new Error("Path contains invalid characters");
  }
  const resolved = resolve(join(KNOWLEDGE_ROOT, inputPath));
  if (!resolved.startsWith(KNOWLEDGE_ROOT)) {
    throw new Error("Path escapes knowledge base root");
  }
  return resolved;
}

function extractCrossRefs(content: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(LINK_RE)) {
    const [, linkText, href] = match;
    if (!href.startsWith("http") && !href.startsWith("#")) {
      refs.push(`${href} — "${linkText}"`);
    }
  }
  return [...new Set(refs)];
}

async function listKnowledge(args: Record<string, unknown>): Promise<ToolResult> {
  const inputPath = (args.path as string) || "";
  const resolved = safePath(inputPath);

  // Try _index.md first
  const indexPath = join(resolved, "_index.md");
  if (await files.exists(indexPath)) {
    const content = await files.readText(indexPath);
    return text(content + "\n\nNote: Read a specific document to see its full content and cross-references.");
  }

  // Fallback: directory listing
  const entries = await files.readdir(resolved);
  const lines: string[] = [];
  for (const entry of entries.sort()) {
    const entryPath = join(resolved, entry);
    const s = await files.stat(entryPath);
    const rel = relative(KNOWLEDGE_ROOT, entryPath);
    const prefix = s.isDirectory ? "[dir]" : `${Math.ceil(s.size / 1024)}KB`;
    lines.push(`${prefix}  ${rel}`);
  }

  if (lines.length === 0) {
    return text("Knowledge base is empty at this path.");
  }

  return text(lines.join("\n") + "\n\nNote: Read a document or list a subdirectory to explore further.");
}

async function readKnowledge(args: Record<string, unknown>): Promise<ToolResult> {
  validateKeys(args);
  const inputPath = args.path as string;
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("path is required and must be a non-empty string");
  }
  if (extname(inputPath) !== ".md") {
    throw new Error("Only .md files can be read from the knowledge base");
  }

  const resolved = safePath(inputPath);
  await files.checkFileSize(resolved);
  const raw = await files.readText(resolved);

  // Parse optional frontmatter
  let title = basename(inputPath, ".md");
  let tags = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx !== -1) {
      const fm = raw.slice(3, endIdx);
      const titleMatch = fm.match(/title:\s*(.+)/);
      const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
      if (titleMatch) title = titleMatch[1].trim();
      if (tagsMatch) tags = tagsMatch[1].trim();
      body = raw.slice(endIdx + 3).trimStart();
    }
  }

  const numbered = body.split("\n").map((line, i) => `  ${i + 1}\t${line}`).join("\n");
  const crossRefs = extractCrossRefs(raw);

  let result = `# ${title}\n`;
  if (tags) result += `Tags: ${tags}\n`;
  result += `\n${numbered}`;

  if (crossRefs.length > 0) {
    result += `\n\n## Cross-references\n${crossRefs.map(r => `- ${r}`).join("\n")}`;
  }

  result += "\n\nNote: Follow cross-references to explore related topics, or list a directory to discover other documents.";
  return text(result);
}
```

### Registration in `src/tools/index.ts`

```typescript
import knowledge from "./knowledge.ts";
// ...
register(knowledge);
```

### Export shape

```typescript
export default {
  name: "knowledge",
  schema: {
    name: "knowledge",
    description: "Navigate a curated knowledge base of markdown documents. Use list to discover available topics, then read to get document content and cross-references. Documents link to each other — follow cross-references to build full context.",
    actions: {
      list: {
        description: "List available knowledge documents. Returns the index if one exists, otherwise a directory listing. Start here to discover what's available.",
        schema: z.object({
          path: z.string().describe("Subdirectory to list, relative to knowledge root. Empty string for root."),
        }),
      },
      read: {
        description: "Read a knowledge document. Returns content with line numbers and extracted cross-references to related documents.",
        schema: z.object({
          path: z.string().describe("Path to .md file relative to knowledge root. e.g. 'procedures/task-management.md'"),
        }),
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
    const action = args.action as string;
    const payload = args.payload as Record<string, unknown>;
    if (action === "list") return listKnowledge(payload);
    if (action === "read") return readKnowledge(payload);
    throw new Error(`Unknown action: ${action}`);
  },
} satisfies ToolDefinition;
```

## Tests (`src/tools/knowledge.test.ts`)

| Case | Action | Input | Expected |
|---|---|---|---|
| Happy: list root with index | `list` | `path: ""` | Returns `_index.md` content |
| Happy: list subdirectory | `list` | `path: "procedures"` | Returns file listing |
| Happy: read document | `read` | `path: "procedures/task-management.md"` | Content + cross-refs |
| Happy: read doc without frontmatter | `read` | `path: "reference/glossary.md"` | Content, filename as title |
| Boundary: empty knowledge base | `list` | `path: ""` | "Knowledge base is empty" |
| Boundary: doc with no cross-refs | `read` | `path: "reference/glossary.md"` | Content, no cross-refs section |
| Invalid: path traversal `../` | both | `path: "../etc/passwd"` | Error: cannot contain `..` |
| Invalid: absolute path | both | `path: "/etc/passwd"` | Error: must be relative |
| Invalid: non-.md extension | `read` | `path: "data.json"` | Error: only .md files |
| Invalid: missing file | `read` | `path: "nope.md"` | Error: file not found |
| Invalid: special chars | both | `path: "foo;rm -rf.md"` | Error: invalid characters |
| Invalid: prototype pollution | both | `{ __proto__: {} }` | Rejected by `validateKeys` |

## Agent integration

Add `knowledge` to agent tool lists where domain knowledge is needed:

```yaml
# workspace/agents/default.agent.md (updated tools list)
tools:
  - knowledge
  - read_file
  - grep
  # ...
```

Agent system prompt addition (one line):

> Your domain knowledge is available via the knowledge tool. Start with `list`
> to see what's available, then `read` specific documents. Follow
> cross-references within documents to build full context before acting.

## Usage flow

```
User: "Add a task for the auth migration to Linear"

Agent thinking:
  1. knowledge__list(path: "")          → sees _index.md with procedures/ and projects/
  2. knowledge__read("procedures/task-management.md")  → gets task creation rules,
                                                          sees cross-ref to projects/overview.md
  3. knowledge__read("projects/overview.md")           → finds auth-migration project details
  4. agents_hub__api_request(...)                       → creates the Linear task
```

## Checklist

- [ ] `src/tools/knowledge.ts` — tool implementation
- [ ] `src/tools/knowledge.test.ts` — test suite
- [ ] `src/tools/index.ts` — register the tool
- [ ] `workspace/knowledge/_index.md` — seed root index (can be minimal)
- [ ] Update agent `.agent.md` files to include `knowledge` in tool lists
