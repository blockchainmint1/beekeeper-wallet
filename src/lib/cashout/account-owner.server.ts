import { ownerDecision } from "./account-owner";

/**
 * Check (and on first use, claim) the wallet that owns a VectorPay customer
 * ID. Returns true when `address` may see this customer's bank details.
 * Fails closed: if the owner list can't be read, the lookup is refused.
 */
export async function ownsAccount(accountRef: string, address: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const read = async () => {
    const { data, error } = await supabaseAdmin
      .from("cashout_account_owners")
      .select("txc_address")
      .eq("account_ref", accountRef)
      .maybeSingle();
    if (error) throw error;
    return data?.txc_address ?? null;
  };
  try {
    const decision = ownerDecision(await read(), address);
    if (decision !== "claim") return decision === "ok";
    await supabaseAdmin
      .from("cashout_account_owners")
      .upsert({ account_ref: accountRef, txc_address: address }, { onConflict: "account_ref", ignoreDuplicates: true });
    // Re-read: if two wallets raced, only the row that landed wins.
    return ownerDecision(await read(), address) === "ok";
  } catch {
    return false;
  }
}
