import { describe, expect, it } from "vitest";
import { isTsdLinkPath } from "./tsd-link-path";

describe("TSD link proxy path allow-list", () => {
  it("allows the documented manifest and claim paths", () => {
    expect(isTsdLinkPath("/api/public/v1/link/c_abc123")).toBe(true);
    expect(isTsdLinkPath("/api/public/v1/link/c_abc123/claim")).toBe(true);
  });

  it("refuses any other path on the TSD host", () => {
    expect(isTsdLinkPath("/api/admin/users")).toBe(false);
    expect(isTsdLinkPath("/api/public/v1/link/c_abc123/../../admin")).toBe(false);
    expect(isTsdLinkPath("/api/public/v1/link/")).toBe(false);
    expect(isTsdLinkPath("/api/public/v1/link/c_abc123/claim/extra")).toBe(false);
  });
});
