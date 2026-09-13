import { scopedKey } from "@/lib/profiles";
/**
 * Per-chain ERC-20 token preferences: which built-in tokens to show, and any
 * user-added custom tokens. Persisted in localStorage; components subscribe
 * via `useTokensForChain`.
 *
 * Hidden tokens are removed from the dashboard token list and the Send picker
 * but remain resolvable by URI (so a scanned payment link for a hidden token
 * still routes correctly — we just don't clutter the UI with it by default).
 */
import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import type { EvmChainId } from "@/lib/chains/evm";
import {
  BUILTIN_TOKENS_BY_CHAIN,
  type Erc20TokenMeta,
} from "@/lib/chains/erc20";

const CUSTOM_KEY_BASE = "hme:tokens:custom:v1";
/** Namespaced per wallet profile (default profile keeps the original key). */
function CUSTOM_KEY(): string {
  return scopedKey(CUSTOM_KEY_BASE);
}
const HIDDEN_KEY_BASE = "hme:tokens:hidden:v1";
/** Namespaced per wallet profile (default profile keeps the original key). */
function HIDDEN_KEY(): string {
  return scopedKey(HIDDEN_KEY_BASE);
}
const EVT = "hme:tokens-changed";

type CustomMap = Partial<Record<EvmChainId, Erc20TokenMeta[]>>;
/** Set of `${chain}:${address.toLowerCase()}` entries that should NOT display. */
type HiddenSet = string[];

function readCustom(): CustomMap {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}
function writeCustom(v: CustomMap) {
  localStorage.setItem(CUSTOM_KEY(), JSON.stringify(v));
}
function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY());
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as HiddenSet;
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeHidden(s: Set<string>) {
  localStorage.setItem(HIDDEN_KEY(), JSON.stringify([...s]));
}
function emit() {
  window.dispatchEvent(new Event(EVT));
}
function keyFor(chain: EvmChainId, address: string) {
  return `${chain}:${address.toLowerCase()}`;
}

/** Full known catalog for a chain (built-ins + user customs). */
export function getKnownTokens(chain: EvmChainId): Erc20TokenMeta[] {
  const custom = readCustom()[chain] ?? [];
  return [...BUILTIN_TOKENS_BY_CHAIN[chain], ...custom];
}

/** Enabled tokens for a chain (known minus hidden). */
export function getEnabledTokens(chain: EvmChainId): Erc20TokenMeta[] {
  const hidden = readHidden();
  return getKnownTokens(chain).filter((t) => !hidden.has(keyFor(chain, t.address)));
}

export function isTokenEnabled(chain: EvmChainId, address: string): boolean {
  return !readHidden().has(keyFor(chain, address));
}

export function setTokenEnabled(chain: EvmChainId, address: string, enabled: boolean) {
  const s = readHidden();
  const k = keyFor(chain, address);
  if (enabled) s.delete(k);
  else s.add(k);
  writeHidden(s);
  emit();
}

export function addCustomToken(chain: EvmChainId, token: Erc20TokenMeta): { ok: true } | { ok: false; error: string } {
  if (!isAddress(token.address)) return { ok: false, error: "Not a valid contract address." };
  if (!token.symbol.trim()) return { ok: false, error: "Symbol is required." };
  if (!Number.isFinite(token.decimals) || token.decimals < 0 || token.decimals > 36) {
    return { ok: false, error: "Decimals must be between 0 and 36." };
  }
  const normalized: Erc20TokenMeta = {
    symbol: token.symbol.trim().toUpperCase(),
    address: token.address.toLowerCase() as Address,
    decimals: Math.floor(token.decimals),
  };
  // Reject duplicates of built-ins or existing customs (by address).
  const existing = getKnownTokens(chain).some(
    (t) => t.address.toLowerCase() === normalized.address,
  );
  if (existing) return { ok: false, error: "That token is already in the list." };

  const all = readCustom();
  const list = all[chain] ?? [];
  writeCustom({ ...all, [chain]: [...list, normalized] });
  emit();
  return { ok: true };
}

export function removeCustomToken(chain: EvmChainId, address: string) {
  const all = readCustom();
  const list = (all[chain] ?? []).filter((t) => t.address.toLowerCase() !== address.toLowerCase());
  writeCustom({ ...all, [chain]: list });
  // Also drop any hidden entry for it so it doesn't linger.
  const hidden = readHidden();
  hidden.delete(keyFor(chain, address));
  writeHidden(hidden);
  emit();
}

export function isBuiltinToken(chain: EvmChainId, address: string): boolean {
  return BUILTIN_TOKENS_BY_CHAIN[chain].some(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
}

/** Reactive: enabled tokens for a chain, updating on prefs change. */
export function useTokensForChain(chain: EvmChainId): Erc20TokenMeta[] {
  const [tokens, setTokens] = useState<Erc20TokenMeta[]>(() => getEnabledTokens(chain));
  useEffect(() => {
    // Re-read on mount AND whenever the chain changes — this component instance
    // is reused across carousel tiles, so a stale list would show (e.g.) the
    // Ethereum custom tokens while the BSC tile is active.
    setTokens(getEnabledTokens(chain));
    const h = () => setTokens(getEnabledTokens(chain));
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, [chain]);
  return tokens;
}

/** Reactive: full known list + which are enabled. For the settings screen. */
export function useAllTokensForChain(chain: EvmChainId): {
  tokens: Erc20TokenMeta[];
  enabled: (t: Erc20TokenMeta) => boolean;
  isCustom: (t: Erc20TokenMeta) => boolean;
} {
  const [snapshot, setSnapshot] = useState(() => ({
    tokens: getKnownTokens(chain),
    hidden: readHidden(),
  }));
  useEffect(() => {
    const h = () =>
      setSnapshot({ tokens: getKnownTokens(chain), hidden: readHidden() });
    h();
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, [chain]);
  return {
    tokens: snapshot.tokens,
    enabled: (t) => !snapshot.hidden.has(keyFor(chain, t.address)),
    isCustom: (t) => !isBuiltinToken(chain, t.address),
  };
}
