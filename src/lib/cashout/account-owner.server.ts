/**
 * Owner list for VectorPay customer IDs (`cashout_account_owners`). Reads and
 * claims fail closed: if the list can't be read, the caller refuses.
 */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** The wallet that owns this customer ID, or null if nobody has claimed it. Throws on read errors. */
export async function readAccountOwner(accountRef: string): Promise<string | null> {
  const { data, error } = await (await admin())
    .from("cashout_account_owners")
    .select("txc_address")
    .eq("account_ref", accountRef)
    .maybeSingle();
  if (error) throw error;
  return data?.txc_address ?? null;
}

/**
 * Claim an unowned customer ID for `address`. Only call this after VectorPay
 * has accepted a one-time link code for that ID. Returns true when `address`
 * is the owner afterwards (two wallets racing: only the row that landed wins).
 */
export async function claimAccountOwner(accountRef: string, address: string): Promise<boolean> {
  try {
    await (await admin())
      .from("cashout_account_owners")
      .upsert({ account_ref: accountRef, txc_address: address }, { onConflict: "account_ref", ignoreDuplicates: true });
    return (await readAccountOwner(accountRef)) === address;
  } catch {
    return false;
  }
}
