import { describe, expect, it } from "vitest";
import { topupOpenOnHost } from "./visibility";

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
