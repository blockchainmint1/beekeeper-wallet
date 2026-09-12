/**
 * One merged, time-sorted transaction list across every wallet and chain the
 * app tracks. Each row carries its own chain label so the list needs no
 * per-chain sections.
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";

export type ActivityRow = {
  id: string;
  /** Short wallet/chain label shown as a chip, e.g. "Bitcoin". */
  chainLabel: string;
  title: string;
  /** Unix ms; null when the timestamp is unknown (pending / unindexed). */
  timeMs: number | null;
  amountText: string;
  incoming: boolean;
  pending?: boolean;
  note?: string;
  /** Badge symbol shown in place of the direction arrow (tokens). */
  badge?: string;
  onOpen?: () => void;
  href?: string;
};

export function UnifiedActivity({
  rows,
  loading,
}: {
  rows: ActivityRow[];
  loading?: boolean;
}) {
  const [hidden] = useHideBalances();
  const [limit, setLimit] = useState(25);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
        return (b.timeMs ?? 0) - (a.timeMs ?? 0);
      }),
    [rows],
  );
  const visible = sorted.slice(0, limit);

  return (
    <section className="mt-6 px-4 pb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {loading ? "Loading transactions…" : "No transactions yet."}
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {visible.map((r) => {
              const inner = (
                <>
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      r.badge
                        ? "bg-amber-500/15 text-[11px] font-bold text-amber-300"
                        : r.incoming
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    {r.badge ? (
                      r.badge.slice(0, 3)
                    ) : r.incoming ? (
                      <ArrowDown className="h-4 w-4" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {r.title}
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {r.chainLabel}
                      </span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.pending ? (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <Loader2 className="h-3 w-3 animate-spin" /> Pending · unconfirmed
                        </span>
                      ) : (
                        (r.note ?? (r.timeMs ? new Date(r.timeMs).toLocaleString() : "Confirmed"))
                      )}
                    </p>
                  </div>
                  <p
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      r.incoming ? "text-emerald-400" : ""
                    }`}
                  >
                    {hidden
                      ? maskAmount(r.amountText)
                      : `${r.incoming ? "+" : "−"}${r.amountText}`}
                  </p>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </>
              );
              const cls =
                "flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-colors hover:bg-card";
              return (
                <li key={r.id}>
                  {r.href ? (
                    <a href={r.href} target="_blank" rel="noreferrer" className={cls}>
                      {inner}
                    </a>
                  ) : (
                    <button type="button" onClick={r.onOpen} className={cls}>
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {sorted.length > visible.length && (
            <Button
              variant="ghost"
              className="mt-3 w-full text-sm text-muted-foreground"
              onClick={() => setLimit((n) => n + 25)}
            >
              Show more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
