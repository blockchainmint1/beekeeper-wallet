import { createFileRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WebsiteSignInCard } from "@/components/wallet/WebsiteSignInCard";
import { looksLikeLoginQr } from "@/lib/nectar/auth";

interface SignInSearch {
  payload?: string;
}

export const Route = createFileRoute("/wallet/signin")({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    payload: typeof search.payload === "string" ? search.payload : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in to a website — Honest Money" },
      {
        name: "description",
        content:
          "Scan a sign-in QR from a partner site like NectarPay or streamTXC and approve it with your TEXITcoin wallet. No payment is authorized.",
      },
      { property: "og:title", content: "Sign in to a website — Honest Money" },
      {
        property: "og:description",
        content: "Wallet sign-in for partner sites — scan a QR, approve with your TXC key, no payment authorized.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WalletSignInPage,
});

function WalletSignInPage() {
  const { payload } = Route.useSearch();
  const initialPayload = payload && looksLikeLoginQr(payload) ? payload : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" /> Sign in to a website
          </CardTitle>
          <CardDescription>
            Scan a sign-in QR from a partner site like NectarPay or streamTXC. We sign you in with your
            TEXITcoin wallet — no payment is authorized, and only your address and signature leave the
            device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebsiteSignInCard initialPayload={initialPayload} />
        </CardContent>
      </Card>
    </div>
  );
}
