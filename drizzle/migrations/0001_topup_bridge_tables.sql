-- Bridge (bridge.xyz) top-ups. Server-only: reached through the service role
-- after the wallet signs the request. No name, email or ID data is stored.
CREATE TABLE public.topup_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txc_address text NOT NULL,
  env text NOT NULL DEFAULT 'sandbox',
  base_address text,
  bridge_customer_id text,
  kyc_link_id text,
  virtual_account_id text,
  destination_rail text,
  destination_currency text,
  destination_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (txc_address, env)
);
REVOKE ALL ON public.topup_customers FROM anon, authenticated;
GRANT ALL ON public.topup_customers TO service_role;
ALTER TABLE public.topup_customers ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.topup_customers IS 'Bridge top-up references per wallet (TXC holder address). Server-only by design: no client policies.';

CREATE TABLE public.topup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_event_id text NOT NULL UNIQUE,
  event_category text,
  event_type text,
  virtual_account_id text,
  deposit_id text,
  activity_type text,
  amount text,
  developer_fee_amount text,
  destination_tx_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topup_events_va_idx ON public.topup_events (virtual_account_id);
REVOKE ALL ON public.topup_events FROM anon, authenticated;
GRANT ALL ON public.topup_events TO service_role;
ALTER TABLE public.topup_events ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.topup_events IS 'Signed Bridge webhook deliveries for top-ups. Server-only by design: no client policies.';