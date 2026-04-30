import { describe, it, expect } from "bun:test";
import { elapsed } from "../../apps/server/src/utils/timing.ts";

describe("elapsed", () => {
  it("returns formatted elapsed time", () => {
    const start = performance.now() - 1500;
    const result = elapsed(start);
    expect(result).toMatch(/^\d+\.\d{2}s$/);
    const seconds = parseFloat(result);
    expect(seconds).toBeGreaterThan(1.0);
    expect(seconds).toBeLessThan(3.0);
  });
});
