// test/automotive-structural.test.js
//
// Structural checks for the automotive tool family — no DB required.
// Validates that all 5 tools load, have valid schemas, and have handler functions.
//
// Run with: node --experimental-vm-modules test/automotive-structural.test.js

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-placeholder';

const mod = await import('../src/tools/automotive.js');

const { automotiveTools, automotiveToolsByName } = mod;

console.log(`✓ automotive.js loaded with ${automotiveTools.length} tools\n`);

const expected = [
  'search_inventory',
  'get_vehicle_details',
  'get_specials',
  'schedule_service_appointment',
  'contact_sales',
];

let passed = 0;
let failed = 0;

function check(label, cond, msg) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — ${msg}`);
    failed++;
  }
}

for (const name of expected) {
  console.log(`\n[${name}]`);
  const t = automotiveToolsByName[name];
  check('exists in registry', !!t, `tool not found in automotiveToolsByName`);
  if (!t) continue;

  check('has valid name', t.name === name, `expected name "${name}", got "${t.name}"`);
  check('has description string', typeof t.description === 'string' && t.description.length > 50,
        `description missing or too short`);
  check('has inputSchema object', t.inputSchema?.type === 'object',
        `inputSchema must be a JSON Schema object`);
  check('has handler function', typeof t.handler === 'function',
        `handler must be an async function`);
  check('inputSchema has client_slug', !!t.inputSchema?.properties?.client_slug,
        `every tool must accept client_slug`);
  check('client_slug is required',
        Array.isArray(t.inputSchema?.required) && t.inputSchema.required.includes('client_slug'),
        `client_slug must be in required[]`);
}

console.log(`\n=== Registry integrity ===`);
check('5 tools registered', automotiveTools.length === 5,
      `expected 5 tools, got ${automotiveTools.length}`);
check('toolsByName matches array',
      Object.keys(automotiveToolsByName).length === automotiveTools.length,
      `mismatch between automotiveTools and automotiveToolsByName`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
