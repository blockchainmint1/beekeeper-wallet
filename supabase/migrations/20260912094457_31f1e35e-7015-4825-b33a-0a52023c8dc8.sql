CREATE TABLE public.cashout_order_status (
  reference TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  payout_usd NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.cashout_order_status TO service_role;

ALTER TABLE public.cashout_order_status ENABLE ROW LEVEL SECURITY;