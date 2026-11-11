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
