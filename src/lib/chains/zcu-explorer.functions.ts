import { createServerFn } from "@tanstack/react-start";

/**
 * Exposes the public base URL of the ZCU explorer/indexer so the client can
 * build "view on explorer" links without hardcoding a host.
 */
export const getZcuExplorerBase = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ base: string }> => {
    const { zcuIndexerBase } = await import("./zcu-explorer.server");
    return { base: zcuIndexerBase() };
  },
);
