-- Writes down the existing access rule for public.app_releases so it can be
-- checked from the repo (round-2 audit). Idempotent: matches what is live.
ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_releases' AND policyname = 'Release info is public'
  ) THEN
    CREATE POLICY "Release info is public" ON public.app_releases
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

-- Read-only for the public; only server-side admin code may change releases.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.app_releases FROM anon, authenticated;
GRANT SELECT ON public.app_releases TO anon, authenticated;
GRANT ALL ON public.app_releases TO service_role;

COMMENT ON TABLE public.app_releases IS 'Public, read-only release feed for frozen Android installs. No public write policies by design.';