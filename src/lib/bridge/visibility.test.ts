import { describe, expect, it } from "vitest";
import { registerUnlockTap, topupOpenOnHost } from "./visibility";

describe("top-up visibility while Bridge is in sandbox", () => {
  it("stays closed on beekeeper.money", () => {
    expect(topupOpenOnHost("beekeeper.money")).toBe(false);
  });
  it("stays closed on the published lovable.app address", () => {
    expect(topupOpenOnHost("beekeeper-wallet.lovable.app")).toBe(false);
  });
  it("is open in the preview for testing", () => {
    expect(topupOpenOnHost("id-preview--3a708215-418e-4b41-bf12-6c478c0771c2.lovable.app")).toBe(true);
  });
});

describe("five-tap tester unlock on the live site", () => {
  it("unlocks after 5 quick taps", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < 5; i++) ({ taps, unlocked } = registerUnlockTap(taps, 1000 + i * 300));
    expect(unlocked).toBe(true);
  });
  it("stays locked after 4 taps", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < 4; i++) ({ taps, unlocked } = registerUnlockTap(taps, 1000 + i * 300));
    expect(unlocked).toBe(false);
  });
  it("stays locked when the 5 taps are slow", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < 5; i++) ({ taps, unlocked } = registerUnlockTap(taps, 1000 + i * 1000));
    expect(unlocked).toBe(false);
  });
});
