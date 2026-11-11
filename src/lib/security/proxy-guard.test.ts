import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedCaller, isLinkProxyShape, makeRateLimiter, relayJson, safePartnerUrl } from "./proxy-guard";

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

describe("partner pass-through replies (round-2 audit 2.4)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const target = new URL("https://app.nectar-pay.com/api/public/v1/wallet-link?token=abcdefgh123");

  it("serves partner HTML as an error, never as a web page on beekeeper.money", async () => {
    vi.stubGlobal("fetch", async () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }));
    const res = await relayJson(target, { method: "GET" });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("re-serves partner JSON as JSON even when the partner labels it text/html", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"ok":true}', { headers: { "content-type": "text/html" } }));
    const res = await relayJson(target, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses to follow a redirect", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    });
    const res = await relayJson(target, { method: "GET" });
    expect(seen?.redirect).toBe("manual");
    expect(res.status).toBe(502);
  });

  it("refuses a reply larger than 256 KB", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ pad: "x".repeat(300 * 1024) })));
    const res = await relayJson(target, { method: "GET" });
    expect(res.status).toBe(502);
  });

  it("only forwards the NectarPay store-link and sign-in callback shapes", () => {
    expect(isLinkProxyShape(target)).toBe(true);
    expect(isLinkProxyShape(new URL("https://streamtxc.com/api/auth/wallet?id=6f1c2a9e-1b2c-4d3e-8f4a-0123456789ab"))).toBe(true);
    expect(isLinkProxyShape(new URL("https://app.nectar-pay.com/admin/users"))).toBe(false);
    expect(isLinkProxyShape(new URL("https://streamtxc.com/api/auth/wallet?id=not-a-uuid"))).toBe(false);
    expect(isLinkProxyShape(new URL("https://app.nectar-pay.com/api/public/v1/wallet-link"))).toBe(false);
  });
});
