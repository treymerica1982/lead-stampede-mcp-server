import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { publicTools } from './public-tools.js';

// ---------------------------------------------------------------
// Zod translations of the 4 public-tool JSON schemas.
// These are trivial — all optional strings, one required string.
// ---------------------------------------------------------------
const zodSchemas = {
  search_clients: {
    query: z.string().optional().describe('Free-text search across business name, description, and industry.'),
    city: z.string().optional().describe("Filter by city name within the client's service area."),
    business_type: z.string().optional().describe('Filter by business type (e.g. "service", "ecommerce", "automotive").'),
  },
  get_client: {
    slug: z.string().describe('The unique slug of the client (e.g. "lead-stampede").'),
  },
  list_business_types: {},
  list_cities: {},
};

// ---------------------------------------------------------------
// Factory: fresh McpServer with the 4 public tools registered.
// Called per-request in stateless mode — server + transport are
// created together and GC'd after the response completes.
// ---------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({
    name: 'lead-stampede',
    version: '0.2.0',
  });

  for (const tool of publicTools) {
    const schema = zodSchemas[tool.name];

    server.tool(tool.name, tool.description, schema, async (args) => {
      try {
        const result = await tool.handler(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    });
  }

  return server;
}

// ---------------------------------------------------------------
// Express handler — stateless Streamable HTTP.
// Fresh server + transport per request (no session map).
// ---------------------------------------------------------------
export async function handleMcpRequest(req, res) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
