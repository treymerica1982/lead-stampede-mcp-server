import { supabase } from './supabase.js';

/**
 * Fire-and-forget logger — writes an MCP tool call to the analytics table.
 * Failures are logged but never block the user request.
 */
export async function logToolCall({
  clientSlug,
  agencyId,
  toolName,
  responseMs,
  success,
  errorMessage,
}) {
  try {
    // Resolve client_id from slug (analytics table needs UUID)
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', clientSlug)
      .eq('agency_id', agencyId)
      .maybeSingle();

    if (!client) return; // client not found — nothing to log

    await supabase.from('mcp_tool_calls').insert({
      client_id: client.id,
      agency_id: agencyId,
      tool_name: toolName,
      response_ms: responseMs,
      success,
      error_message: errorMessage ?? null,
    });
  } catch (err) {
    console.error('[analytics] Failed to log tool call:', err.message);
  }
}
