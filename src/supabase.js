import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. ' +
    'Copy .env.example to .env and fill in your values.'
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------
// Public client — uses the RLS-enforced publishable key.
// Used ONLY by public discovery tools. Never for agency-scoped ops.
// ---------------------------------------------------------------
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!publishableKey) {
  console.warn(
    '[supabase] SUPABASE_PUBLISHABLE_KEY not set — public discovery tools will be unavailable.'
  );
}

export const supabasePublic = publishableKey
  ? createClient(url, publishableKey, { auth: { persistSession: false } })
  : null;
