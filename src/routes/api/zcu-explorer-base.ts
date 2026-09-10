import { createFileRoute } from "@tanstack/react-router";

/**
 * Public base URL of the ZCU explorer/indexer, so the client can build
 * "view on explorer" links without hardcoding a host.
 */
export const Route = createFileRoute("/api/zcu-explorer-base")({
  server: {
    handlers: {
      GET: async () => {
        const { zcuIndexerBase } = await import("@/lib/chains/zcu-explorer.server");
        return Response.json({ base: zcuIndexerBase() });
      },
    },
  },
});
