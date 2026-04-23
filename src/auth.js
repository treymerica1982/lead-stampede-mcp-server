import { supabase } from './supabase.js';

/**
 * Validates the X-Agency-API-Key header against the agencies table.
 * On success, attaches the agency record to req.agency.
 * On failure, returns 401.
 */
export async function requireAgencyAuth(req, res, next) {
  const apiKey = req.headers['x-agency-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'Request must include an X-Agency-API-Key header.',
    });
  }

  const { data, error } = await supabase
    .from('agencies')
    .select('id, name, slug, active')
    .eq('api_key', apiKey)
    .maybeSingle();

  if (error) {
    console.error('[auth] Supabase error:', error.message);
    return res.status(500).json({ error: 'auth_lookup_failed' });
  }

  if (!data) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'The provided API key does not match any agency.',
    });
  }

  if (!data.active) {
    return res.status(403).json({
      error: 'agency_inactive',
      message: 'This agency account is not active.',
    });
  }

  req.agency = data;
  next();
}
