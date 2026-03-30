import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import type { ToolResult } from "../types/tool-result.ts";
import { createBunFileService, _setFilesForTest } from "../infra/file.ts";
import knowledge from "./knowledge.ts";

let tmpDir: string;
let restore: () => void;

function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

/**
 * The tool resolves KNOWLEDGE_ROOT from config at import time.
 * We work around this by creating a `workspace/knowledge/` tree inside tmpDir
 * and pointing the file service sandbox at tmpDir.
 *
 * However, KNOWLEDGE_ROOT is baked to the real project path. So instead we
 * test the handler indirectly through the exported default, and set up the
 * real workspace/knowledge dir with test fixtures, restoring afterwards.
 *
 * Simpler approach: override the file service so all reads go through tmpDir,
 * then build a knowledge/ tree that matches the real KNOWLEDGE_ROOT path.
 */

let knowledgeDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "knowledge_test_"));

  // Mirror the real knowledge root structure under tmpDir
  // The tool uses config.paths.workspaceDir + "knowledge" which resolves to
  // the real workspace dir. We override the file service to allow reads from
  // the real workspace dir but we'll write test files there.
  // Actually, let's just use the real workspace/knowledge path for tests since
  // it's empty, and clean up after.
  const { config } = await import("../config/index.ts");
  knowledgeDir = join(config.paths.workspaceDir, "knowledge");

  // Create test fixture tree
  await mkdir(join(knowledgeDir, "procedures"), { recursive: true });
  await mkdir(join(knowledgeDir, "reference"), { recursive: true });

  await Bun.write(join(knowledgeDir, "_index.md"), `---
title: Knowledge Base Index
---

## Procedures
- [Task Management](procedures/task-management.md) — creating and tracking tasks

## Reference
- [Glossary](reference/glossary.md) — domain terms
`);

  await Bun.write(join(knowledgeDir, "procedures", "task-management.md"), `---
title: Task Management Procedure
tags: [linear, tasks, workflow]
---

## Purpose

Describes how to create and track tasks.

## Steps

1. Check project context in [projects/overview.md](../projects/overview.md)
2. Assign to the right team member

## See also

- [Glossary](../reference/glossary.md) — domain terms
`);

  await Bun.write(join(knowledgeDir, "reference", "glossary.md"), `## Terms

- **RAG**: Retrieval-Augmented Generation
- **LLM**: Large Language Model
`);
});

afterAll(async () => {
  // Clean up test fixtures
  await rm(knowledgeDir, { recursive: true, force: true });
  // Recreate empty dir so workspace structure is intact
  await mkdir(knowledgeDir, { recursive: true });
});

describe("knowledge tool", () => {
  describe("list action", () => {
    it("returns _index.md content when it exists at root", async () => {
      const result = await knowledge.handler({ action: "list", payload: { path: "" } });
      const t = getText(result);
      expect(t).toContain("Knowledge Base Index");
      expect(t).toContain("procedures/task-management.md");
      expect(t).toContain("Note:");
    });

    it("returns directory listing when no _index.md in subdirectory", async () => {
      const result = await knowledge.handler({ action: "list", payload: { path: "reference" } });
      const t = getText(result);
      expect(t).toContain("reference/glossary.md");
      expect(t).toContain("KB");
    });

    it("returns empty message for empty directory", async () => {
      await mkdir(join(knowledgeDir, "empty"), { recursive: true });
      const result = await knowledge.handler({ action: "list", payload: { path: "empty" } });
      expect(getText(result)).toContain("empty");
      await rm(join(knowledgeDir, "empty"), { recursive: true });
    });

    it("rejects path traversal", async () => {
      await expect(
        knowledge.handler({ action: "list", payload: { path: "../etc" } }),
      ).rejects.toThrow("cannot contain '..'");
    });

    it("rejects absolute path", async () => {
      await expect(
        knowledge.handler({ action: "list", payload: { path: "/etc" } }),
      ).rejects.toThrow("must be relative");
    });

    it("rejects special characters in path", async () => {
      await expect(
        knowledge.handler({ action: "list", payload: { path: "foo;rm -rf" } }),
      ).rejects.toThrow("invalid characters");
    });
  });

  describe("read action", () => {
    it("reads document with frontmatter, line numbers, and cross-refs", async () => {
      const result = await knowledge.handler({ action: "read", payload: { path: "procedures/task-management.md" } });
      const t = getText(result);
      expect(t).toContain("# Task Management Procedure");
      expect(t).toContain("Tags: linear, tasks, workflow");
      expect(t).toContain("  1\t");
      expect(t).toContain("## Cross-references");
      expect(t).toContain('../projects/overview.md — "projects/overview.md"');
      expect(t).toContain('../reference/glossary.md — "Glossary"');
    });

    it("reads document without frontmatter using filename as title", async () => {
      const result = await knowledge.handler({ action: "read", payload: { path: "reference/glossary.md" } });
      const t = getText(result);
      expect(t).toContain("# glossary");
      expect(t).not.toContain("Tags:");
      expect(t).toContain("  1\t## Terms");
    });

    it("does not include cross-references section when none found", async () => {
      const result = await knowledge.handler({ action: "read", payload: { path: "reference/glossary.md" } });
      const t = getText(result);
      expect(t).not.toContain("## Cross-references");
    });

    it("rejects non-.md extension", async () => {
      await expect(
        knowledge.handler({ action: "read", payload: { path: "data.json" } }),
      ).rejects.toThrow("Only .md files");
    });

    it("rejects missing file", async () => {
      await expect(
        knowledge.handler({ action: "read", payload: { path: "nope.md" } }),
      ).rejects.toThrow();
    });

    it("rejects empty path", async () => {
      await expect(
        knowledge.handler({ action: "read", payload: { path: "" } }),
      ).rejects.toThrow("required");
    });

    it("rejects path traversal", async () => {
      await expect(
        knowledge.handler({ action: "read", payload: { path: "../etc/passwd.md" } }),
      ).rejects.toThrow("cannot contain '..'");
    });

    it("rejects special characters", async () => {
      await expect(
        knowledge.handler({ action: "read", payload: { path: "foo;rm -rf.md" } }),
      ).rejects.toThrow("invalid characters");
    });
  });

  describe("handler dispatch", () => {
    it("rejects unknown action", async () => {
      await expect(
        knowledge.handler({ action: "delete", payload: { path: "" } }),
      ).rejects.toThrow("Unknown knowledge action");
    });

    it("rejects prototype pollution keys in payload", async () => {
      const payload = Object.create(null);
      payload.__proto__ = "x";
      payload.path = "";
      await expect(
        knowledge.handler({ action: "list", payload }),
      ).rejects.toThrow("Forbidden key");
    });
  });
});
