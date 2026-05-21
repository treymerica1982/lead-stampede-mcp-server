import { supabasePublic } from './supabase.js';

/**
 * Public Discovery Tools
 *
 * Unauthenticated, read-only tools for external AI agents to discover
 * Lead Stampede's public clients. No API key required.
 *
 * Safety properties:
 *   1. Uses supabasePublic (RLS-enforced publishable key) — NEVER supabase/service-role.
 *   2. Explicit 21-column allow-list on every query — no SELECT *.
 *   3. Every query filters active=true AND demo_only=false at the app level.
 *   4. Read-only — no writes, ever.
 */

// ---------------------------------------------------------------
// Column allow-list — the ONLY columns public tools may return.
// 21 public columns. 9 private columns are NEVER selected.
// ---------------------------------------------------------------
const PUBLIC_COLUMNS = [
  'slug',
  'business_name',
  'tagline',
  'description',
  'industry',
  'services',
  'pricing_summary',
  'service_area',
  'phone',
  'email',
  'website',
  'booking_url',
  'hours',
  'review_summary',
  'review_count',
  'average_rating',
  'business_type',
  'currency',
  'shipping_policy',
  'return_policy',
  'shop_url',
].join(',');

// ---------------------------------------------------------------
// Shared: base query with safety filters baked in
// ---------------------------------------------------------------
function publicClientsQuery() {
  if (!supabasePublic) {
    throw new Error('Public discovery tools are unavailable (SUPABASE_PUBLISHABLE_KEY not configured).');
  }
  return supabasePublic
    .from('clients')
    .select(PUBLIC_COLUMNS)
    .eq('active', true)
    .eq('demo_only', false);
}

// ---------------------------------------------------------------
// Tool: search_clients
// ---------------------------------------------------------------
export const searchClients = {
  name: 'search_clients',
  description:
    'Search Lead Stampede\'s public client directory. Returns matching businesses with contact info, services, and ratings. Supports filtering by city, business type, and free-text query across name, description, and industry.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text search across business name, description, and industry.',
      },
      city: {
        type: 'string',
        description: 'Filter by city name within the client\'s service area.',
      },
      business_type: {
        type: 'string',
        description: 'Filter by business type (e.g. "service", "ecommerce", "automotive").',
      },
    },
  },
  handler: async ({ query, city, business_type }) => {
    let q = publicClientsQuery();

    if (business_type) {
      q = q.eq('business_type', business_type);
    }

    if (city && city.trim()) {
      // service_area is JSONB: { city, state, regions: [...] }
      // ->> returns text (unquoted), so ilike works for case-insensitive partial match.
      // Also check if the city appears in the regions array.
      q = q.or(
        `service_area->>city.ilike.%${city.trim()}%,service_area->regions.cs.["${city.trim()}"]`
      );
    }

    if (query && query.trim()) {
      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const safe = token.replace(/[,()]/g, '');
        if (!safe) continue;
        q = q.or(
          `business_name.ilike.%${safe}%,description.ilike.%${safe}%,industry.ilike.%${safe}%`
        );
      }
    }

    q = q.order('business_name', { ascending: true }).limit(50);

    const { data, error } = await q;
    if (error) throw new Error(`Database error: ${error.message}`);

    return {
      result_count: data.length,
      clients: data,
    };
  },
};

// ---------------------------------------------------------------
// Tool: get_client
// ---------------------------------------------------------------
export const getClient = {
  name: 'get_client',
  description:
    'Returns the full public Agent Card for a single Lead Stampede client by slug. Includes business details, contact info, services, hours, reviews, and booking URL.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'The unique slug of the client (e.g. "lead-stampede").',
      },
    },
    required: ['slug'],
  },
  handler: async ({ slug }) => {
    const { data, error } = await publicClientsQuery()
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw new Error(`Database error: ${error.message}`);
    if (!data) {
      throw new Error(`No public client found with slug "${slug}".`);
    }

    return { client: data };
  },
};

// ---------------------------------------------------------------
// Tool: list_business_types
// ---------------------------------------------------------------
export const listBusinessTypes = {
  name: 'list_business_types',
  description:
    'Returns the distinct business types available in the Lead Stampede public client directory.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    if (!supabasePublic) {
      throw new Error('Public discovery tools are unavailable (SUPABASE_PUBLISHABLE_KEY not configured).');
    }
    const { data, error } = await supabasePublic
      .from('clients')
      .select('business_type')
      .eq('active', true)
      .eq('demo_only', false)
      .not('business_type', 'is', null);

    if (error) throw new Error(`Database error: ${error.message}`);

    const types = [...new Set(data.map((r) => r.business_type))].sort();
    return { business_types: types };
  },
};

// ---------------------------------------------------------------
// Tool: list_cities
// ---------------------------------------------------------------
export const listCities = {
  name: 'list_cities',
  description:
    'Returns the distinct cities served by public Lead Stampede clients. Useful for discovering which locations have businesses in the directory.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    if (!supabasePublic) {
      throw new Error('Public discovery tools are unavailable (SUPABASE_PUBLISHABLE_KEY not configured).');
    }
    const { data, error } = await supabasePublic
      .from('clients')
      .select('service_area')
      .eq('active', true)
      .eq('demo_only', false)
      .not('service_area', 'is', null);

    if (error) throw new Error(`Database error: ${error.message}`);

    // service_area is JSONB: { city, state, regions: [...] }
    // Collect city from the top-level .city field and all entries in .regions.
    const cities = new Set();
    for (const row of data) {
      const area = row.service_area;
      if (area.city) cities.add(area.city);
      if (Array.isArray(area.regions)) {
        for (const region of area.regions) {
          cities.add(region);
        }
      }
    }

    return { cities: [...cities].sort() };
  },
};

// ---------------------------------------------------------------
// Registry
// ---------------------------------------------------------------
export const publicTools = [searchClients, getClient, listBusinessTypes, listCities];

export const publicToolsByName = Object.fromEntries(
  publicTools.map((t) => [t.name, t])
);
