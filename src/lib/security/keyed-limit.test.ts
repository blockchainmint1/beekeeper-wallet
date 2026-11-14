import { describe, expect, it, vi } from "vitest";
import { makeKeyedLimiter } from "./keyed-limit";

describe("cash-out attempts are counted per customer (round-2 audit 3.3)", () => {
  it("allows 2 attempts in the window and refuses the 3rd", () => {
    const limited = makeKeyedLimiter(2, 1000);
    expect(limited("bk_a")).toBe(false);
    expect(limited("bk_a")).toBe(false);
    expect(limited("bk_a")).toBe(true);
  });

  it("counts every customer separately", () => {
    const limited = makeKeyedLimiter(1, 1000);
    expect(limited("bk_a")).toBe(false);
    expect(limited("bk_a")).toBe(true);
    expect(limited("bk_b")).toBe(false);
  });

  it("opens again once the window passes", () => {
    vi.useFakeTimers();
    try {
      const limited = makeKeyedLimiter(1, 1000);
      expect(limited("bk_a")).toBe(false);
      expect(limited("bk_a")).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(limited("bk_a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("confirmation re-checks of one order aren't new attempts (round-4 audit N1)", () => {
  it("remembers an order this customer already started", async () => {
    const { makeOrderMemory } = await import("./keyed-limit");
    const orders = makeOrderMemory(30 * 60_000);
    expect(orders.has("bk_a:BK-1")).toBe(false);
    orders.add("bk_a:BK-1");
    expect(orders.has("bk_a:BK-1")).toBe(true);
    expect(orders.has("bk_a:BK-2")).toBe(false);
  });

  it("a full 5-minute wait (1 start + 20 re-checks) fits the per-order re-check cap of 40", () => {
    const recheck = makeKeyedLimiter(40, 10 * 60_000);
    const results = Array.from({ length: 21 }, () => recheck("bk_a:BK-1"));
    expect(results.every((limited) => limited === false)).toBe(true);
  });
});
