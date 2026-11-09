import { describe, expect, it } from "vitest";

import { joinUnderBase, safeProxyPath } from "./proxy-path";

describe("proxy path guard", () => {
  it("passes normal explorer paths through", () => {
    expect(safeProxyPath("address/bc1qxyz")).toBe("address/bc1qxyz");
    expect(safeProxyPath("/v1/accounts/TV6Mu/transactions")).toBe("v1/accounts/TV6Mu/transactions");
  });

  it("blocks dot-dot traversal out of an allowed prefix", () => {
    expect(safeProxyPath("address/../../../v2/other")).toBeNull();
    expect(safeProxyPath("v1/accounts/./x")).toBeNull();
  });

  it("blocks encoded dots, slashes and backslashes", () => {
    expect(safeProxyPath("address/%2e%2e/admin")).toBeNull();
    expect(safeProxyPath("address/..%2Fadmin")).toBeNull();
    expect(safeProxyPath("address\\..\\admin")).toBeNull();
  });

  it("keeps the final URL under the upstream base", () => {
    expect(joinUnderBase("https://btcbook.nownodes.io/api/v2", "address/abc", "?details=txs")).toBe(
      "https://btcbook.nownodes.io/api/v2/address/abc?details=txs",
    );
    expect(joinUnderBase("https://btcbook.nownodes.io/api/v2", "../../evil", "")).toBeNull();
  });
});
