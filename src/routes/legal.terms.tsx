import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/legal/terms")({
  head: () => ({
    meta: [
      { title: "Terms — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Terms of use for the BeeKeeper Wallet. Self-custodial software provided as-is, no recovery service.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 prose prose-invert">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground no-underline">
        ← Home
      </Link>
      <h1>Terms of Use</h1>
      <p className="text-sm text-muted-foreground">Draft — last updated June 29, 2026</p>

      <h2>1. What this app is</h2>
      <p>
        BeeKeeper Wallet is open-source, self-custodial software that lets you generate, store,
        and use TEXITcoin (TXC) addresses on your own device. We do not hold your keys, your
        funds, or your personal data. We cannot freeze, refund, or reverse any transaction.
      </p>

      <h2>2. Your keys, your responsibility</h2>
      <p>
        Your 12 or 24-word seed phrase is the only way to recover your wallet. If you lose it, or
        share it with anyone, your funds are gone. Write it down on paper and store it somewhere
        only you can reach.
      </p>

      <h2>3. No warranty</h2>
      <p>
        The software is provided <em>as is</em>, without warranty of any kind. We make no
        guarantees about availability, uptime, fee accuracy, or compatibility with future
        TEXITcoin network upgrades. You use it at your own risk.
      </p>

      <h2>4. No financial advice</h2>
      <p>
        Nothing in the app is financial, legal, or tax advice. You are responsible for complying
        with the laws and reporting requirements in your jurisdiction.
      </p>

      <h2>5. Third-party services</h2>
      <p>
        The app reads chain data from public TEXITcoin nodes and may fetch price quotes from
        third-party providers. Those services have their own terms and may be unavailable at any
        time. We do not control them.
      </p>

      <h2>6. Changes</h2>
      <p>
        We may update these terms as the app evolves. Continued use after a change means you
        accept the new terms.
      </p>

      <p className="text-sm text-muted-foreground">
        Part of the{" "}
        <a href="https://honest.money" target="_blank" rel="noreferrer">
          honest.money
        </a>{" "}
        ecosystem.
      </p>
    </main>
  );
}
