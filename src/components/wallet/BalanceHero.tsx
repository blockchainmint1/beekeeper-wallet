/**
 * BeeKeeper dashboard balance: an unframed fiat total with an expandable
 * per-wallet breakdown directly beneath it.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";

export type BreakdownRow = {
  key: string;
  label: string;
  sub?: string;
  /** Coin amount, e.g. "1.2345 BTC" */
  amountText: string;
  /** Fiat value, already formatted, or null when the price is unknown. */
  fiatText: string | null;
  loading?: boolean;
  selected?: boolean;
  onSelect: () => void;
  onDetails?: () => void;
};

export function BalanceHero({
  totalText,
  loading,
  rows,
  onRefresh,
  refreshing,
}: {
  totalText: string;
  loading?: boolean;
  rows: BreakdownRow[];
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [hidden] = useHideBalances();
  const [open, setOpen] = useState(false);

  return (
    <section className="px-4 pb-2 pt-8">
      <div>
        <div className="text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Total balance
          </p>
          <div className="mt-1.5 flex items-baseline justify-center gap-2">
            <span className="text-[2.75rem] leading-none sm:text-5xl font-semibold tabular-nums">
              {hidden ? maskAmount(totalText) : totalText}
            </span>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {rows.length} {rows.length === 1 ? "wallet" : "wallets"}
            </span>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className="inline-flex items-center gap-1 hover:text-foreground"
                aria-label="Refresh balances"
              >
                <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            )}
          </div>
        </div>

        <Button
          variant="ghost"
          className="mx-auto mt-4 w-full max-w-sm justify-between border-y border-border/60 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Hide breakdown" : "Show breakdown"}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>

        {open && (
          <ul className="mx-auto mb-2 mt-2 max-w-sm space-y-1.5">
            {rows.map((r) => (
              <li key={r.key}>
                <div
                  className={`flex items-center gap-2 rounded-md border px-3 py-2.5 transition-colors ${
                    r.selected
                      ? "border-amber-500/50 bg-amber-500/10"
                      : "border-border/60 bg-card/50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={r.onSelect}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.label}</p>
                      {r.sub && (
                        <p className="truncate text-[11px] text-muted-foreground">{r.sub}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">
                        {r.loading ? "…" : hidden ? maskAmount(r.amountText) : r.amountText}
                      </p>
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        {r.fiatText == null
                          ? "—"
                          : hidden
                            ? maskAmount(r.fiatText)
                            : r.fiatText}
                      </p>
                    </div>
                  </button>
                  {r.onDetails && (
                    <button
                      type="button"
                      onClick={r.onDetails}
                      aria-label={`${r.label} details`}
                      className="rounded-full p-1 text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
            {rows.length === 0 && (
              <li className="rounded-md border border-border/60 bg-card/50 px-3 py-4 text-center text-sm text-muted-foreground">
                No wallets yet.
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
