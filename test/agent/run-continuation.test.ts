import { describe, it, expect, beforeEach } from "bun:test";
import * as dbOps from "../../apps/server/src/infra/db/index.ts";

beforeEach(() => {
  dbOps._clearAll();
});

// ── Helper ─────────────────────────────────────────────────

function setupSession(id = "s1") {
  dbOps.createSession(id);
  return id;
}

function createRunRow(
  id: string,
  sessionId: string,
  opts: {
    parentId?: string;
    rootRunId?: string;
    sourceCallId?: string;
    status?: string;
    result?: string;
    error?: string;
    waitingOn?: string;
  } = {},
) {
  dbOps.createRun({
    id,
    sessionId,
    parentId: opts.parentId,
    rootRunId: opts.rootRunId,
    sourceCallId: opts.sourceCallId,
    template: "default",
    task: "test task",
  });
  if (opts.status && opts.status !== "pending") {
    dbOps.updateRunStatus(id, {
      status: opts.status as any,
      result: opts.result,
      error: opts.error,
      waitingOn: opts.waitingOn,
      exitKind: opts.status === "waiting" ? undefined : opts.status,
    });
  }
}

// ── rootRunId persistence ──────────────────────────────────

describe("rootRunId", () => {
  it("persists rootRunId on run creation", () => {
    const sid = setupSession();
    createRunRow("root", sid, { rootRunId: "root" });
    const run = dbOps.getRun("root")!;
    expect(run.rootRunId).toBe("root");
  });

  it("child inherits parent rootRunId", () => {
    const sid = setupSession();
    createRunRow("root", sid, { rootRunId: "root" });
    createRunRow("child", sid, { parentId: "root", rootRunId: "root" });
    const child = dbOps.getRun("child")!;
    expect(child.rootRunId).toBe("root");
    expect(child.parentId).toBe("root");
  });

  it("all runs in delegation tree share rootRunId", () => {
    const sid = setupSession();
    createRunRow("A", sid, { rootRunId: "A" });
    createRunRow("B", sid, { parentId: "A", rootRunId: "A" });
    createRunRow("C", sid, { parentId: "B", rootRunId: "A" });

    expect(dbOps.getRun("A")!.rootRunId).toBe("A");
    expect(dbOps.getRun("B")!.rootRunId).toBe("A");
    expect(dbOps.getRun("C")!.rootRunId).toBe("A");
  });
});

// ── findRunWaitingOnChild ──────────────────────────────────

describe("findRunWaitingOnChild", () => {
  it("returns the parent waiting on a specific child", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "child-1" }),
    });
    createRunRow("child-1", sid, {
      parentId: "parent",
      rootRunId: "parent",
      status: "completed",
      result: "done",
    });

    const found = dbOps.findRunWaitingOnChild("child-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("parent");
  });

  it("returns null for root runs (no parent waiting)", () => {
    const sid = setupSession();
    createRunRow("root", sid, {
      rootRunId: "root",
      status: "completed",
      result: "done",
    });

    expect(dbOps.findRunWaitingOnChild("root")).toBeNull();
  });

  it("returns null if parent already resumed", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "completed",
      result: "done",
    });

    expect(dbOps.findRunWaitingOnChild("child-1")).toBeNull();
  });

  it("distinguishes between different child_run waits", () => {
    const sid = setupSession();
    createRunRow("p1", sid, {
      rootRunId: "p1",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "c1" }),
    });
    createRunRow("p2", sid, {
      rootRunId: "p2",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "c2" }),
    });

    const found = dbOps.findRunWaitingOnChild("c1");
    expect(found!.id).toBe("p1");

    const found2 = dbOps.findRunWaitingOnChild("c2");
    expect(found2!.id).toBe("p2");
  });

  it("does not match user_approval waits", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "user_approval", confirmationId: "c1", prompt: "ok?" }),
    });

    expect(dbOps.findRunWaitingOnChild("c1")).toBeNull();
  });
});

// ── findOrphanedWaitingRuns ────────────────────────────────

describe("findOrphanedWaitingRuns", () => {
  it("finds parents whose children are already terminal", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "child" }),
    });
    createRunRow("child", sid, {
      parentId: "parent",
      rootRunId: "parent",
      status: "completed",
      result: "done",
    });

    const orphaned = dbOps.findOrphanedWaitingRuns();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("parent");
  });

  it("does not return parents whose children are still running", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "child" }),
    });
    createRunRow("child", sid, {
      parentId: "parent",
      rootRunId: "parent",
      status: "running",
    });

    const orphaned = dbOps.findOrphanedWaitingRuns();
    expect(orphaned).toHaveLength(0);
  });

  it("handles failed children as orphaned", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "child" }),
    });
    createRunRow("child", sid, {
      parentId: "parent",
      rootRunId: "parent",
      status: "failed",
      error: "boom",
    });

    const orphaned = dbOps.findOrphanedWaitingRuns();
    expect(orphaned).toHaveLength(1);
  });

  it("ignores user_approval waits", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "user_approval", confirmationId: "c1", prompt: "ok?" }),
    });

    const orphaned = dbOps.findOrphanedWaitingRuns();
    expect(orphaned).toHaveLength(0);
  });

  it("handles missing child runs as orphaned", () => {
    const sid = setupSession();
    createRunRow("parent", sid, {
      rootRunId: "parent",
      status: "waiting",
      waitingOn: JSON.stringify({ kind: "child_run", childRunId: "missing-child" }),
    });

    const orphaned = dbOps.findOrphanedWaitingRuns();
    expect(orphaned).toHaveLength(1);
  });
});
