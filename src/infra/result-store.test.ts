import { describe, it, expect, beforeEach } from "bun:test";
import { createResultStore } from "./result-store.ts";

describe("resultStore", () => {
  let store: ReturnType<typeof createResultStore>;

  beforeEach(() => {
    store = createResultStore();
  });

  it("create() records a pending entry", () => {
    store.create("call-1", "grep", { pattern: "foo" });
    const record = store.get("call-1");
    expect(record).toBeDefined();
    expect(record!.status).toBe("pending");
    expect(record!.toolName).toBe("grep");
    expect(record!.args).toEqual({ pattern: "foo" });
    expect(record!.result).toBeNull();
  });

  it("complete() updates the record with result and tokens", () => {
    store.create("call-2", "bash", { command: "echo hi" });
    const result = { content: [{ type: "text" as const, text: "hi" }] };
    store.complete("call-2", result, 1);
    const record = store.get("call-2");
    expect(record!.status).toBe("ok");
    expect(record!.result).toEqual(result);
    expect(record!.tokens).toBe(1);
    expect(record!.completedAt).not.toBeNull();
  });

  it("complete() sets status to error when isError is true", () => {
    store.create("call-3", "fail", {});
    const result = { content: [{ type: "text" as const, text: "boom" }], isError: true };
    store.complete("call-3", result, 2);
    expect(store.get("call-3")!.status).toBe("error");
  });

  it("complete() creates on-the-fly if not pre-registered", () => {
    const result = { content: [{ type: "text" as const, text: "ok" }] };
    store.complete("orphan", result, 5);
    const record = store.get("orphan");
    expect(record).toBeDefined();
    expect(record!.status).toBe("ok");
  });

  it("list() returns all records", () => {
    store.create("a", "t1", {});
    store.create("b", "t2", {});
    expect(store.list()).toHaveLength(2);
  });

  it("clear() removes all records", () => {
    store.create("a", "t1", {});
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.get("a")).toBeUndefined();
  });

  it("get() returns undefined for unknown ID", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
