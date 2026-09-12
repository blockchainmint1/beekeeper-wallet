import { createFileRoute, Outlet } from "@tanstack/react-router";
import { WalletShell } from "@/components/wallet/WalletShell";

export const Route = createFileRoute("/wallet")({
  head: () => ({
    meta: [
      { title: "Wallet — BeeKeeper Wallet" },
      { name: "description", content: "Manage every BeeKeeper wallet, account, token, and transaction in one place." },
      { property: "og:title", content: "Wallet — BeeKeeper Wallet" },
      { property: "og:description", content: "Manage every BeeKeeper wallet, account, token, and transaction in one place." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WalletLayout,
});

function WalletLayout() {
  return (
    <WalletShell>
      <Outlet />
    </WalletShell>
  );
}
