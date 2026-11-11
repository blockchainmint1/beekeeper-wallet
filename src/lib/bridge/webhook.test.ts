import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { parseSignatureHeader, verifyBridgeWebhook } from "./webhook";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Bridge signs SHA256(SHA256("<t>.<body>")) with RSA PKCS#1 v1.5. */
function bridgeHeader(body: string, t = Date.now()) {
  const digest = createHash("sha256").update(`${t}.${body}`).digest();
  const sig = sign("sha256", digest, privateKey).toString("base64");
  return `t=${t},v0=${sig}`;
}

const body = JSON.stringify({ event_id: "wh_1", event_type: "virtual_account.activity.created" });

describe("Bridge webhook signature", () => {
  it("a genuine, fresh delivery is accepted", async () => {
    expect(await verifyBridgeWebhook({ publicKeyPem: pem, header: bridgeHeader(body), rawBody: body })).toBeNull();
  });
  it("a changed body is refused", async () => {
    expect(await verifyBridgeWebhook({ publicKeyPem: pem, header: bridgeHeader(body), rawBody: body + " " })).toBe("bad signature");
  });
  it("a delivery older than 10 minutes is refused", async () => {
    const h = bridgeHeader(body, Date.now() - 11 * 60_000);
    expect(await verifyBridgeWebhook({ publicKeyPem: pem, header: h, rawBody: body })).toBe("stale delivery");
  });
  it("no header, no entry", async () => {
    expect(await verifyBridgeWebhook({ publicKeyPem: pem, header: null, rawBody: body })).toBe("missing signature");
    expect(parseSignatureHeader("t=abc,v0=")).toBeNull();
  });
});
