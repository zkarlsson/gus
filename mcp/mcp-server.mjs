#!/usr/bin/env node
/**
 * OpenClaw Memory MCP Server
 *
 * Exposes the shared pgvector memory database to Claude Code
 * via MCP over Streamable HTTP with per-user bearer token auth.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { z } from 'zod';

import { loadTokens, authenticateRequest } from './auth.mjs';
import { pool } from './db.mjs';
import { memorySearch, memorySave, entitySearch } from './tools.mjs';

// ============================================
// Config
// ============================================

const PORT = parseInt(process.env.MCP_PORT || '18790', 10);
const TOKEN_FILE = process.env.TOKEN_FILE || '/etc/openclaw/mcp-tokens.json';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

// ============================================
// Request-scoped user context
// ============================================

const requestContext = new AsyncLocalStorage();

function getUserIdentifier() {
  const store = requestContext.getStore();
  if (!store?.userIdentifier) {
    throw new Error('No user context — request not authenticated');
  }
  return store.userIdentifier;
}

// ============================================
// Token loading
// ============================================

loadTokens(TOKEN_FILE);
process.on('SIGHUP', () => {
  console.log('SIGHUP received, reloading tokens...');
  try { loadTokens(TOKEN_FILE); } catch { /* already logged */ }
});

// ============================================
// MCP Server + Tools
// ============================================

const mcpServer = new McpServer({
  name: 'openclaw-memory',
  version: '1.0.0',
});

mcpServer.tool(
  'memory_search',
  'Search shared memory using hybrid semantic + keyword search. Returns memories visible to the current user based on privacy controls.',
  {
    query: z.string().describe('Search query text'),
    limit: z.number().optional().default(5).describe('Max results (default 5)'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    entity: z.string().optional().describe('Filter by linked entity name'),
  },
  async (args) => {
    const results = await memorySearch(args, getUserIdentifier());
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

mcpServer.tool(
  'memory_pin',
  'Save a permanent memory that will never be consolidated or compressed. Use when the user explicitly asks to remember something.',
  {
    content: z.string().describe('The memory content to save'),
    tags: z.array(z.string()).optional().default([]).describe('Additional tags'),
  },
  async (args) => {
    const result = await memorySave(args, getUserIdentifier(), true);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

mcpServer.tool(
  'memory_save',
  'Save a managed memory for significant technical decisions, architectural insights, or project context. Subject to daily consolidation. Use automatically when encountering information worth preserving across sessions.',
  {
    content: z.string().describe('The memory content to save'),
    tags: z.array(z.string()).optional().default([]).describe('Additional tags'),
  },
  async (args) => {
    const result = await memorySave(args, getUserIdentifier(), false);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

mcpServer.tool(
  'entity_search',
  'Browse known entities (people, projects, infrastructure). Read-only.',
  {
    type: z.string().optional().describe('Filter by type: person, project, infrastructure'),
    name: z.string().optional().describe('Fuzzy name search'),
  },
  async (args) => {
    const results = await entitySearch(args);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

// ============================================
// HTTP Server with auth + body parsing
// ============================================

const httpServer = createServer((req, res) => {
  const url = req.url.replace(/^\/mcp/, '') || '/';

  // Health check (no auth required)
  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    return;
  }

  // Auth check
  const user = authenticateRequest(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Buffer request body (Node.js http doesn't populate req.body)
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const bodyStr = Buffer.concat(chunks).toString();
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;

      await requestContext.run({ userIdentifier: user.identifier }, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      console.error('Request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenClaw Memory MCP server listening on 127.0.0.1:${PORT}`);
});

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down...`);
    httpServer.close();
    await pool.end();
    process.exit(0);
  });
}
