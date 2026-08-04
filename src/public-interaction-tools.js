import { supabasePublic, supabase } from './supabase.js';
import { wrapBookingUrl } from './lib/booking-url-tracker.js';

/**
 * Public Interaction Tools
 *
 * Keyless, rate-limited tools that let external AI agents transact with
 * Lead Stampede clients. Reads use supabasePublic (RLS-enforced);
 * server-internal side-effects (booking-url tracking, analytics) use
 * the service-role client per Locked Decision 6.
 *
 * Safety properties (same as public-tools.js):
 *   1. Reads use supabasePublic — NEVER supabase/service-role for client data.
 *   2. Explicit column allow-lists — no SELECT *.
 *   3. Every client lookup filters active=true AND demo_only=false.
 *   4. Business-type gating preserved (automotive / ecommerce).
 */

// ---------------------------------------------------------------
// Column allow-lists — ONLY these columns are selected/returned.
// ---------------------------------------------------------------
const VEHICLE_COLUMNS = [
  'vin', 'stock_number', 'stock_type', 'year', 'make', 'model', 'trim',
  'body_type', 'fuel_type', 'drivetrain', 'transmission', 'engine',
  'exterior_color', 'interior_color', 'mileage', 'mpg_city', 'mpg_highway',
  'range_miles', 'msrp_cents', 'price_cents', 'features', 'image_url',
  'listing_url', 'available', 'featured', 'client_id',
].join(',');

const PRODUCT_COLUMNS = [
  'slug', 'name', 'short_description', 'description', 'category',
  'collection', 'tags', 'price_cents', 'compare_at_cents', 'currency',
  'in_stock', 'available_sizes', 'available_colors', 'image_url',
  'product_url', 'featured', 'active', 'client_id',
].join(',');

// Client columns needed for public interaction (superset of profile fields
// used by get_availability / get_reviews, plus business_type for gating).
const CLIENT_COLUMNS = [
  'slug', 'business_name', 'tagline', 'description', 'industry',
  'services', 'pricing_summary', 'service_area', 'phone', 'email',
  'website', 'booking_url', 'hours', 'review_summary', 'review_count',
  'average_rating', 'business_type', 'currency', 'shipping_policy',
  'return_policy', 'shop_url',
].join(',');

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

/** Public client lookup — global by slug, active + non-demo only. */
function publicClientQuery() {
  if (!supabasePublic) {
    throw new Error('Public tools are unavailable (SUPABASE_PUBLISHABLE_KEY not configured).');
  }
  return supabasePublic
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('active', true)
    .eq('demo_only', false);
}

async function findPublicClient(slug) {
  const { data, error } = await publicClientQuery()
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`Database error: ${error.message}`);
  if (!data) throw new Error(`No public client found with slug "${slug}".`);
  return data;
}

function requireAutomotive(client) {
  if (client.business_type !== 'automotive') {
    throw new Error(
      `This tool is only available for automotive clients. ` +
      `Client "${client.slug}" has business_type="${client.business_type}". ` +
      `Use the appropriate ${client.business_type} tools instead.`
    );
  }
}

function requireEcommerce(client) {
  if (client.business_type !== 'ecommerce') {
    throw new Error(
      `This tool is only available for e-commerce clients. ` +
      `Client "${client.slug}" has business_type="${client.business_type}". ` +
      `Use the appropriate ${client.business_type} tools instead.`
    );
  }
}

/** Format an inventory_vehicles row into the public response shape. */
function formatVehicle(v) {
  return {
    vin: v.vin,
    stock_number: v.stock_number,
    stock_type: v.stock_type,
    year: v.year,
    make: v.make,
    model: v.model,
    trim: v.trim,
    body_type: v.body_type,
    fuel_type: v.fuel_type,
    drivetrain: v.drivetrain,
    transmission: v.transmission,
    engine: v.engine,
    exterior_color: v.exterior_color,
    interior_color: v.interior_color,
    mileage: v.mileage,
    mpg_city: v.mpg_city,
    mpg_highway: v.mpg_highway,
    range_miles: v.range_miles,
    msrp: v.msrp_cents != null ? v.msrp_cents / 100 : null,
    price: v.price_cents / 100,
    features: v.features ?? [],
    image_url: v.image_url,
    listing_url: v.listing_url,
    available: v.available,
    featured: v.featured,
  };
}

/** Format a products row into the public response shape. */
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

/**
 * Resolve client_id (UUID) from slug for vehicle/product queries.
 * Uses supabasePublic to look up the client, then uses the slug to
 * filter inventory_vehicles/products by client_id.
 */
async function resolveClientId(slug) {
  if (!supabasePublic) {
    throw new Error('Public tools are unavailable (SUPABASE_PUBLISHABLE_KEY not configured).');
  }
  // We need the client_id (UUID) to join inventory_vehicles/products.
  // The publishable key can't read the `id` column on clients (it's not
  // in the allow-list). Use service-role for this internal resolution —
  // it's a fixed-shape lookup, not caller-controlled (LD6).
  const { data, error } = await supabase
    .from('clients')
    .select('id, agency_id')
    .eq('slug', slug)
    .eq('active', true)
    .eq('demo_only', false)
    .maybeSingle();
  if (error) throw new Error(`Database error: ${error.message}`);
  if (!data) throw new Error(`No public client found with slug "${slug}".`);
  return data;
}

// ---------------------------------------------------------------
// Public analytics — fire-and-forget (LD6 + LD7 + LD8)
// ---------------------------------------------------------------

/**
 * Log a public tool call to mcp_tool_calls with source='public_mcp'.
 * Resolves client_id and agency_id from slug via service-role (LD6).
 */
export function logPublicToolCall({ clientSlug, toolName, responseMs, success, errorMessage }) {
  // Fire-and-forget — don't block the response
  (async () => {
    try {
      const { data: client } = await supabase
        .from('clients')
        .select('id, agency_id')
        .eq('slug', clientSlug)
        .eq('active', true)
        .eq('demo_only', false)
        .maybeSingle();

      if (!client) return;

      await supabase.from('mcp_tool_calls').insert({
        client_id: client.id,
        agency_id: client.agency_id,
        tool_name: toolName,
        response_ms: responseMs,
        success,
        error_message: errorMessage ?? null,
        source: 'public_mcp',
      });
    } catch (err) {
      console.error('[public-analytics] Failed to log tool call:', err.message);
    }
  })();
}

// ---------------------------------------------------------------
// Tool: get_availability (all client types)
// ---------------------------------------------------------------
export const getAvailability = {
  name: 'get_availability',
  description:
    'Returns business hours and booking options for a Lead Stampede client. If the business has online scheduling, returns a tracked booking URL; otherwise returns phone/email. Works for all client types (service, automotive, ecommerce).',
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
  handler: async ({ client_slug }) => {
    const client = await findPublicClient(client_slug);

    // Resolve full client record (with id/agency_id) for booking-url tracking (LD6)
    const clientIds = await resolveClientId(client_slug);

    const trackedBookingUrl = await wrapBookingUrl({
      client: { id: clientIds.id, agency_id: clientIds.agency_id },
      originalBookingUrl: client.booking_url,
      toolName: 'get_availability',
      toolCallId: null,
      supabase,
    });

    const booking = trackedBookingUrl
      ? {
          method: 'online_booking',
          booking_url: trackedBookingUrl,
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

// ---------------------------------------------------------------
// Tool: get_reviews (all client types)
// ---------------------------------------------------------------
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
  handler: async ({ client_slug }) => {
    const client = await findPublicClient(client_slug);
    return {
      business_name: client.business_name,
      review_summary: client.review_summary,
      review_count: client.review_count ?? 0,
      average_rating: client.average_rating,
    };
  },
};

// ---------------------------------------------------------------
// Tool: search_inventory (automotive only)
// ---------------------------------------------------------------
export const searchInventory = {
  name: 'search_inventory',
  description:
    'Searches a dealership\'s vehicle inventory. Filters by stock type (new/used/certified), make, model, year range, price range, body type, and fuel type. Optional natural-language query for full-text search. Returns up to 25 matching vehicles. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the dealership (e.g. "onion-creek-vw").',
      },
      query: {
        type: 'string',
        description: 'Optional natural-language search (e.g. "red SUV", "electric Volkswagen").',
      },
      stock_type: {
        type: 'string',
        enum: ['new', 'used', 'certified', 'any'],
        description: 'Filter by stock type. Defaults to "any".',
      },
      make: { type: 'string', description: 'Vehicle make (e.g. "Volkswagen").' },
      model: { type: 'string', description: 'Vehicle model (e.g. "Tiguan").' },
      year_min: { type: 'integer' },
      year_max: { type: 'integer' },
      price_min: { type: 'number', description: 'Minimum price in dollars.' },
      price_max: { type: 'number', description: 'Maximum price in dollars.' },
      body_type: {
        type: 'string',
        enum: ['SUV', 'Sedan', 'Hatchback', 'Bus', 'Truck', 'Coupe', 'Wagon'],
      },
      fuel_type: {
        type: 'string',
        enum: ['gas', 'electric', 'hybrid', 'diesel', 'phev'],
      },
      featured_only: { type: 'boolean', description: 'If true, only return featured vehicles.' },
      limit: { type: 'integer', description: 'Max results (1-25, default 10).' },
    },
    required: ['client_slug'],
  },
  handler: async (args) => {
    const {
      client_slug,
      query,
      stock_type = 'any',
      make, model, year_min, year_max, price_min, price_max,
      body_type, fuel_type, featured_only = false,
      limit = 10,
    } = args;

    const client = await findPublicClient(client_slug);
    requireAutomotive(client);

    const { id: clientId } = await resolveClientId(client_slug);
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));

    let q = supabasePublic
      .from('inventory_vehicles')
      .select(VEHICLE_COLUMNS)
      .eq('client_id', clientId)
      .eq('active', true)
      .eq('available', true);

    if (stock_type && stock_type !== 'any') q = q.eq('stock_type', stock_type);
    if (make) q = q.ilike('make', make);
    if (model) q = q.ilike('model', model);
    if (typeof year_min === 'number') q = q.gte('year', year_min);
    if (typeof year_max === 'number') q = q.lte('year', year_max);
    if (typeof price_min === 'number') q = q.gte('price_cents', Math.round(price_min * 100));
    if (typeof price_max === 'number') q = q.lte('price_cents', Math.round(price_max * 100));
    if (body_type) q = q.eq('body_type', body_type);
    if (fuel_type) q = q.eq('fuel_type', fuel_type);
    if (featured_only) q = q.eq('featured', true);

    // Natural-language search: multi-token ILIKE across key columns.
    // Public path uses ILIKE (not FTS) — avoids dependency on the fts tsvector column
    // which is excluded from the public allow-list.
    if (query && query.trim()) {
      const tokens = query.trim().split(/\s+/).map(t => t.replace(/[(),]/g, '')).filter(Boolean);
      for (const token of tokens) {
        q = q.or(
          `make.ilike.%${token}%,model.ilike.%${token}%,trim.ilike.%${token}%,exterior_color.ilike.%${token}%,body_type.ilike.%${token}%,fuel_type.ilike.%${token}%`
        );
      }
    }

    q = q.order('featured', { ascending: false })
         .order('year', { ascending: false })
         .order('price_cents', { ascending: true })
         .limit(safeLimit);

    const { data, error } = await q;
    if (error) throw new Error(`Database error: ${error.message}`);

    return {
      business_name: client.business_name,
      query: query ?? null,
      filters: { stock_type, make, model, year_min, year_max, price_min, price_max, body_type, fuel_type, featured_only },
      result_count: data.length,
      vehicles: data.map(formatVehicle),
    };
  },
};

// ---------------------------------------------------------------
// Tool: get_vehicle_details (automotive only)
// ---------------------------------------------------------------
export const getVehicleDetails = {
  name: 'get_vehicle_details',
  description:
    'Returns full details for a specific vehicle by VIN or stock number. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string' },
      vin: { type: 'string', description: '17-character VIN.' },
      stock_number: { type: 'string', description: 'Dealer stock number.' },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug, vin, stock_number }) => {
    if (!vin && !stock_number) {
      throw new Error('Provide either vin or stock_number.');
    }

    const client = await findPublicClient(client_slug);
    requireAutomotive(client);

    const { id: clientId } = await resolveClientId(client_slug);

    let q = supabasePublic
      .from('inventory_vehicles')
      .select(VEHICLE_COLUMNS)
      .eq('client_id', clientId)
      .eq('active', true);

    if (vin) q = q.eq('vin', vin);
    else q = q.eq('stock_number', stock_number);

    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`Database error: ${error.message}`);
    if (!data) {
      throw new Error(
        `No vehicle found with ${vin ? `VIN "${vin}"` : `stock number "${stock_number}"`} in ${client.business_name}'s inventory.`
      );
    }

    return {
      business_name: client.business_name,
      vehicle: formatVehicle(data),
    };
  },
};

// ---------------------------------------------------------------
// Tool: get_specials (automotive only)
// ---------------------------------------------------------------
export const getSpecials = {
  name: 'get_specials',
  description:
    'Returns the dealership\'s current specials and offers — new-vehicle APR/lease specials, pre-owned specials, service & parts coupons, manufacturer rebates, and incentive programs. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string' },
      category: {
        type: 'string',
        enum: ['new', 'used', 'service', 'parts', 'rebates', 'all'],
        description: 'Filter by category. Defaults to "all".',
      },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug, category = 'all' }) => {
    const client = await findPublicClient(client_slug);
    requireAutomotive(client);

    const categories = [
      { category: 'new', title: 'New Vehicle Specials', summary: 'APR offers, lease deals, and price reductions on new vehicles.' },
      { category: 'used', title: 'Pre-Owned Specials', summary: 'Pre-owned vehicles with reduced pricing.' },
      { category: 'service', title: 'Service & Parts Specials', summary: 'Coupons and discounts on routine maintenance, parts, and service work.' },
      { category: 'rebates', title: 'Manufacturer Rebates & Incentives', summary: 'Factory rebates, college graduate, military, and partner incentive programs.' },
    ];

    const filtered = category === 'all' ? categories : categories.filter(s => s.category === category);

    return {
      business_name: client.business_name,
      website: client.website,
      category,
      result_count: filtered.length,
      specials: filtered,
      note: 'Current specials are listed on the dealership\'s website. Visit the link for the latest offers, exclusions, and details.',
    };
  },
};

// ---------------------------------------------------------------
// Tool: search_products (ecommerce only)
// ---------------------------------------------------------------
export const searchProducts = {
  name: 'search_products',
  description:
    'Searches the product catalog of an e-commerce client. Supports natural-language queries plus optional filters for category, price range, collection, and stock status. Only works for e-commerce clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the e-commerce client (e.g. "understated-leather").',
      },
      query: { type: 'string', description: 'Natural-language search terms.' },
      category: { type: 'string', description: 'Product category filter.' },
      collection: { type: 'string', description: 'Collection name filter.' },
      min_price: { type: 'number', description: 'Minimum price in dollars.' },
      max_price: { type: 'number', description: 'Maximum price in dollars.' },
      in_stock_only: { type: 'boolean', description: 'If true, only in-stock products. Defaults to true.' },
      limit: { type: 'integer', description: 'Max results (1-25, default 10).' },
    },
    required: ['client_slug'],
  },
  handler: async (args) => {
    const {
      client_slug, query, category, collection,
      min_price, max_price, in_stock_only = true, limit = 10,
    } = args;

    const client = await findPublicClient(client_slug);
    requireEcommerce(client);

    const { id: clientId } = await resolveClientId(client_slug);
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));

    let q = supabasePublic
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('client_id', clientId)
      .eq('active', true);

    if (in_stock_only) q = q.eq('in_stock', true);
    if (category) q = q.eq('category', category);
    if (collection) q = q.eq('collection', collection);
    if (typeof min_price === 'number') q = q.gte('price_cents', Math.round(min_price * 100));
    if (typeof max_price === 'number') q = q.lte('price_cents', Math.round(max_price * 100));

    if (query && query.trim()) {
      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const safe = token.replace(/[,()]/g, '');
        if (!safe) continue;
        q = q.or(
          `name.ilike.%${safe}%,short_description.ilike.%${safe}%,description.ilike.%${safe}%,category.ilike.%${safe}%,collection.ilike.%${safe}%`
        );
      }
    }

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

// ---------------------------------------------------------------
// Tool: get_product_details (ecommerce only)
// ---------------------------------------------------------------
export const getProductDetails = {
  name: 'get_product_details',
  description:
    'Returns full details for a single product by slug: name, description, price, sizes, colors, stock status, and product page URL. Only for e-commerce clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string', description: 'Unique slug identifying the e-commerce client.' },
      product_slug: { type: 'string', description: 'Slug of the product (e.g. "sunrise-fringe-jacket").' },
    },
    required: ['client_slug', 'product_slug'],
  },
  handler: async ({ client_slug, product_slug }) => {
    const client = await findPublicClient(client_slug);
    requireEcommerce(client);

    const { id: clientId } = await resolveClientId(client_slug);

    const { data, error } = await supabasePublic
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('client_id', clientId)
      .eq('slug', product_slug)
      .eq('active', true)
      .maybeSingle();

    if (error) throw new Error(`Database error: ${error.message}`);
    if (!data) {
      throw new Error(`No active product found with slug "${product_slug}" for ${client.business_name}.`);
    }

    return {
      business_name: client.business_name,
      product: formatProduct(data),
    };
  },
};

// ---------------------------------------------------------------
// Tool: contact_sales (automotive only, write via webhook)
// ---------------------------------------------------------------
export const contactSales = {
  name: 'contact_sales',
  description:
    'Captures a sales lead for an automotive dealership. Use for test drive requests, vehicle inquiries, financing questions, lease questions, trade-in conversations, or general interest. Requires at least one contact method (email or phone). Only available for automotive clients.',
  isWrite: true, // flag for write-specific rate limiting
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string', description: 'Unique slug identifying the dealership.' },
      customer: {
        type: 'object',
        description: 'Customer contact information.',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          preferred_contact: { type: 'string', enum: ['email', 'phone', 'sms'] },
          zip_code: { type: 'string' },
        },
        required: ['first_name', 'last_name'],
      },
      intent: {
        type: 'string',
        enum: ['test_drive', 'vehicle_inquiry', 'financing', 'lease', 'trade_in', 'general'],
        description: 'What the customer is reaching out about.',
      },
      vehicle_of_interest: {
        type: 'object',
        description: 'Optional — the specific vehicle the customer is asking about.',
        properties: {
          vin: { type: 'string' },
          stock_number: { type: 'string' },
          year: { type: 'integer' },
          make: { type: 'string' },
          model: { type: 'string' },
          trim: { type: 'string' },
          stock_type: { type: 'string', enum: ['new', 'used', 'certified'] },
        },
      },
      preferred_date: { type: 'string', format: 'date', description: 'For test_drive: preferred date.' },
      notes: { type: 'string' },
    },
    required: ['client_slug', 'customer', 'intent'],
  },
  handler: async ({ client_slug, customer, intent, vehicle_of_interest, preferred_date, notes }) => {
    const client = await findPublicClient(client_slug);
    requireAutomotive(client);

    // Require at least one contact method (LD11)
    if (!customer.email && !customer.phone) {
      throw new Error(
        'A phone number or email is required so the dealership can reach the customer.'
      );
    }

    const webhookUrl = process.env.LEAD_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new Error('LEAD_WEBHOOK_URL is not configured.');
    }

    // Flat payload matching the existing n8n webhook shape + source/lead_type
    const vehicleInterest = vehicle_of_interest
      ? `${vehicle_of_interest.year ?? ''} ${vehicle_of_interest.make ?? ''} ${vehicle_of_interest.model ?? ''} ${vehicle_of_interest.trim ?? ''}`.trim() || null
      : null;

    const webhookPayload = {
      client_slug,
      lead_type: 'contact_sales',
      inquiry_type: intent,
      customer_name: `${customer.first_name} ${customer.last_name}`,
      customer_email: customer.email ?? null,
      customer_phone: customer.phone ?? null,
      vehicle_interest: vehicleInterest,
      source: 'public_mcp',
    };

    const webhookRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });

    if (!webhookRes.ok) {
      const body = await webhookRes.text().catch(() => '');
      throw new Error(`Lead submission failed: ${webhookRes.status} ${body}`.trim());
    }

    const intentMessages = {
      test_drive: `Test drive request received. ${client.business_name}'s sales team will contact ${customer.first_name} to schedule a time.`,
      vehicle_inquiry: `Vehicle inquiry received. ${client.business_name}'s sales team will follow up with details.`,
      financing: `Financing inquiry received. ${client.business_name}'s finance team will reach out to discuss options.`,
      lease: `Lease inquiry received. ${client.business_name}'s leasing team will follow up with current programs.`,
      trade_in: `Trade-in inquiry received. ${client.business_name}'s buy center will follow up to schedule an appraisal.`,
      general: `Inquiry received. ${client.business_name}'s sales team will follow up shortly.`,
    };

    return {
      business_name: client.business_name,
      status: 'lead_captured',
      lead_id: null,
      intent,
      message: intentMessages[intent],
      sales_phone: client.phone,
      website: client.website,
      summary: {
        customer: `${customer.first_name} ${customer.last_name}`,
        intent,
        vehicle: vehicle_of_interest
          ? `${vehicle_of_interest.year ?? ''} ${vehicle_of_interest.make ?? ''} ${vehicle_of_interest.model ?? ''}`.trim() || 'unspecified'
          : 'none specified',
        preferred_date: preferred_date ?? null,
      },
    };
  },
};

// ---------------------------------------------------------------
// Registry
// ---------------------------------------------------------------
export const publicInteractionTools = [
  getAvailability,
  getReviews,
  searchInventory,
  getVehicleDetails,
  getSpecials,
  searchProducts,
  getProductDetails,
  contactSales,
];

export const publicInteractionToolsByName = Object.fromEntries(
  publicInteractionTools.map(t => [t.name, t])
);

// Write tools — exported separately so server.js can apply the stricter rate limit
export const publicWriteToolNames = new Set(
  publicInteractionTools.filter(t => t.isWrite).map(t => t.name)
);
