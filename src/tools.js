import { supabase } from './supabase.js';

/**
 * MCP Tool Definitions
 *
 * Each tool has:
 *   - name:        unique identifier
 *   - description: shown to the calling agent
 *   - inputSchema: JSON Schema describing arguments
 *   - handler:     async function (args, context) => result
 *
 * TOOL FAMILIES:
 *   Service tools  — get_business_profile, get_services, get_availability, get_reviews
 *     Work for ALL client types.
 *   E-commerce tools — search_products, get_product_details, get_collection
 *     Only work for clients with business_type = 'ecommerce'.
 *     Return a clear error for service clients.
 */

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

// Look up a client by slug, scoped to the calling agency
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

// Assert that a client is an e-commerce client. Used by product tools.
function requireEcommerce(client) {
  if (client.business_type !== 'ecommerce') {
    throw new Error(
      `Client "${client.slug}" is a service business, not an e-commerce store. ` +
      `Use get_business_profile or get_services for this client instead.`
    );
  }
}

// Format a raw product row into the shape we return to callers.
// Keeps prices in dollars (not cents) and drops internal columns.
function formatProduct(row) {
  return {
    slug: row.slug,
    name: row.name,
    short_description: row.short_description,
    description: row.description,
    category: row.category,
    collection: row.collection,
    tags: row.tags ?? [],
    price: row.price_cents / 100,
    compare_at_price: row.compare_at_cents != null ? row.compare_at_cents / 100 : null,
    on_sale: row.compare_at_cents != null && row.compare_at_cents > row.price_cents,
    currency: row.currency ?? 'USD',
    in_stock: row.in_stock,
    available_sizes: row.available_sizes ?? [],
    available_colors: row.available_colors ?? [],
    image_url: row.image_url,
    product_url: row.product_url,
    featured: row.featured === true,
  };
}

// ---------------------------------------------------------------
// SERVICE TOOLS (existing, unchanged behavior)
// ---------------------------------------------------------------

// Tool: get_business_profile
export const getBusinessProfile = {
  name: 'get_business_profile',
  description:
    'Returns the full business profile for a Lead Stampede client: name, description, industry, service area, and contact info. Works for both service businesses and e-commerce brands. Use this when an agent needs a general overview of the business.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the client (e.g. "grandinetti-molinar-law" or "understated-leather").',
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
      business_type: client.business_type,
      service_area: client.service_area,
      contact: {
        phone: client.phone,
        email: client.email,
        website: client.website,
        shop_url: client.shop_url,
      },
    };
  },
};

// Tool: get_services
export const getServices = {
  name: 'get_services',
  description:
    'Returns the list of services offered by a Lead Stampede service-business client, along with pricing summary if available. For e-commerce clients, use search_products or get_collection instead.',
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

// Tool: get_availability
export const getAvailability = {
  name: 'get_availability',
  description:
    'Returns business hours and booking options for a Lead Stampede client. Works for all client types. If the client has a booking URL, it is returned for direct scheduling; otherwise the phone or email is returned so the caller can reach out directly.',
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
      : client.shop_url
      ? {
          method: 'online_shop',
          shop_url: client.shop_url,
          note: 'This is an online shop available 24/7. Direct users to the shop URL to browse and purchase.',
        }
      : {
          method: 'phone_or_email',
          phone: client.phone,
          email: client.email,
          note: 'This business does not offer online booking. Direct users to call or email.',
        };

    return {
      business_name: client.business_name,
      hours: client.hours ?? {},
      booking,
    };
  },
};

// Tool: get_reviews
export const getReviews = {
  name: 'get_reviews',
  description:
    'Returns social proof for a Lead Stampede client: review count, average rating, and a brief summary. Works for all client types.',
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
// E-COMMERCE TOOLS (new)
// ---------------------------------------------------------------

// Tool: search_products
// Full-text search across a client's catalog, with optional filters.
export const searchProducts = {
  name: 'search_products',
  description:
    'Searches the product catalog of an e-commerce Lead Stampede client. Supports natural-language queries (e.g. "leather jackets", "studded accessories") plus optional filters for category, price range, collection, and in-stock-only. Only works for e-commerce clients. For service businesses, use get_services instead.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the e-commerce client (e.g. "understated-leather").',
      },
      query: {
        type: 'string',
        description: 'Natural-language search terms. Example: "leather jackets", "fringe skirt", "silver jewelry". Leave blank to browse all products matching the filters.',
      },
      category: {
        type: 'string',
        description: 'Optional filter: product category (e.g. "jackets", "skirts", "accessories", "footwear").',
      },
      collection: {
        type: 'string',
        description: 'Optional filter: collection name (e.g. "Southern Sunrise SS26", "Studded Essentials").',
      },
      min_price: {
        type: 'number',
        description: 'Optional filter: minimum price in dollars.',
      },
      max_price: {
        type: 'number',
        description: 'Optional filter: maximum price in dollars.',
      },
      in_stock_only: {
        type: 'boolean',
        description: 'If true, only returns products currently in stock. Defaults to true.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of products to return (1-25). Defaults to 10.',
      },
    },
    required: ['client_slug'],
  },
  handler: async (args, { agency }) => {
    const {
      client_slug,
      query,
      category,
      collection,
      min_price,
      max_price,
      in_stock_only = true,
      limit = 10,
    } = args;

    const client = await findClient(client_slug, agency.id);
    requireEcommerce(client);

    // Clamp limit to a sane range
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));

    let q = supabase
      .from('products')
      .select('*')
      .eq('client_id', client.id)
      .eq('active', true);

    if (in_stock_only) q = q.eq('in_stock', true);
    if (category) q = q.eq('category', category);
    if (collection) q = q.eq('collection', collection);
    if (typeof min_price === 'number') q = q.gte('price_cents', Math.round(min_price * 100));
    if (typeof max_price === 'number') q = q.lte('price_cents', Math.round(max_price * 100));

    // Natural-language search across name, descriptions, category, collection, and tags.
    // We tokenize the query into words and require each word to match at least one field.
    // This is more forgiving than strict FTS and works out-of-the-box with any Postgres.
    if (query && query.trim()) {
      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        // Escape commas and wildcards that would break the .or() syntax
        const safe = token.replace(/[,()]/g, '');
        if (!safe) continue;
        q = q.or(
          `name.ilike.%${safe}%,short_description.ilike.%${safe}%,description.ilike.%${safe}%,category.ilike.%${safe}%,collection.ilike.%${safe}%`
        );
      }
    }

    // Sort: featured first, then price ascending
    q = q.order('featured', { ascending: false }).order('price_cents', { ascending: true });
    q = q.limit(safeLimit);

    const { data, error } = await q;
    if (error) throw new Error(`Database error: ${error.message}`);

    return {
      business_name: client.business_name,
      query: query ?? null,
      filters: { category, collection, min_price, max_price, in_stock_only },
      result_count: data.length,
      products: data.map(formatProduct),
    };
  },
};

// Tool: get_product_details
// Detailed info for one product by slug.
export const getProductDetails = {
  name: 'get_product_details',
  description:
    'Returns full details for a single product from an e-commerce client: name, description, price, available sizes and colors, stock status, and product page URL. Use this when the user wants specifics about a product they found in a search.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the e-commerce client.',
      },
      product_slug: {
        type: 'string',
        description: 'Slug of the product (e.g. "sunrise-fringe-jacket").',
      },
    },
    required: ['client_slug', 'product_slug'],
  },
  handler: async ({ client_slug, product_slug }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    requireEcommerce(client);

    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('client_id', client.id)
      .eq('slug', product_slug)
      .eq('active', true)
      .maybeSingle();

    if (error) throw new Error(`Database error: ${error.message}`);
    if (!data) {
      throw new Error(
        `No active product found with slug "${product_slug}" for ${client.business_name}.`
      );
    }

    return {
      business_name: client.business_name,
      product: formatProduct(data),
    };
  },
};

// Tool: get_collection
// Returns all products in a named collection.
export const getCollection = {
  name: 'get_collection',
  description:
    'Returns all products in a named collection for an e-commerce client (e.g. a seasonal drop or a permanent core range). Use this when the user wants to browse a specific collection rather than searching for keywords.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the e-commerce client.',
      },
      collection: {
        type: 'string',
        description: 'Collection name (e.g. "Southern Sunrise SS26", "Studded Essentials"). Leave blank to list all collections available.',
      },
      in_stock_only: {
        type: 'boolean',
        description: 'If true, only returns products currently in stock. Defaults to true.',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug, collection, in_stock_only = true }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    requireEcommerce(client);

    // If no collection specified, return the list of available collections.
    if (!collection || !collection.trim()) {
      const { data, error } = await supabase
        .from('products')
        .select('collection')
        .eq('client_id', client.id)
        .eq('active', true)
        .not('collection', 'is', null);

      if (error) throw new Error(`Database error: ${error.message}`);

      const collections = [...new Set(data.map((p) => p.collection))].sort();
      return {
        business_name: client.business_name,
        available_collections: collections,
        note: 'Call get_collection again with a specific collection name to see its products.',
      };
    }

    // Specific collection — return its products
    let q = supabase
      .from('products')
      .select('*')
      .eq('client_id', client.id)
      .eq('collection', collection)
      .eq('active', true);

    if (in_stock_only) q = q.eq('in_stock', true);

    q = q.order('featured', { ascending: false }).order('price_cents', { ascending: false });

    const { data, error } = await q;
    if (error) throw new Error(`Database error: ${error.message}`);

    return {
      business_name: client.business_name,
      collection,
      product_count: data.length,
      products: data.map(formatProduct),
    };
  },
};

// ---------------------------------------------------------------
// Registry — exported for the server to register all tools
// ---------------------------------------------------------------
export const allTools = [
  // Service / general tools
  getBusinessProfile,
  getServices,
  getAvailability,
  getReviews,
  // E-commerce tools
  searchProducts,
  getProductDetails,
  getCollection,
];

export const toolsByName = Object.fromEntries(
  allTools.map((t) => [t.name, t])
);
