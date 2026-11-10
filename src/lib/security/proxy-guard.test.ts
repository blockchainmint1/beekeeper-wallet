import { describe, expect, it } from "vitest";
import { isAllowedCaller, makeRateLimiter, safePartnerUrl } from "./proxy-guard";

const HOSTS = new Set(["app.nectar-pay.com"]);

function req(headers: Record<string, string>) {
  return new Request("https://beekeeper.money/api/nectar/link", { method: "POST", headers });
}

describe("partner pass-through guards", () => {
  it("only accepts https URLs on a trusted host with no path tricks", () => {
    expect(safePartnerUrl("https://app.nectar-pay.com/api/link/abc", HOSTS)?.hostname).toBe("app.nectar-pay.com");
    expect(safePartnerUrl("https://evil.example/api/link", HOSTS)).toBeNull();
    expect(safePartnerUrl("http://app.nectar-pay.com/api/link", HOSTS)).toBeNull();
    expect(safePartnerUrl("https://app.nectar-pay.com:8443/api/link", HOSTS)).toBeNull();
    expect(safePartnerUrl("https://user:pw@app.nectar-pay.com/api/link", HOSTS)).toBeNull();
    expect(safePartnerUrl("https://app.nectar-pay.com/api/%2e%2e/admin", HOSTS)).toBeNull();
  });

  it("accepts calls from beekeeper.money and refuses other websites", () => {
    expect(isAllowedCaller(req({ origin: "https://beekeeper.money", host: "beekeeper.money" }))).toBe(true);
    expect(isAllowedCaller(req({ origin: "https://evil.example", host: "beekeeper.money" }))).toBe(false);
    expect(isAllowedCaller(req({ host: "beekeeper.money" }))).toBe(false);
  });

  it("blocks an address after the per-minute limit", () => {
    const limited = makeRateLimiter(3);
    const r = req({ "x-forwarded-for": "203.0.113.9" });
    expect([limited(r), limited(r), limited(r), limited(r)]).toEqual([false, false, false, true]);
  });
});
