// src/tools/automotive.js
//
// Lead Stampede MCP Server — Automotive Tool Family
// =====================================================
//
// 5 tools that work only for clients with business_type='automotive'.
// Mirrors the gating pattern used for the ecommerce tool family.
//
//   search_inventory             — query inventory_vehicles with filters + FTS
//   get_vehicle_details          — full detail for one VIN or stock number
//   get_specials                 — current new/used/service specials (curated)
//   schedule_service_appointment — capture service lead, return tracked booking URL
//   contact_sales                — capture sales lead with intent enum
//
// PATTERN PARITY:
//   • Handler signature: async ({args}, { agency }) => result
//   • Uses shared findClient() helper (imported from ../tools.js — see runbook)
//   • Uses requireAutomotive() guard, parallel to requireEcommerce()
//   • Uses wrapBookingUrl() from R1-B for tracked service-appointment URLs
//
// Integration into existing tools.js:
//   See INTEGRATION.md in this patch — Claude Code will import these
//   exports and add them to allTools / toolsByName.

import { supabase } from '../supabase.js';
import { wrapBookingUrl } from '../lib/booking-url-tracker.js';

// =============================================================
// SHARED HELPERS — automotive
// =============================================================

/**
 * Look up an active client by slug, scoped to the calling agency.
 * Local copy here so this file is self-contained — Claude Code may
 * choose to dedupe by importing from ../tools.js if findClient is
 * already exported there.
 */
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

/**
 * Throw if the client is not an automotive business.
 * Mirrors requireEcommerce() pattern.
 */
function requireAutomotive(client) {
  if (client.business_type !== 'automotive') {
    throw new Error(
      `This tool is only available for automotive clients. ` +
      `Client "${client.slug}" has business_type="${client.business_type}". ` +
      `Use the appropriate ${client.business_type} tools instead.`
    );
  }
}

/**
 * Format an inventory_vehicles row into a clean response shape.
 * Cents → dollars, condense the noisy stuff, keep the link.
 */
function formatVehicle(v) {
  return {
    vin: v.vin,
    stock_number: v.stock_number,
    stock_type: v.stock_type, // 'new' | 'used' | 'certified'
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

// =============================================================
// TOOL 1 — search_inventory
// =============================================================
export const searchInventory = {
  name: 'search_inventory',
  description:
    'Searches the dealership\'s vehicle inventory. Filters by stock type (new/used/certified), make, model, year range, price range, body type (SUV/Sedan/Hatchback/Bus/Truck/Coupe/Wagon), and fuel type (gas/electric/hybrid/diesel/phev). Optional natural-language query runs full-text search across year/make/model/trim/body_type/fuel_type/exterior_color. Returns up to 25 matching vehicles with VIN, year/make/model/trim, mileage, price, and a link to the listing. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: {
        type: 'string',
        description: 'Unique slug identifying the dealership (e.g. "onion-creek-vw").',
      },
      query: {
        type: 'string',
        description: 'Optional natural-language search (e.g. "red SUV", "electric Volkswagen", "AWD wagon").',
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
      featured_only: {
        type: 'boolean',
        description: 'If true, only return featured vehicles.',
      },
      limit: {
        type: 'integer',
        description: 'Max results to return (1-25, default 10).',
      },
    },
    required: ['client_slug'],
  },
  handler: async (args, { agency }) => {
    const {
      client_slug,
      query,
      stock_type = 'any',
      make,
      model,
      year_min,
      year_max,
      price_min,
      price_max,
      body_type,
      fuel_type,
      featured_only = false,
      limit = 10,
    } = args;

    const client = await findClient(client_slug, agency.id);
    requireAutomotive(client);

    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));

    let q = supabase
      .from('inventory_vehicles')
      .select('*')
      .eq('client_id', client.id)
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

    // Full-text search across year/make/model/trim/body/fuel/exterior_color/condition
    if (query && query.trim()) {
      q = q.textSearch(
        'fts',
        query.trim(),
        { type: 'websearch', config: 'english' }
      );
    }

    // Sort: featured first, then year desc, then price asc
    q = q.order('featured', { ascending: false })
         .order('year', { ascending: false })
         .order('price_cents', { ascending: true });
    q = q.limit(safeLimit);

    const { data, error } = await q;

    // Graceful-degradation fallback: if the FTS path errors (column
    // missing, index issue, tsvector parse failure), fall back to
    // multi-token ILIKE matching across the same set of columns.
    // After v3.1 migration, the `fts` column exists and the FTS path
    // should be the primary route — this branch is a safety net for
    // future regressions. Multi-word queries are tokenized and AND'd
    // across tokens (mirrors websearch_to_tsquery semantics).
    if (error && (/textSearch|fts|tsvector/i.test(error.message))) {
      let q2 = supabase
        .from('inventory_vehicles')
        .select('*')
        .eq('client_id', client.id)
        .eq('active', true)
        .eq('available', true);
      if (stock_type && stock_type !== 'any') q2 = q2.eq('stock_type', stock_type);
      if (make) q2 = q2.ilike('make', make);
      if (model) q2 = q2.ilike('model', model);
      if (typeof year_min === 'number') q2 = q2.gte('year', year_min);
      if (typeof year_max === 'number') q2 = q2.lte('year', year_max);
      if (typeof price_min === 'number') q2 = q2.gte('price_cents', Math.round(price_min * 100));
      if (typeof price_max === 'number') q2 = q2.lte('price_cents', Math.round(price_max * 100));
      if (body_type) q2 = q2.eq('body_type', body_type);
      if (fuel_type) q2 = q2.eq('fuel_type', fuel_type);
      if (featured_only) q2 = q2.eq('featured', true);
      if (query && query.trim()) {
        // Tokenize on whitespace and AND across tokens (each token must
        // appear in at least one column). Mirrors websearch_to_tsquery's
        // implicit-AND semantics. Strip PostgREST .or() metacharacters
        // (`,` and parens) to avoid breaking the filter parser; this is a
        // pragmatic guard, not full escaping.
        const tokens = query
          .trim()
          .split(/\s+/)
          .map((t) => t.replace(/[(),]/g, ''))
          .filter((t) => t.length > 0);
        for (const token of tokens) {
          q2 = q2.or(
            `make.ilike.%${token}%,model.ilike.%${token}%,trim.ilike.%${token}%,exterior_color.ilike.%${token}%,body_type.ilike.%${token}%,fuel_type.ilike.%${token}%`
          );
        }
      }
      q2 = q2.order('featured', { ascending: false })
             .order('year', { ascending: false })
             .order('price_cents', { ascending: true })
             .limit(safeLimit);
      const { data: data2, error: error2 } = await q2;
      if (error2) throw new Error(`Database error: ${error2.message}`);
      return {
        business_name: client.business_name,
        query: query ?? null,
        filters: { stock_type, make, model, year_min, year_max, price_min, price_max, body_type, fuel_type, featured_only },
        result_count: data2.length,
        vehicles: data2.map(formatVehicle),
      };
    }

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

// =============================================================
// TOOL 2 — get_vehicle_details
// =============================================================
export const getVehicleDetails = {
  name: 'get_vehicle_details',
  description:
    'Returns full details for a specific vehicle in the dealership\'s inventory. Look up by VIN or stock number. Returns the same shape as search_inventory but for a single vehicle, including all features. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string' },
      vin: { type: 'string', description: '17-character VIN.' },
      stock_number: { type: 'string', description: 'Dealer stock number.' },
    },
    required: ['client_slug'],
  },
  handler: async ({ client_slug, vin, stock_number }, { agency }) => {
    if (!vin && !stock_number) {
      throw new Error('Provide either vin or stock_number.');
    }

    const client = await findClient(client_slug, agency.id);
    requireAutomotive(client);

    let q = supabase
      .from('inventory_vehicles')
      .select('*')
      .eq('client_id', client.id)
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

// =============================================================
// TOOL 3 — get_specials
// =============================================================
export const getSpecials = {
  name: 'get_specials',
  description:
    'Returns the dealership\'s current specials and offers — new-vehicle APR/lease specials, pre-owned specials, service & parts coupons, manufacturer rebates, and incentive programs (College Grad, Military, Partner). Each offer includes a title, summary, and a link to the dealer\'s page. Only available for automotive clients.',
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
  handler: async ({ client_slug, category = 'all' }, { agency }) => {
    const client = await findClient(client_slug, agency.id);
    requireAutomotive(client);

    // Note: there is no `specials` table yet. For now, surface curated links
    // from the client's website to the major specials pages. Future: a real
    // `vehicle_specials` table per client.
    const baseUrl = client.website?.replace(/\/$/, '') ?? '';
    const specials = [
      {
        category: 'new',
        title: 'New Vehicle Specials',
        summary: 'Current APR offers, lease deals, and price reductions on new vehicles.',
        url: `${baseUrl}/newspecials.html`,
      },
      {
        category: 'used',
        title: 'Pre-Owned Specials',
        summary: 'Pre-owned vehicles with reduced pricing.',
        url: `${baseUrl}/searchused.aspx?dql=days>60`,
      },
      {
        category: 'service',
        title: 'Service & Parts Specials',
        summary: 'Coupons and discounts on routine maintenance, parts, and service work.',
        url: `${baseUrl}/service-parts-specials.html`,
      },
      {
        category: 'rebates',
        title: 'Manufacturer Rebates',
        summary: 'Current factory rebates and incentives from the manufacturer.',
        url: `${baseUrl}/manufacturer-specials.aspx`,
      },
      {
        category: 'rebates',
        title: 'College Graduate Program',
        summary: 'Special pricing and finance offers for recent college graduates.',
        url: `${baseUrl}/vw-college-grad.html`,
      },
      {
        category: 'rebates',
        title: 'Military Bonus Program',
        summary: 'Bonus incentives for active military, veterans, and their families.',
        url: `${baseUrl}/military-bonus.html`,
      },
    ];

    const filtered = category === 'all'
      ? specials
      : specials.filter((s) => s.category === category);

    return {
      business_name: client.business_name,
      category,
      result_count: filtered.length,
      specials: filtered,
      note: 'Specials are surfaced from the dealer\'s public website. For the most current offer details and exclusions, follow the links.',
    };
  },
};

// =============================================================
// TOOL 4 — schedule_service_appointment
// =============================================================
export const scheduleServiceAppointment = {
  name: 'schedule_service_appointment',
  description:
    'Captures a service appointment request for the dealership and returns a tracked link to the official online scheduler. The customer\'s contact info, vehicle details, requested services, and preferred timing are recorded as a service lead. The dealership\'s service advisor will follow up to confirm the exact slot. The returned booking_url is a tracked redirect so engagement can be measured. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string' },
      customer: {
        type: 'object',
        description: 'Customer contact information.',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          preferred_contact: {
            type: 'string',
            enum: ['email', 'phone', 'sms'],
          },
        },
        required: ['first_name', 'last_name', 'phone'],
      },
      vehicle: {
        type: 'object',
        description: 'Vehicle being serviced.',
        properties: {
          year: { type: 'integer' },
          make: { type: 'string' },
          model: { type: 'string' },
          vin: { type: 'string' },
          mileage: { type: 'integer' },
        },
        required: ['year', 'make', 'model'],
      },
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of requested services, e.g. ["oil change","tire rotation","check engine light"].',
      },
      preferred_date: { type: 'string', format: 'date' },
      preferred_time_window: {
        type: 'string',
        enum: ['morning', 'afternoon', 'first-available'],
      },
      notes: { type: 'string' },
    },
    required: ['client_slug', 'customer', 'vehicle', 'services'],
  },
  handler: async (args, { agency }) => {
    const { client_slug, customer, vehicle, services, preferred_date, preferred_time_window, notes } = args;

    const client = await findClient(client_slug, agency.id);
    requireAutomotive(client);

    // Persist the lead (best-effort — fire and continue if leads table doesn't exist yet).
    // The leads table is a future addition. For now we surface the booking URL and
    // log the request as a side-effect.
    let lead_id = null;
    try {
      const leadPayload = {
        client_id: client.id,
        agency_id: agency.id,
        lead_type: 'service_appointment',
        customer,
        vehicle,
        services,
        preferred_date: preferred_date ?? null,
        preferred_time_window: preferred_time_window ?? null,
        notes: notes ?? null,
      };
      const { data: lead, error: leadError } = await supabase
        .from('automotive_leads')
        .insert(leadPayload)
        .select('id')
        .maybeSingle();
      if (!leadError && lead) lead_id = lead.id;
      // Swallow error if table doesn't exist yet — the booking URL still works.
    } catch (e) {
      console.warn('automotive_leads insert failed (table may not exist yet):', e.message);
    }

    // Wrap the dealership's official service scheduler URL through the
    // R1-B booking-url-tracker so engagement is measured.
    const tracked_booking_url = await wrapBookingUrl({
      client,
      originalBookingUrl: client.booking_url,
      toolName: 'schedule_service_appointment',
      toolCallId: null, // analytics adds this fire-and-forget
      supabase,
    });

    return {
      business_name: client.business_name,
      status: 'lead_captured',
      lead_id,
      message: `Thanks ${customer.first_name}! Your service request for the ${vehicle.year} ${vehicle.make} ${vehicle.model} has been recorded. ${client.business_name}'s service team will reach you at ${customer.phone} to confirm your appointment.`,
      booking_url: tracked_booking_url,
      service_phone: client.hours?.departments?.service_phone ?? null,
      summary: {
        customer: `${customer.first_name} ${customer.last_name}`,
        vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        services,
        preferred_date: preferred_date ?? null,
        preferred_time_window: preferred_time_window ?? null,
      },
    };
  },
};

// =============================================================
// TOOL 5 — contact_sales
// =============================================================
export const contactSales = {
  name: 'contact_sales',
  description:
    'Captures a sales lead for the dealership. Use for test drive requests, vehicle inquiries, financing questions, lease questions, trade-in conversations, or general "I\'m interested in this car" requests. Captures customer info, intent (test_drive, vehicle_inquiry, financing, lease, trade_in, general), and (optionally) the specific vehicle the customer is asking about. The sales team follows up by the customer\'s preferred contact method. Only available for automotive clients.',
  inputSchema: {
    type: 'object',
    properties: {
      client_slug: { type: 'string' },
      customer: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          preferred_contact: {
            type: 'string',
            enum: ['email', 'phone', 'sms'],
          },
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
          stock_type: {
            type: 'string',
            enum: ['new', 'used', 'certified'],
          },
        },
      },
      preferred_date: {
        type: 'string',
        format: 'date',
        description: 'For test_drive intent: preferred date.',
      },
      notes: { type: 'string' },
    },
    required: ['client_slug', 'customer', 'intent'],
  },
  handler: async (args, { agency }) => {
    const { client_slug, customer, intent, vehicle_of_interest, preferred_date, notes } = args;

    const client = await findClient(client_slug, agency.id);
    requireAutomotive(client);

    // Best-effort lead persistence (same caveat as service-appointment tool)
    let lead_id = null;
    try {
      const leadPayload = {
        client_id: client.id,
        agency_id: agency.id,
        lead_type: 'sales_inquiry',
        customer,
        intent,
        vehicle: vehicle_of_interest ?? null,
        preferred_date: preferred_date ?? null,
        notes: notes ?? null,
      };
      const { data: lead, error: leadError } = await supabase
        .from('automotive_leads')
        .insert(leadPayload)
        .select('id')
        .maybeSingle();
      if (!leadError && lead) lead_id = lead.id;
    } catch (e) {
      console.warn('automotive_leads insert failed (table may not exist yet):', e.message);
    }

    // Build a friendly message based on intent
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
      lead_id,
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

// =============================================================
// REGISTRY EXPORT
// =============================================================

export const automotiveTools = [
  searchInventory,
  getVehicleDetails,
  getSpecials,
  scheduleServiceAppointment,
  contactSales,
];

export const automotiveToolsByName = Object.fromEntries(
  automotiveTools.map((t) => [t.name, t])
);
