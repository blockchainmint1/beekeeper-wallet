import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONTENT_SECURITY_POLICY } from "@/lib/security/headers";
import { NATIVE_WEBVIEW_ORIGIN, PROD_ORIGIN, TRUSTED_CALLER_HOSTS } from "./origins";

// Audit 2026-11-09 H1: the phone app must talk only to BeeKeeper's own server.
describe("trusted origins", () => {
  it("sends native server calls to beekeeper.money", () => {
    expect(PROD_ORIGIN).toBe("https://beekeeper.money");
  });

  it("never forwards to the old HME deployments", () => {
    const bridge = readFileSync("src/lib/native/server-fn-bridge.ts", "utf8");
    expect(bridge).not.toMatch(/const PROD_ORIGIN\s*=/);
    expect(bridge).not.toContain('"https://hme-mobile.lovable.app"');
    expect(bridge).not.toContain('"https://mobile.honest.money"');
  });

  it("lets the phone app's network calls reach beekeeper.money under the CSP", () => {
    const connect = CONTENT_SECURITY_POLICY.split(";").find((d) => d.trim().startsWith("connect-src"))!;
    expect(connect).toContain(PROD_ORIGIN);
    expect(connect).not.toContain("hme-mobile.lovable.app");
    expect(connect).not.toContain(NATIVE_WEBVIEW_ORIGIN);
  });

  it("does not trust the retired HME worker as a caller", () => {
    expect(TRUSTED_CALLER_HOSTS.has("hme-mobile.lovable.app")).toBe(false);
  });
});
