# Lead Stampede MCP Server

The live backend that powers Lead Stampede Agent Cards. Exposes SMB business
data as tools that AI agents can call over HTTP.

## What this is

An Express server that implements four MCP tools:

| Tool | What it returns |
| --- | --- |
| `get_business_profile` | Name, description, industry, service area, contact info |
| `get_services` | List of services + pricing summary |
| `get_availability` | Hours + booking URL (or phone/email fallback) |
| `get_reviews` | Review count, average rating, summary |

Each request is authenticated via an `X-Agency-API-Key` header that maps to a
row in the `agencies` table in Supabase. Clients are scoped to their agency,
so one agency can never read another's data.

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env` and fill in:

- `SUPABASE_URL` — your project URL (e.g. `https://xlhxnlhxeprtzwbyepza.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Project Settings → API → `service_role` secret
- `PORT` — defaults to 3000

**Never commit `.env` to git.** It's already in `.gitignore`.

### 3. Run locally

```bash
npm run dev
```

You should see:

```
Lead Stampede MCP server listening on port 3000
```

## Testing it works

### Health check (no auth)

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

### List available tools (auth required)

```bash
curl -H "X-Agency-API-Key: YOUR_AGENCY_API_KEY" \
  http://localhost:3000/mcp/tools
```

### Call a tool

```bash
curl -X POST \
  -H "X-Agency-API-Key: YOUR_AGENCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"arguments":{"client_slug":"grandinetti-molinar-law"}}' \
  http://localhost:3000/mcp/tools/get_business_profile
```

Expected response:

```json
{
  "tool": "get_business_profile",
  "result": {
    "business_name": "Grandinetti & Molinar Law",
    "description": "Austin-based law firm founded in 2002...",
    "industry": "legal",
    ...
  },
  "response_ms": 42
}
```

## Deploying to Railway

1. Push this folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Select this repo.
4. Under **Variables**, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Railway auto-detects Node.js, installs deps, and runs `npm start`.
6. Once deployed, Railway gives you a public URL like `mcp-production.up.railway.app`.
7. Point a custom subdomain (e.g. `mcp.leadstampede.io`) at it via Railway → Settings → Domains.

## Architecture

```
AI agent  →  POST /mcp/tools/:name  →  auth.js → tools.js → supabase.js
                                         ↓
                                   analytics.js (fire-and-forget)
                                         ↓
                                   mcp_tool_calls table
```

## Next steps

- Build the Cloudflare Worker that serves Agent Cards at `agentcards.leadstampede.io/{slug}`.
- Build the onboarding form that populates `clients` rows in Supabase.
- Build the agency portal dashboard.
