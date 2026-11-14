import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNonceGuard } from "./seen-nonce";

afterEach(() => vi.useRealTimers());

describe("a signed request works once (round-4 audit B5)", () => {
  it("accepts a nonce the first time and refuses the replay", () => {
    const replayed = makeNonceGuard(5 * 60_000);
    expect(replayed("Taddr:abc")).toBe(false);
    expect(replayed("Taddr:abc")).toBe(true);
  });

  it("treats each wallet's nonces separately", () => {
    const replayed = makeNonceGuard(5 * 60_000);
    expect(replayed("Ta:n1")).toBe(false);
    expect(replayed("Tb:n1")).toBe(false);
  });

  it("forgets a nonce only after its signature would have expired anyway", () => {
    vi.useFakeTimers();
    const replayed = makeNonceGuard(5 * 60_000);
    expect(replayed("Ta:n1")).toBe(false);
    vi.advanceTimersByTime(4 * 60_000);
    expect(replayed("Ta:n1")).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(replayed("Ta:n1")).toBe(false);
  });
});
