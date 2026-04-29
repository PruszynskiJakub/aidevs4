import { describe, it, expect, beforeEach } from "bun:test";
import * as dbOps from "../../../src/infra/db/index.ts";
import { sqlite } from "../../../src/infra/db/connection.ts";

beforeEach(() => {
  dbOps._clearAll();
});

describe("SQLite pragmas", () => {
  it("synchronous is set to NORMAL (1)", () => {
    const row = sqlite.query("PRAGMA synchronous").get() as { synchronous: number };
    expect(row.synchronous).toBe(1);
  });

  it("busy_timeout is set to 5000", () => {
    const row = sqlite.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });

  it("journal_mode is WAL", () => {
    const row = sqlite.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("foreign_keys is ON (1)", () => {
    const row = sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });
});

describe("withTransaction", () => {
  it("commits when the body completes normally", () => {
    dbOps.withTransaction((tx) => {
      dbOps.createSession("tx-commit", tx);
    });
    expect(dbOps.getSession("tx-commit")).not.toBeNull();
  });

  it("rolls back every write when the body throws", () => {
    dbOps.createSession("base");
    expect(() => {
      dbOps.withTransaction((tx) => {
        dbOps.createSession("tx-rollback", tx);
        dbOps.setAssistant("base", "should-not-stick", tx);
        throw new Error("simulated mid-transaction failure");
      });
    }).toThrow("simulated mid-transaction failure");

    // Both writes must have been rolled back
    expect(dbOps.getSession("tx-rollback")).toBeNull();
    expect(dbOps.getSession("base")!.assistant).toBeNull();
  });

  it("appends multiple items atomically when threaded through tx", () => {
    dbOps.createSession("s-multi");
    dbOps.createRun({ id: "r-multi", sessionId: "s-multi", template: "default", task: "t" });

    dbOps.withTransaction((tx) => {
      dbOps.appendItem({
        id: "i1", runId: "r-multi", sequence: 0, type: "message", role: "user", content: "hi",
      }, tx);
      dbOps.appendItem({
        id: "i2", runId: "r-multi", sequence: 1, type: "message", role: "assistant", content: "ok",
      }, tx);
    });

    expect(dbOps.listItemsByRun("r-multi")).toHaveLength(2);
  });

  it("rolls back partial item batch when the second insert throws", () => {
    dbOps.createSession("s-rb");
    dbOps.createRun({ id: "r-rb", sessionId: "s-rb", template: "default", task: "t" });

    expect(() => {
      dbOps.withTransaction((tx) => {
        dbOps.appendItem({
          id: "i1", runId: "r-rb", sequence: 0, type: "message", role: "user", content: "first",
        }, tx);
        // Duplicate primary key triggers a SQLite UNIQUE constraint failure
        dbOps.appendItem({
          id: "i1", runId: "r-rb", sequence: 1, type: "message", role: "user", content: "dup",
        }, tx);
      });
    }).toThrow();

    expect(dbOps.listItemsByRun("r-rb")).toHaveLength(0);
  });

  it("returns the body's value", () => {
    const result = dbOps.withTransaction((_tx) => 42);
    expect(result).toBe(42);
  });

  it("appendItems composes inside an outer withTransaction without nested-tx error", () => {
    dbOps.createSession("s-append");
    dbOps.createRun({ id: "r-append", sessionId: "s-append", template: "default", task: "t" });

    dbOps.withTransaction((tx) => {
      dbOps.appendItems([
        { id: "a", runId: "r-append", sequence: 0, type: "message", role: "user", content: "a" },
        { id: "b", runId: "r-append", sequence: 1, type: "message", role: "user", content: "b" },
      ], tx);
    });

    expect(dbOps.listItemsByRun("r-append")).toHaveLength(2);
  });

  it("appendItems still runs as its own tx when called without an outer tx", () => {
    dbOps.createSession("s-bare");
    dbOps.createRun({ id: "r-bare", sessionId: "s-bare", template: "default", task: "t" });

    dbOps.appendItems([
      { id: "x", runId: "r-bare", sequence: 0, type: "message", role: "user", content: "x" },
      { id: "y", runId: "r-bare", sequence: 1, type: "message", role: "user", content: "y" },
    ]);

    expect(dbOps.listItemsByRun("r-bare")).toHaveLength(2);
  });
});
