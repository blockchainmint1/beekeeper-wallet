CREATE TABLE public.cashout_account_owners (
  account_ref text PRIMARY KEY,
  txc_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.cashout_account_owners FROM anon, authenticated;
GRANT ALL ON public.cashout_account_owners TO service_role;
ALTER TABLE public.cashout_account_owners ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.cashout_account_owners IS 'Which wallet (TXC holder address) owns each VectorPay customer ID; first signed link or lookup claims it. Server-only by design: no client policies.';

COMMENT ON COLUMN public.topup_events.payload IS 'DEPRECATED: no longer written (round-4 audit B3: raw Bridge events can carry sender bank details). Only the extracted columns are stored.';
UPDATE public.topup_events SET payload = '{}'::jsonb WHERE payload <> '{}'::jsonb;