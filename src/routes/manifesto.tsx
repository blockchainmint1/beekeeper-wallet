import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/manifesto")({
  head: () => ({
    meta: [
      { title: "Manifesto — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Why BeeKeeper Wallet exists: honest money, self custody, open code, no rent-seeking middlemen.",
      },
      { property: "og:title", content: "Manifesto — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Honest money. Self custody. Open code. No middlemen.",
      },
    ],
  }),
  component: ManifestoPage,
});

function ManifestoPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 prose prose-invert">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground no-underline">
        ← Home
      </Link>
      <h1>Manifesto</h1>
      <p className="lead">
        Money is too important to outsource. This wallet is built on a simple set of beliefs.
      </p>

      <h2>1. Your keys, your coins.</h2>
      <p>
        If someone else can move your money, it isn't yours. Every line of this app is written
        to keep the keys with the person they belong to — you. No accounts. No custodian. No
        password reset email that turns into a way for an attacker to drain you.
      </p>

      <h2>2. Honest defaults.</h2>
      <p>
        The wallet should tell you the truth about fees, confirmations, what's pending, and what
        went wrong. No dark patterns, no upsells, no fake "premium" tier hiding basic features.
      </p>

      <h2>3. Open code, public infrastructure.</h2>
      <p>
        The app talks only to public TEXITcoin infrastructure (
        <a href="https://texitcoin.org/build" target="_blank" rel="noreferrer">
          texitcoin.org/build
        </a>
        ) and to your own device. You can read the code, audit it, fork it, run it from source.
      </p>

      <h2>4. Small surface, sharp edges.</h2>
      <p>
        We ship the smallest amount of code that does the job. Every dependency is a liability.
        Every "convenience" feature that handles your seed is a future bug. We say no a lot.
      </p>

      <h2>5. Part of a bigger thing.</h2>
      <p>
        This wallet is one tool in the{" "}
        <a href="https://honest.money" target="_blank" rel="noreferrer">
          honest.money
        </a>{" "}
        ecosystem — a set of independently-built, interoperable tools for people who want money
        that works without permission.
      </p>
    </main>
  );
}
