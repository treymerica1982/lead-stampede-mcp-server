// Quick structural check: makes sure all files load and tool schemas are valid.
// Does NOT hit Supabase — safe to run without credentials.

// Mock Supabase before importing anything that uses it
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-placeholder';

const { allTools, toolsByName } = await import('./tools.js');

console.log('✓ tools.js loaded');
console.log(`✓ ${allTools.length} tools registered:`);
for (const tool of allTools) {
  console.log(`  - ${tool.name}: ${tool.description.slice(0, 60)}...`);

  // Schema sanity
  if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
    throw new Error(`Tool ${tool.name} missing valid inputSchema`);
  }
  if (!tool.handler || typeof tool.handler !== 'function') {
    throw new Error(`Tool ${tool.name} missing handler function`);
  }
}

// Registry lookup
for (const tool of allTools) {
  if (toolsByName[tool.name] !== tool) {
    throw new Error(`Registry mismatch for ${tool.name}`);
  }
}
console.log('✓ tool registry matches all exports');

console.log('\nAll structural checks passed.');
