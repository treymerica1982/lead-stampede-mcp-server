#!/usr/bin/env node
// Integration test for the v2 MCP tools.
// Runs the handlers directly against a real Supabase project.
//
// REQUIRED ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   LS_AGENCY_ID          -- UUID of the Lead Stampede agency row
//
// Usage: node src/test-integration.js

import 'dotenv/config';
import { allTools, toolsByName } from './tools.js';

const agencyId = process.env.LS_AGENCY_ID;
if (!agencyId) {
  console.error('ERROR: LS_AGENCY_ID env var required (UUID of the lead-stampede agency row)');
  process.exit(1);
}

const context = { agency: { id: agencyId, slug: 'lead-stampede', name: 'Lead Stampede' } };

let passed = 0, failed = 0;

async function run(name, args, assertFn) {
  const tool = toolsByName[name];
  if (!tool) throw new Error(`Unknown tool ${name}`);
  try {
    const result = await tool.handler(args, context);
    assertFn(result);
    console.log(`  ✓ ${name} ${JSON.stringify(args)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} ${JSON.stringify(args)}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

console.log('\n=== Service tools (existing, should still work) ===');

await run('get_business_profile', { client_slug: 'grandinetti-molinar-law' }, r => {
  assert(r.business_name === 'Grandinetti & Molinar Law', 'business name');
  assert(r.business_type === 'service', 'business type');
  assert(r.contact && r.contact.phone, 'contact.phone present');
});

await run('get_business_profile', { client_slug: 'understated-leather' }, r => {
  assert(r.business_name === 'Understated Leather', 'business name');
  assert(r.business_type === 'ecommerce', 'business type ecommerce');
  assert(r.contact && r.contact.shop_url, 'contact.shop_url present');
});

await run('get_services', { client_slug: 'grandinetti-molinar-law' }, r => {
  assert(r.services && r.services.length > 0, 'services returned');
});

await run('get_availability', { client_slug: 'understated-leather' }, r => {
  assert(r.booking, 'booking object present');
  assert(r.booking.method, 'booking method present');
});

console.log('\n=== E-commerce tools (new) ===');

await run('search_products', { client_slug: 'understated-leather', query: 'leather jacket' }, r => {
  assert(r.products && r.products.length > 0, 'products returned');
  assert(r.result_count > 0, 'result_count > 0');
  const names = r.products.map(p => p.name.toLowerCase());
  assert(names.some(n => n.includes('jacket')), 'at least one result mentions jacket');
});

await run('search_products', { client_slug: 'understated-leather', category: 'accessories', max_price: 200 }, r => {
  assert(r.products.every(p => p.price <= 200), 'all products under $200');
  assert(r.products.every(p => p.category === 'accessories'), 'all products in accessories');
});

await run('search_products', { client_slug: 'understated-leather', collection: 'Southern Sunrise SS26' }, r => {
  assert(r.products.length > 0, 'collection returns products');
  assert(r.products.every(p => p.collection === 'Southern Sunrise SS26'), 'all products from the right collection');
});

await run('search_products', { client_slug: 'understated-leather', query: 'fringe' }, r => {
  assert(r.products.length > 0, 'fringe search returns products');
});

await run('get_collection', { client_slug: 'understated-leather' }, r => {
  assert(Array.isArray(r.available_collections), 'list of collections returned');
  assert(r.available_collections.length === 3, 'three collections available');
});

await run('get_collection', { client_slug: 'understated-leather', collection: 'Studded Essentials' }, r => {
  assert(r.products.length > 0, 'products returned for Studded Essentials');
  assert(r.product_count === r.products.length, 'product_count matches array length');
});

await run('get_product_details', { client_slug: 'understated-leather', product_slug: 'sunrise-fringe-jacket' }, r => {
  assert(r.product.name === 'Sunrise Fringe Moto Jacket', 'product name');
  assert(r.product.price > 0, 'price > 0');
  assert(Array.isArray(r.product.available_sizes), 'sizes array');
});

console.log('\n=== Negative paths (should gracefully error) ===');

// E-commerce tool on a service client should throw a clean error
try {
  await toolsByName.search_products.handler({ client_slug: 'grandinetti-molinar-law', query: 'law' }, context);
  console.log('  ✗ Expected e-commerce tool to reject service client, but it succeeded');
  failed++;
} catch (err) {
  if (err.message.includes('service business')) {
    console.log('  ✓ search_products correctly rejects service-business client');
    passed++;
  } else {
    console.log(`  ✗ Wrong error: ${err.message}`);
    failed++;
  }
}

// Unknown product slug
try {
  await toolsByName.get_product_details.handler({ client_slug: 'understated-leather', product_slug: 'does-not-exist' }, context);
  console.log('  ✗ Expected unknown product to fail');
  failed++;
} catch (err) {
  if (err.message.includes('No active product')) {
    console.log('  ✓ get_product_details correctly rejects unknown product');
    passed++;
  } else {
    console.log(`  ✗ Wrong error: ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
