import { createFileRoute } from "@tanstack/react-router";
import { BeeKeeperOnboarding } from "@/components/wallet/BeeKeeperOnboarding";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Activate BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Scan your Copper Coin or enter a 12/24-word recovery phrase to activate or import a BeeKeeper Wallet.",
      },
      { property: "og:title", content: "Activate BeeKeeper Wallet" },
      {
        property: "og:description",
        content:
          "Scan your Copper Coin or enter a 12/24-word recovery phrase to activate or import a BeeKeeper Wallet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OnboardingPage,
});

function OnboardingPage() {
  return <BeeKeeperOnboarding />;
}
