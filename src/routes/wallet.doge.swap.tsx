import { createFileRoute } from "@tanstack/react-router";
import { UtxoSwap } from "@/components/wallet/UtxoSwap";

export const Route = createFileRoute("/wallet/doge/swap")({
  head: () => ({
    meta: [
      { title: "Swap DOGE to stablecoins — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Swap Dogecoin for USDC or USDT natively through THORChain, signed on your device inside BeeKeeper Wallet.",
      },
      { property: "og:title", content: "Swap DOGE to stablecoins — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Native DOGE to USDC/USDT swaps with no bridge and no custodian.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => <UtxoSwap coin="doge" />,
});
