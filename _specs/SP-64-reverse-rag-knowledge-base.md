# SP-64 Reverse RAG Knowledge Base (without dedicated tool)

## Main objective

Establish a curated, agent-navigable knowledge base in `workspace/knowledge/`
using only existing file tools (`read_file`, `glob`, `grep`). Remove the
dedicated `knowledge` tool from SP-63 — it duplicates capabilities the agent
already has.

The value of Reverse RAG is in **how documents are structured** (cross-linked,
agent-oriented), not in having a special tool to read them.

## Context

SP-63 introduced a `knowledge` multi-action tool. Manual testing showed the
agent navigates the knowledge base effectively, but the tool adds no real
capability over `read_file` + `glob`:

- Cross-reference extraction — the agent reads markdown links natively
- Scoped listing — `glob("workspace/knowledge/**/*.md")` does this
- Frontmatter parsing — LLMs read YAML frontmatter without help

Maintaining a separate tool for this is unnecessary complexity. The real
pattern is:

1. **Structure**: `workspace/knowledge/` with `_index.md` entry points and
   markdown links between documents
2. **Prompt**: tell the agent where to look
3. **Navigation**: agent uses existing file tools to follow the links

## Changes

### 1. Remove `knowledge` tool

Delete:
- `src/tools/knowledge.ts`
- `src/tools/knowledge.test.ts`

Update:
- `src/tools/index.ts` — remove import and `register(knowledge)` call

### 2. Add knowledge base path to agent system prompt

In `workspace/agents/default.agent.md`, add a section after "## Workflow":

```markdown
## Knowledge Base

Before starting an unfamiliar task type, check `workspace/knowledge/_index.md`
for procedures, API references, and tips. Follow markdown links between
documents to build context. Use `read_file` to read documents and `glob` to
discover files.
```

This is minimal — one paragraph, no new tools to learn. The agent already
knows how to use `read_file` and `glob`.

### 3. Keep knowledge base content

Retain everything under `workspace/knowledge/`:

```
workspace/knowledge/
├── _index.md                    # Root map — entry point
├── procedures/
│   └── task-solving.md          # How to approach hub tasks
└── reference/
    ├── hub-api.md               # AG3NTS hub endpoints
    └── tool-inventory.md        # Which tool for which job
```

These files are the actual Reverse RAG asset. Their structure — cross-linked
markdown with `_index.md` as a directory — is what makes navigation
deterministic.

### 4. Update spec SP-63

Mark SP-63 as superseded by SP-64 (add a note at the top).

## Document conventions (unchanged from SP-63)

- Plain `.md` files with optional YAML frontmatter (`title`, `tags`)
- Cross-references via standard markdown links with relative paths
- `_index.md` at directory root serves as the entry point / table of contents
- Subdirectories organize by topic (`procedures/`, `reference/`, `projects/`)
- Documents designed for agent consumption: concise, actionable, linked

## Checklist

- [ ] Delete `src/tools/knowledge.ts`
- [ ] Delete `src/tools/knowledge.test.ts`
- [ ] Update `src/tools/index.ts` — remove knowledge import and registration
- [ ] Add "Knowledge Base" section to `workspace/agents/default.agent.md`
- [ ] Add superseded note to `_specs/SP-63-knowledge-tool.md`
- [ ] Verify `bun test` passes after removal
