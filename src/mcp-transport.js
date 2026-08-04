import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { publicTools } from './public-tools.js';
import { publicInteractionTools, logPublicToolCall, publicWriteToolNames } from './public-interaction-tools.js';
import { checkWriteRateLimit } from './rate-limit.js';

// ---------------------------------------------------------------
// Zod schemas for ALL public tools (discovery + interaction).
// ---------------------------------------------------------------
const zodSchemas = {
  // --- Discovery tools (4) ---
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

  // --- Interaction tools (7) ---
  get_availability: {
    client_slug: z.string().describe('Unique slug identifying the client.'),
  },
  get_reviews: {
    client_slug: z.string().describe('Unique slug identifying the client.'),
  },
  search_inventory: {
    client_slug: z.string().describe('Unique slug identifying the dealership.'),
    query: z.string().optional().describe('Natural-language search (e.g. "red SUV").'),
    stock_type: z.enum(['new', 'used', 'certified', 'any']).optional().describe('Filter by stock type.'),
    make: z.string().optional().describe('Vehicle make.'),
    model: z.string().optional().describe('Vehicle model.'),
    year_min: z.number().int().optional(),
    year_max: z.number().int().optional(),
    price_min: z.number().optional().describe('Minimum price in dollars.'),
    price_max: z.number().optional().describe('Maximum price in dollars.'),
    body_type: z.enum(['SUV', 'Sedan', 'Hatchback', 'Bus', 'Truck', 'Coupe', 'Wagon']).optional(),
    fuel_type: z.enum(['gas', 'electric', 'hybrid', 'diesel', 'phev']).optional(),
    featured_only: z.boolean().optional().describe('If true, only featured vehicles.'),
    limit: z.number().int().optional().describe('Max results (1-25, default 10).'),
  },
  get_vehicle_details: {
    client_slug: z.string().describe('Unique slug identifying the dealership.'),
    vin: z.string().optional().describe('17-character VIN.'),
    stock_number: z.string().optional().describe('Dealer stock number.'),
  },
  get_specials: {
    client_slug: z.string().describe('Unique slug identifying the dealership.'),
    category: z.enum(['new', 'used', 'service', 'parts', 'rebates', 'all']).optional().describe('Filter by category.'),
  },
  search_products: {
    client_slug: z.string().describe('Unique slug identifying the e-commerce client.'),
    query: z.string().optional().describe('Natural-language search terms.'),
    category: z.string().optional().describe('Product category filter.'),
    collection: z.string().optional().describe('Collection name filter.'),
    min_price: z.number().optional().describe('Minimum price in dollars.'),
    max_price: z.number().optional().describe('Maximum price in dollars.'),
    in_stock_only: z.boolean().optional().describe('If true, only in-stock products.'),
    limit: z.number().int().optional().describe('Max results (1-25, default 10).'),
  },
  get_product_details: {
    client_slug: z.string().describe('Unique slug identifying the e-commerce client.'),
    product_slug: z.string().describe('Slug of the product.'),
  },

  // --- Write tools ---
  contact_sales: {
    client_slug: z.string().describe('Unique slug identifying the dealership.'),
    customer: z.object({
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().optional().describe('Customer email.'),
      phone: z.string().optional().describe('Customer phone.'),
      preferred_contact: z.enum(['email', 'phone', 'sms']).optional(),
      zip_code: z.string().optional(),
    }).describe('Customer contact information.'),
    intent: z.enum(['test_drive', 'vehicle_inquiry', 'financing', 'lease', 'trade_in', 'general']).describe('What the customer is reaching out about.'),
    vehicle_of_interest: z.object({
      vin: z.string().optional(),
      stock_number: z.string().optional(),
      year: z.number().int().optional(),
      make: z.string().optional(),
      model: z.string().optional(),
      trim: z.string().optional(),
      stock_type: z.enum(['new', 'used', 'certified']).optional(),
    }).optional().describe('The specific vehicle the customer is asking about.'),
    preferred_date: z.string().optional().describe('For test_drive: preferred date.'),
    notes: z.string().optional(),
  },
  schedule_service_appointment: {
    client_slug: z.string().describe('Unique slug identifying the dealership.'),
    customer: z.object({
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().optional().describe('Customer email.'),
      phone: z.string().optional().describe('Customer phone.'),
      preferred_contact: z.enum(['email', 'phone', 'sms']).optional(),
    }).describe('Customer contact information.'),
    vehicle: z.object({
      year: z.number().int(),
      make: z.string(),
      model: z.string(),
      vin: z.string().optional(),
      mileage: z.number().int().optional(),
    }).describe('Vehicle being serviced.'),
    services: z.array(z.string()).describe('List of requested services.'),
    preferred_date: z.string().optional().describe('Preferred date (YYYY-MM-DD).'),
    preferred_time_window: z.enum(['morning', 'afternoon', 'first-available']).optional(),
    notes: z.string().optional(),
  },
};

// Combined public tool set: discovery + interaction
const allMcpTools = [...publicTools, ...publicInteractionTools];

// ---------------------------------------------------------------
// Factory: fresh McpServer with all public tools registered.
// Called per-request in stateless mode — server + transport are
// created together and GC'd after the response completes.
// ---------------------------------------------------------------
function createMcpServer(requestIp) {
  const server = new McpServer({
    name: 'lead-stampede',
    version: '0.5.0',
  });

  for (const tool of allMcpTools) {
    const schema = zodSchemas[tool.name];

    server.tool(tool.name, tool.description, schema, async (args) => {
      // Enforce stricter write rate limit for write tools (LD11)
      if (publicWriteToolNames.has(tool.name) && !checkWriteRateLimit(requestIp)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'rate_limited', message: 'Too many write requests. Please slow down.' }) }],
          isError: true,
        };
      }

      const start = Date.now();
      try {
        const result = await tool.handler(args);
        const responseMs = Date.now() - start;

        // Public analytics for MCP protocol path (LD7/LD8)
        logPublicToolCall({
          clientSlug: args.client_slug,
          toolName: tool.name,
          responseMs,
          success: true,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        const responseMs = Date.now() - start;

        logPublicToolCall({
          clientSlug: args.client_slug,
          toolName: tool.name,
          responseMs,
          success: false,
          errorMessage: err.message,
        });

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
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const server = createMcpServer(ip);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
