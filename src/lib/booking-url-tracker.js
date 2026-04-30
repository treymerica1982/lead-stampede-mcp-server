import { nanoid } from 'nanoid';

const WORKER_BASE_URL = 'https://lead-stampede-cards.trey-1cb.workers.dev';

/**
 * Wraps a booking URL in a tracked redirect URL by generating a token
 * and persisting it to booking_url_tokens. On any failure, gracefully
 * falls back to returning the original URL so the customer experience
 * is never broken by tracking issues.
 *
 * @param {Object} params
 * @param {Object} params.client - Client record with id and agency_id
 * @param {string|null} params.originalBookingUrl - The raw booking URL from clients table
 * @param {'get_business_profile'|'get_availability'} params.toolName
 * @param {string|null} params.toolCallId - Optional FK to mcp_tool_calls.id (always null for now)
 * @param {Object} params.supabase - Supabase client instance (service role)
 * @returns {Promise<string|null>} Tracked URL, original URL on error, or null
 */
export async function wrapBookingUrl({
  client,
  originalBookingUrl,
  toolName,
  toolCallId = null,
  supabase,
}) {
  // No URL to wrap — return null
  if (!originalBookingUrl) {
    return null;
  }

  try {
    const token = nanoid(12);

    const { error } = await supabase
      .from('booking_url_tokens')
      .insert({
        token,
        client_id: client.id,
        agency_id: client.agency_id,
        target_url: originalBookingUrl,
        tool_name: toolName,
        tool_call_id: toolCallId,
        // created_at and expires_at use DB defaults
      });

    if (error) {
      console.warn(
        '[booking-url-tracker] Token insert failed, falling back to raw URL:',
        { client_id: client.id, tool: toolName, error: error.message }
      );
      return originalBookingUrl;
    }

    return `${WORKER_BASE_URL}/b/${token}`;
  } catch (err) {
    console.warn(
      '[booking-url-tracker] Token generation threw, falling back to raw URL:',
      { client_id: client.id, tool: toolName, error: err.message }
    );
    return originalBookingUrl;
  }
}
