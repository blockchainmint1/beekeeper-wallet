/**
 * Ecosystem link registry — one list of every app this wallet has linked to
 * (NectarPay, TSD Swap, streamTXC, Bonfire, …).
 *
 * NectarPay and TSD keep their own storage (other code reads it, e.g. the
 * cash-out fee check); everything else lands in a generic per-device list.
 */
import { listLinks, removeLink } from "@/lib/nectar/link";
import { listTsdLinks, removeTsdLink } from "@/lib/rewards/tsd-link";
import { clearVectorPayLink } from "@/lib/vectorpay-link";

const KEY = "beekeeper.ecosystem.links.v1";

export interface EcosystemLink {
  id: string;
  app: string;
  detail?: string;
  linkedAt: string;
}

function readGeneric(): EcosystemLink[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeGeneric(list: EcosystemLink[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function recordEcosystemLink(link: Omit<EcosystemLink, "linkedAt">) {
  const list = readGeneric().filter((l) => l.id !== link.id);
  list.unshift({ ...link, linkedAt: new Date().toISOString() });
  writeGeneric(list);
}

export function listEcosystemLinks(): EcosystemLink[] {
  const nectar = listLinks().map((l) => ({
    id: `nectar:${l.merchantId}`,
    app: "NectarPay",
    detail: l.merchantName,
    linkedAt: l.linkedAt,
  }));
  const tsd = listTsdLinks().map((l) => ({
    id: `tsd:${l.accountId}`,
    app: "TSD Swap",
    detail: l.accountName,
    linkedAt: l.linkedAt,
  }));
  return [...nectar, ...tsd, ...readGeneric()].sort((a, b) =>
    b.linkedAt.localeCompare(a.linkedAt),
  );
}

/** Forget a link on this device only. */
export function removeEcosystemLink(id: string) {
  if (id.startsWith("nectar:")) return removeLink(id.slice(7));
  if (id.startsWith("tsd:")) return removeTsdLink(id.slice(4));
  if (id === "vectorpay") clearVectorPayLink();
  writeGeneric(readGeneric().filter((l) => l.id !== id));
}
