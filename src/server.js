import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { requireAgencyAuth } from './auth.js';
import { allTools, toolsByName } from './tools.js';
import { publicTools, publicToolsByName } from './public-tools.js';
import { publicInteractionTools, publicInteractionToolsByName, logPublicToolCall, publicWriteToolNames } from './public-interaction-tools.js';
import { logToolCall } from './analytics.js';
import { publicRateLimit, publicWriteRateLimit } from './rate-limit.js';
import { handleMcpRequest } from './mcp-transport.js';

// Combined public tool set: discovery + interaction
const allPublicTools = [...publicTools, ...publicInteractionTools];
const allPublicToolsByName = { ...publicToolsByName, ...publicInteractionToolsByName };

const app = express();
app.set('trust proxy', true); // Railway runs behind a proxy; needed for accurate req.ip
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request logging (lightweight)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------
// Root manifest — machine-readable surface map (WS2)
// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    name: 'lead-stampede',
    description: 'Discover and transact with Lead Stampede client businesses via AI agents.',
    version: '0.4.0',
    surfaces: {
      mcp: {
        url: '/mcp',
        transport: 'streamable-http',
        auth: 'none',
        note: 'Primary endpoint for MCP clients. Public discovery + interaction tools.',
      },
      public_rest: {
        list: '/mcp/public/tools',
        call: '/mcp/public/tools/:tool',
        auth: 'none',
      },
      agency: {
        list: '/mcp/tools',
        call: '/mcp/tools/:tool',
        auth: 'X-Agency-API-Key',
        note: 'Agency management surface — not for external agents.',
      },
    },
    discovery: {
      directory: 'https://agentcards.leadstampede.io/directory',
      agent_cards: 'https://agentcards.leadstampede.io/<slug>',
    },
  });
});

// ---------------------------------------------------------------
// Health check — no auth required
// ---------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------
// MCP discovery — list all available tools
// GET /mcp/tools
// ---------------------------------------------------------------
app.get('/mcp/tools', requireAgencyAuth, (_req, res) => {
  res.json({
    tools: allTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
});

// ---------------------------------------------------------------
// MCP tool invocation
// POST /mcp/tools/:toolName
// Body: { arguments: { ... } }
// ---------------------------------------------------------------
app.post('/mcp/tools/:toolName', requireAgencyAuth, async (req, res) => {
  const { toolName } = req.params;
  const args = req.body?.arguments ?? {};
  const tool = toolsByName[toolName];

  if (!tool) {
    return res.status(404).json({
      error: 'unknown_tool',
      message: `No tool named "${toolName}". Call GET /mcp/tools to see available tools.`,
    });
  }

  const start = Date.now();
  try {
    const result = await tool.handler(args, { agency: req.agency });
    const responseMs = Date.now() - start;

    // Log asynchronously — do not await
    logToolCall({
      clientSlug: args.client_slug,
      agencyId: req.agency.id,
      toolName,
      responseMs,
      success: true,
    });

    res.json({ tool: toolName, result, response_ms: responseMs });
  } catch (err) {
    const responseMs = Date.now() - start;
    console.error(`[tool:${toolName}]`, err.message);

    logToolCall({
      clientSlug: args.client_slug,
      agencyId: req.agency.id,
      toolName,
      responseMs,
      success: false,
      errorMessage: err.message,
    });

    res.status(400).json({
      error: 'tool_error',
      tool: toolName,
      message: err.message,
    });
  }
});

// ---------------------------------------------------------------
// PUBLIC MCP discovery — no auth, rate-limited
// GET  /mcp/public/tools        — list public tools
// POST /mcp/public/tools/:tool  — invoke a public tool
// ---------------------------------------------------------------
app.get('/mcp/public/tools', publicRateLimit, (_req, res) => {
  res.json({
    tools: allPublicTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
});

app.post('/mcp/public/tools/:toolName', publicRateLimit, async (req, res, next) => {
  // Apply stricter write rate limit for write tools (LD11)
  if (publicWriteToolNames.has(req.params.toolName)) {
    return publicWriteRateLimit(req, res, next);
  }
  next();
}, async (req, res) => {
  const { toolName } = req.params;
  const args = req.body?.arguments ?? {};
  const tool = allPublicToolsByName[toolName];

  if (!tool) {
    return res.status(404).json({
      error: 'unknown_tool',
      message: `No public tool named "${toolName}". Call GET /mcp/public/tools to see available tools.`,
    });
  }

  const start = Date.now();
  try {
    const result = await tool.handler(args);
    const responseMs = Date.now() - start;

    // Public analytics logging (fire-and-forget)
    logPublicToolCall({
      clientSlug: args.client_slug,
      toolName,
      responseMs,
      success: true,
    });

    res.json({ tool: toolName, result, response_ms: responseMs });
  } catch (err) {
    const responseMs = Date.now() - start;
    console.error(`[public-tool:${toolName}]`, err.message);

    logPublicToolCall({
      clientSlug: args.client_slug,
      toolName,
      responseMs,
      success: false,
      errorMessage: err.message,
    });

    res.status(400).json({
      error: 'tool_error',
      tool: toolName,
      message: err.message,
    });
  }
});

// ---------------------------------------------------------------
// MCP protocol — stateless Streamable HTTP (public, rate-limited)
// ---------------------------------------------------------------
app.post('/mcp', publicRateLimit, handleMcpRequest);

// GET /mcp hint — tell agents how to use this endpoint (WS2)
app.get('/mcp', (_req, res) => {
  res.json({
    hint: 'POST JSON-RPC requests to this endpoint to use MCP tools. See GET / for the full surface map.',
    transport: 'streamable-http',
    auth: 'none',
    tools_list: 'Send a JSON-RPC tools/list request via POST to enumerate available tools.',
  });
});

// ---------------------------------------------------------------
// 404 fallback — with discovery hint (WS2)
// ---------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    hint: 'This path does not exist. The Lead Stampede MCP server exposes three surfaces: public MCP (POST /mcp), public REST (/mcp/public/tools), and agency REST (/mcp/tools).',
    see: '/',
  });
});

// ---------------------------------------------------------------
// Start
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lead Stampede MCP server listening on port ${PORT}`);
  console.log(`Health check:  GET  http://localhost:${PORT}/health`);
  console.log(`Tools list:    GET  http://localhost:${PORT}/mcp/tools`);
  console.log(`Tool call:     POST http://localhost:${PORT}/mcp/tools/:toolName`);
});
