// test/automotive-integration.test.js
//
// Integration test for the automotive tool family.
// Hits the REAL production Supabase (gcyglsdzpcobjvtvddve) and queries
// the seeded onion-creek-vw client data.
//
// Prerequisites:
//   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in process env (or .env loaded)
//   - LS_DEMO_AGENCY_ID env var = the lead-stampede-demo agency UUID
//     (abfadc6c-48fd-4cc7-833d-ef6d3828d8ce)
//   - Phase 1 SQL migration applied (onion-creek-vw client + 12 vehicles seeded)
//
// Run with:
//   LS_DEMO_AGENCY_ID=abfadc6c-48fd-4cc7-833d-ef6d3828d8ce node test/automotive-integration.test.js

import 'dotenv/config';

const agencyId = process.env.LS_DEMO_AGENCY_ID;
if (!agencyId) {
  console.error('Missing LS_DEMO_AGENCY_ID env var. Set it to the lead-stampede-demo agency UUID.');
  process.exit(1);
}

const { automotiveToolsByName } = await import('../src/tools/automotive.js');

// Minimal context object — mirrors what server.js passes to handler()
const ctx = { agency: { id: agencyId, slug: 'lead-stampede-demo' } };

let passed = 0;
let failed = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function run(toolName, args, validator) {
  console.log(`\n[${toolName}] args=${JSON.stringify(args)}`);
  try {
    const result = await automotiveToolsByName[toolName].handler(args, ctx);
    validator(result);
  } catch (err) {
    console.log(`  ✗ threw: ${err.message}`);
    failed++;
  }
}

// =============================================================
// search_inventory — happy paths
// =============================================================

await run('search_inventory', { client_slug: 'onion-creek-vw' }, (r) => {
  assert(r.business_name === 'Onion Creek Volkswagen', 'business_name correct');
  assert(r.result_count >= 1, 'returns at least 1 vehicle');
  assert(Array.isArray(r.vehicles), 'vehicles is an array');
  assert(r.vehicles[0]?.vin?.length === 17 || r.vehicles[0]?.vin?.length > 0, 'first vehicle has a VIN');
  // Featured vehicles should sort first
  assert(r.vehicles[0]?.featured === true || r.vehicles.every((v) => !v.featured), 'featured vehicles sort first');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', stock_type: 'new' }, (r) => {
  assert(r.result_count === 9, `expected 9 new vehicles, got ${r.result_count}`);
  assert(r.vehicles.every((v) => v.stock_type === 'new'), 'all returned vehicles are new');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', stock_type: 'certified' }, (r) => {
  assert(r.result_count === 2, `expected 2 CPO vehicles, got ${r.result_count}`);
  assert(r.vehicles.every((v) => v.stock_type === 'certified'), 'all returned vehicles are certified');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', stock_type: 'used' }, (r) => {
  assert(r.result_count === 1, `expected 1 used vehicle, got ${r.result_count}`);
  assert(r.vehicles[0]?.model === 'Golf R', `expected Golf R, got ${r.vehicles[0]?.model}`);
});

await run('search_inventory', { client_slug: 'onion-creek-vw', model: 'Tiguan' }, (r) => {
  assert(r.result_count === 2, `expected 2 Tiguans (1 new, 1 CPO), got ${r.result_count}`);
  assert(r.vehicles.every((v) => v.model === 'Tiguan'), 'all returned vehicles are Tiguan');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', fuel_type: 'electric' }, (r) => {
  assert(r.result_count === 2, `expected 2 EVs (ID.4, ID. Buzz), got ${r.result_count}`);
  assert(r.vehicles.every((v) => v.fuel_type === 'electric'), 'all returned vehicles are electric');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', price_max: 30000 }, (r) => {
  assert(r.vehicles.every((v) => v.price <= 30000), 'all vehicles under $30k');
});

await run('search_inventory', { client_slug: 'onion-creek-vw', featured_only: true }, (r) => {
  assert(r.result_count === 6, `expected 6 featured, got ${r.result_count}`);
  assert(r.vehicles.every((v) => v.featured === true), 'all returned vehicles are featured');
});

// FTS query — should at least return relevant results without crashing
await run('search_inventory', { client_slug: 'onion-creek-vw', query: 'electric SUV' }, (r) => {
  assert(r.result_count >= 1, `FTS returned ${r.result_count} results for "electric SUV"`);
});

// =============================================================
// get_vehicle_details
// =============================================================

await run('get_vehicle_details', { client_slug: 'onion-creek-vw', vin: '3VV4C7B24SM085555' }, (r) => {
  assert(r.business_name === 'Onion Creek Volkswagen', 'business_name correct');
  assert(r.vehicle?.model === 'Taos', `expected Taos, got ${r.vehicle?.model}`);
  assert(r.vehicle?.trim === '1.5T SEL', `expected 1.5T SEL, got ${r.vehicle?.trim}`);
  assert(r.vehicle?.price === 28995, `expected $28,995, got $${r.vehicle?.price}`);
  assert(Array.isArray(r.vehicle?.features) && r.vehicle.features.length > 0, 'has features array');
});

await run('get_vehicle_details', { client_slug: 'onion-creek-vw', stock_number: 'V25-001' }, (r) => {
  assert(r.vehicle?.vin === '3VV4C7B24SM085555', `expected matching VIN, got ${r.vehicle?.vin}`);
});

// =============================================================
// get_specials
// =============================================================

await run('get_specials', { client_slug: 'onion-creek-vw' }, (r) => {
  assert(r.business_name === 'Onion Creek Volkswagen', 'business_name correct');
  assert(r.result_count === 6, `expected 6 specials (all categories), got ${r.result_count}`);
  assert(r.specials.every((s) => s.url?.startsWith('https://')), 'all specials have URLs');
});

await run('get_specials', { client_slug: 'onion-creek-vw', category: 'service' }, (r) => {
  assert(r.result_count === 1, `expected 1 service special, got ${r.result_count}`);
  assert(r.specials[0]?.category === 'service', 'category matches filter');
});

// =============================================================
// schedule_service_appointment
// =============================================================

await run('schedule_service_appointment', {
  client_slug: 'onion-creek-vw',
  customer: {
    first_name: 'Test',
    last_name: 'Customer',
    phone: '512-555-0100',
    preferred_contact: 'phone',
  },
  vehicle: {
    year: 2022,
    make: 'Volkswagen',
    model: 'Tiguan',
    mileage: 28000,
  },
  services: ['oil change', 'tire rotation'],
  preferred_date: '2026-05-20',
  preferred_time_window: 'morning',
}, (r) => {
  assert(r.status === 'lead_captured', 'status is lead_captured');
  assert(r.business_name === 'Onion Creek Volkswagen', 'business_name correct');
  assert(typeof r.message === 'string' && r.message.includes('Test'), 'message includes customer name');
  assert(r.summary?.vehicle === '2022 Volkswagen Tiguan', 'summary vehicle string correct');
  // booking_url may be tracked or null depending on whether wrapBookingUrl is configured
  assert('booking_url' in r, 'booking_url field is present in response');
});

// =============================================================
// contact_sales
// =============================================================

await run('contact_sales', {
  client_slug: 'onion-creek-vw',
  customer: {
    first_name: 'Test',
    last_name: 'Customer',
    email: 'test@example.com',
    phone: '512-555-0101',
    preferred_contact: 'email',
    zip_code: '78748',
  },
  intent: 'test_drive',
  vehicle_of_interest: {
    year: 2026,
    make: 'Volkswagen',
    model: 'Tiguan',
    trim: 'SE',
    stock_type: 'new',
  },
  preferred_date: '2026-05-15',
}, (r) => {
  assert(r.status === 'lead_captured', 'status is lead_captured');
  assert(r.intent === 'test_drive', 'intent echoed back');
  assert(r.message?.includes('Test drive'), 'message references test drive');
  assert(r.sales_phone === '877-651-9152', `expected OCVW sales phone, got ${r.sales_phone}`);
});

// Different intent — financing
await run('contact_sales', {
  client_slug: 'onion-creek-vw',
  customer: { first_name: 'Test', last_name: 'Customer' },
  intent: 'financing',
}, (r) => {
  assert(r.intent === 'financing', 'financing intent echoed');
  assert(r.message?.toLowerCase().includes('financ'), 'message mentions financing');
});

// =============================================================
// Negative paths — automotive tool on non-automotive client
// =============================================================

console.log(`\n[negative path: search_inventory on service client]`);
try {
  await automotiveToolsByName.search_inventory.handler(
    { client_slug: 'grandinetti-molinar-law' },
    ctx
  );
  console.log(`  ✗ expected requireAutomotive() to throw, but it succeeded`);
  failed++;
} catch (err) {
  if (/automotive/i.test(err.message)) {
    console.log(`  ✓ search_inventory correctly rejects service client`);
    passed++;
  } else {
    console.log(`  ✗ wrong error: ${err.message}`);
    failed++;
  }
}

// =============================================================
// Result
// =============================================================

console.log(`\n${'='.repeat(48)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('='.repeat(48));
process.exit(failed === 0 ? 0 : 1);
