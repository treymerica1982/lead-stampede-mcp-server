import { supabase } from './supabase.js';

/**
 * MCP Tool Definitions
 *
 * Each tool has:
 *   - name:        unique identifier
 *   - description: shown to the calling agent
 *   - inputSchema: JSON Schema describing arguments
 *   - handler:     async function (args, context) => result
 */

// Shared helper — look up a client by slug, scoped to the calling agency
async function findClient(slug, agencyId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('slug', slug)
    .eq('agency_id', agencyId)
    .eq('active', true)
    .maybeSingle();

  if (error) throw new Error(`Database error: ${error.message}`);
  if (!data) throw new Error(`No active client found with slug "${slug}" for this agency.`);
  return data;
}

// ---------------------------------------------------------------
// Tool 1: get_business_profile
// ---------------------------------------------------------------
export const getBusinessProfile = {
  name: 'get_business_profile',
  description:
    'Returns the full business profile for a Lead Stampede client: name, description, industry, service area, and contact info. Use this when an agent needs a general overview of the business.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the client (e.g. "grandinetti-molinar-law").',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    return {
      business_name: client.business_name,
      tagline: client.tagline,
      description: client.description,
      industry: client.industry,
      service_area: client.service_area,
      contact: {
        phone: client.phone,
        email: client.email,
        website: client.website,
      },
    };
  },
};

// ---------------------------------------------------------------
// Tool 2: get_services
// ---------------------------------------------------------------
export const getServices = {
  name: 'get_services',
  description:
    'Returns the list of services offered by a Lead Stampede client, along with a pricing summary if available. Use this when a user is shopping for a specific service or wants to know pricing.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the client.',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    return {
      business_name: client.business_name,
      services: client.services ?? [],
      pricing_summary: client.pricing_summary,
    };
  },
};

// ---------------------------------------------------------------
// Tool 3: get_availability
// ---------------------------------------------------------------
export const getAvailability = {
  name: 'get_availability',
  description:
    'Returns business hours and booking options for a Lead Stampede client. If the client has a booking URL (e.g. Calendly), it is returned for direct scheduling. Otherwise, the phone number is returned so the caller can reach out directly.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the client.',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug }, { agency }) => {
    const client = await findClient(client_slug, agency.id);

    const booking = client.booking_url
      ? {
          method: 'online_booking',
          booking_url: client.booking_url,
          note: 'This business offers online scheduling. Direct users to the booking URL.',
        }
      : {
          method: 'phone_or_email',
          phone: client.phone,
          email: client.email,
          note: 'This business does not offer online booking yet. Direct users to call or email.',
        };

    return {
      business_name: client.business_name,
      hours: client.hours ?? {},
      booking,
    };
  },
};

// ---------------------------------------------------------------
// Tool 4: get_reviews
// ---------------------------------------------------------------
export const getReviews = {
  name: 'get_reviews',
  description:
    'Returns social proof for a Lead Stampede client: review count, average rating, and a brief summary. Use this when a user is comparing options or evaluating credibility.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the client.',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    return {
      business_name: client.business_name,
      review_summary: client.review_summary,
      review_count: client.review_count ?? 0,
      average_rating: client.average_rating,
    };
  },
};

// ---------------------------------------------------------------
// Registry — exported for the server to register all tools
// ---------------------------------------------------------------
export const allTools = [
  getBusinessProfile,
  getServices,
  getAvailability,
  getReviews,
];

export const toolsByName = Object.fromEntries(
  allTools.map((t) => [t.name, t])
);
