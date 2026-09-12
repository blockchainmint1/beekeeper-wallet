import { createFileRoute } from "@tanstack/react-router";
import { UtxoSwap } from "@/components/wallet/UtxoSwap";

export const Route = createFileRoute("/wallet/ltc/swap")({
  head: () => ({
    meta: [
      { title: "Swap LTC to stablecoins — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Swap Litecoin for USDC or USDT natively through THORChain, signed on your device inside BeeKeeper Wallet.",
      },
      { property: "og:title", content: "Swap LTC to stablecoins — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Native LTC to USDC/USDT swaps with no bridge and no custodian.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => <UtxoSwap coin="ltc" />,
});
