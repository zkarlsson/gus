# Shared Memory MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an MCP server on gus that exposes the existing OpenClaw pgvector memory database to Claude Code over HTTPS with per-user auth and privacy controls.

**Architecture:** Node.js MCP server using `@modelcontextprotocol/sdk` with Streamable HTTP transport, running as a systemd service on gus behind Caddy reverse proxy. Connects to existing `openclaw` PG database via unix socket. OpenAI embeddings generated server-side. Per-request user identity tracked via `AsyncLocalStorage`.

**Tech Stack:** Node.js 24, `@modelcontextprotocol/sdk@1.27.1`, `pg@8.20.0`, PostgreSQL 18 (pgvector, pg_trgm), Caddy, systemd

**Spec:** `docs/superpowers/specs/2026-03-16-shared-memory-mcp-design.md`

---

## Nelson Suitability

Tasks 1-3 are sequential (schema → server → tests). Tasks 4-8 are all independent deployment artifacts that can run in parallel after Task 1. Task 9 (deploy) depends on everything else.

```
Task 1 (schema) ──► Task 2 (server) ──► Task 3 (tests)
Task 1 (schema) ──► Task 4 (systemd)     ┐
                    Task 5 (Caddyfile)    │
                    Task 6 (tokens)       ├──► Task 9 (deploy)
                    Task 7 (consolidation)│
                    Task 8 (client config)┘
```

**Parallel group (Nelson squadron):** Tasks 4, 5, 6, 7, 8 can all run simultaneously.

---

## File Structure

```
mcp/
├── mcp-server.mjs          # HTTP server, MCP setup, request routing
├── auth.mjs                 # Token loading, validation, SIGHUP reload (exported for testing)
├── db.mjs                   # PG pool, embedding helper, entity extraction
├── tools.mjs                # Tool handler implementations (search, pin, save, entity_search)
├── package.json
├── .gitignore
├── generate-tokens.sh       # One-time token generation script
├── openclaw-mcp.service     # Systemd unit file
├── claude-mcp-config.example.json
├── DEPLOY-NOTES.md
├── migrations/
│   └── 001-add-memory-columns.sql
└── test/
    ├── auth.test.mjs
    ├── entity-extraction.test.mjs
    └── visibility-filter.test.mjs
```

---

## Chunk 1: Schema + Core Server

### Task 1: Schema Migration

**Files:**
- Create: `mcp/migrations/001-add-memory-columns.sql`

This migration runs against the live `openclaw` database on gus via SSH.

- [ ] **Step 1: Write the migration SQL**

```sql
-- mcp/migrations/001-add-memory-columns.sql
-- Add privacy and pinning columns to existing memories table
-- Safe to run multiple times (IF NOT EXISTS / idempotent)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'pinned'
  ) THEN
    ALTER TABLE memories ADD COLUMN pinned BOOLEAN DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'sensitivity'
  ) THEN
    ALTER TABLE memories ADD COLUMN sensitivity TEXT DEFAULT 'private';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'audience'
  ) THEN
    ALTER TABLE memories ADD COLUMN audience TEXT[] DEFAULT '{}';
  END IF;
END $$;
```

- [ ] **Step 2: Run the migration on gus**

```bash
ssh gus "sudo -u openclaw psql -d openclaw -f -" < mcp/migrations/001-add-memory-columns.sql
```

Expected: no errors, silent success.

- [ ] **Step 3: Verify columns exist**

```bash
ssh gus "sudo -u openclaw psql -d openclaw -c '\d memories'"
```

Expected: `pinned`, `sensitivity`, `audience` columns visible in output.

- [ ] **Step 4: Verify existing data unaffected**

```bash
ssh gus "sudo -u openclaw psql -d openclaw -c 'SELECT id, pinned, sensitivity, audience FROM memories LIMIT 3'"
```

Expected: existing rows have `pinned=false`, `sensitivity='private'`, `audience='{}'`.

- [ ] **Step 5: Commit**

```bash
git add mcp/migrations/001-add-memory-columns.sql
git commit -m "feat: schema migration for memory privacy and pinning columns"
```

---

### Task 2: MCP Server Core

**Files:**
- Create: `mcp/package.json`
- Create: `mcp/auth.mjs`
- Create: `mcp/db.mjs`
- Create: `mcp/tools.mjs`
- Create: `mcp/mcp-server.mjs`
- Create: `mcp/.gitignore`

The server lives in `mcp/` within the gus repo. It will be deployed to `/home/openclaw/mcp/` on gus.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "openclaw-mcp-memory",
  "version": "1.0.0",
  "type": "module",
  "description": "MCP server bridging Claude Code to OpenClaw's pgvector memory system",
  "main": "mcp-server.mjs",
  "scripts": {
    "start": "node mcp-server.mjs",
    "test": "node --test test/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "pg": "^8.20.0"
  }
}
```

Create `mcp/.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Write auth.mjs**

```javascript
// mcp/auth.mjs
// Token auth — exported for testability
import { readFileSync } from 'fs';

let tokenMap = {};

export function loadTokens(tokenFile) {
  try {
    const data = JSON.parse(readFileSync(tokenFile, 'utf-8'));
    tokenMap = data.tokens || {};
    console.log(`Loaded ${Object.keys(tokenMap).length} token(s) from ${tokenFile}`);
    return tokenMap;
  } catch (err) {
    console.error(`Failed to load tokens: ${err.message}`);
    throw err;
  }
}

export function authenticateRequest(req) {
  const auth = req.headers?.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return tokenMap[token] || null;
}

export function getTokenMap() {
  return tokenMap;
}
```

- [ ] **Step 3: Write db.mjs**

```javascript
// mcp/db.mjs
// Database pool, OpenAI embeddings, entity extraction
import { Pool } from 'pg';
import https from 'https';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';

export const pool = new Pool({
  user: 'openclaw',
  database: 'openclaw',
  host: process.env.PGHOST || '/var/run/postgresql',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
});

export function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.data[0].embedding);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export async function extractAndLinkEntities(memoryId, content) {
  const { rows: entities } = await pool.query(
    'SELECT id, name, type, aliases FROM entities'
  );

  const matched = [];
  for (const entity of entities) {
    const names = [entity.name, ...(entity.aliases || [])];
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(content)) {
        matched.push(entity);
        break;
      }
    }
  }

  for (const entity of matched) {
    await pool.query(
      `INSERT INTO memory_entities (memory_id, entity_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [memoryId, entity.id]
    );
  }

  return matched.map(e => `${e.type}:${e.name.toLowerCase()}`);
}
```

- [ ] **Step 4: Write tools.mjs**

```javascript
// mcp/tools.mjs
// MCP tool handler implementations
import { pool, getEmbedding, extractAndLinkEntities } from './db.mjs';

export async function memorySearch(args, userIdentifier) {
  const { query, limit = 5, tags, entity } = args;

  const queryEmbedding = await getEmbedding(query);
  const vecLiteral = `[${queryEmbedding.join(',')}]`;

  // Build optional filter conditions for the outer WHERE
  const filterConditions = [];
  const params = [vecLiteral, userIdentifier, query];

  if (tags?.length) {
    params.push(tags);
    filterConditions.push(`tags @> $${params.length}`);
  }

  if (entity) {
    params.push(`%${entity}%`);
    filterConditions.push(`id IN (
      SELECT me.memory_id FROM memory_entities me
      JOIN entities e ON e.id = me.entity_id
      WHERE e.name ILIKE $${params.length}
    )`);
  }

  const filterWhere = filterConditions.length
    ? `WHERE ${filterConditions.join(' AND ')}`
    : '';

  params.push(limit);

  const sql = `
    WITH semantic AS (
      SELECT m.id, m.content, m.tags, m.source, m.created_at,
             1 - (m.embedding <=> $1::vector) as semantic_score,
             0::real as keyword_score
      FROM memories m
      WHERE m.embedding IS NOT NULL
        AND (
          m.sensitivity IN ('shared', 'technical')
          OR '*' = ANY(m.audience)
          OR $2 = ANY(m.audience)
        )
    ),
    keyword AS (
      SELECT m.id, m.content, m.tags, m.source, m.created_at,
             0::real as semantic_score,
             similarity(m.content, $3) as keyword_score
      FROM memories m
      WHERE m.content % $3
        AND (
          m.sensitivity IN ('shared', 'technical')
          OR '*' = ANY(m.audience)
          OR $2 = ANY(m.audience)
        )
    ),
    combined AS (
      SELECT * FROM semantic
      UNION ALL
      SELECT * FROM keyword
    ),
    scored AS (
      SELECT id, content, tags, source, created_at,
             MAX(semantic_score) as semantic_score,
             MAX(keyword_score) as keyword_score,
             GREATEST(MAX(semantic_score), MAX(keyword_score) * 0.8) as score
      FROM combined
      GROUP BY id, content, tags, source, created_at
    )
    SELECT * FROM scored
    ${filterWhere}
    ORDER BY score DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({
    content: r.content,
    tags: r.tags,
    source: r.source,
    similarity: parseFloat(r.score?.toFixed(3) || '0'),
    created_at: r.created_at,
  }));
}

export async function memorySave(args, userIdentifier, pinned) {
  const { content, tags: extraTags = [] } = args;

  const embedding = await getEmbedding(content);
  const vecLiteral = `[${embedding.join(',')}]`;

  const sensitivity = pinned ? 'shared' : 'technical';
  const source = userIdentifier;

  const { rows } = await pool.query(
    `INSERT INTO memories (content, source, tags, embedding, pinned, sensitivity, audience)
     VALUES ($1, $2, $3, $4, $5, $6, '{}')
     RETURNING id, created_at`,
    [content, source, extraTags, vecLiteral, pinned, sensitivity]
  );

  const memoryId = rows[0].id;

  const entityTags = await extractAndLinkEntities(memoryId, content);

  if (entityTags.length) {
    const allTags = [...new Set([...extraTags, ...entityTags])];
    await pool.query(
      'UPDATE memories SET tags = $1 WHERE id = $2',
      [allTags, memoryId]
    );
  }

  return { id: memoryId, created_at: rows[0].created_at };
}

export async function entitySearch(args) {
  const { type, name } = args;
  const conditions = [];
  const params = [];

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  if (name) {
    params.push(`%${name}%`);
    conditions.push(`(name ILIKE $${params.length} OR $${params.length} ILIKE ANY(aliases))`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT name, type, aliases, notes FROM entities ${where} ORDER BY name`,
    params
  );

  return rows;
}
```

- [ ] **Step 5: Write mcp-server.mjs**

```javascript
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

export const requestContext = new AsyncLocalStorage();

export function getUserIdentifier() {
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
    const bodyStr = Buffer.concat(chunks).toString();
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;

    // Run MCP handler inside AsyncLocalStorage context
    await requestContext.run({ userIdentifier: user.identifier }, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    });
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
```

- [ ] **Step 6: Install dependencies locally to verify**

```bash
cd mcp && npm install
```

Expected: clean install, `node_modules` created.

- [ ] **Step 7: Verify the server starts (will fail on DB/tokens, that's expected)**

```bash
cd mcp && OPENAI_API_KEY=test TOKEN_FILE=/dev/null node mcp-server.mjs 2>&1 || true
```

Expected: fails on token load (no valid file). That's correct behavior — confirms startup sequence works up to auth init.

- [ ] **Step 8: Commit**

```bash
git add mcp/package.json mcp/.gitignore mcp/auth.mjs mcp/db.mjs mcp/tools.mjs mcp/mcp-server.mjs
git commit -m "feat: MCP server for shared memory with pgvector search and privacy controls"
```

---

### Task 3: Tests

**Files:**
- Create: `mcp/test/auth.test.mjs`
- Create: `mcp/test/entity-extraction.test.mjs`
- Create: `mcp/test/visibility-filter.test.mjs`

Tests use Node.js built-in test runner (`node --test`). Auth and entity tests are unit tests (no external deps). Visibility filter tests are integration tests against gus via SSH tunnel.

- [ ] **Step 1: Write auth tests**

```javascript
// mcp/test/auth.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTokens, authenticateRequest } from '../auth.mjs';

describe('auth', () => {
  const tmpFile = join(tmpdir(), 'mcp-test-tokens.json');
  const testTokens = {
    tokens: {
      'abc123': { user: 'zack', identifier: 'claude-code:zack' },
      'def456': { user: 'derek', identifier: 'claude-code:derek' },
    }
  };

  beforeEach(() => {
    writeFileSync(tmpFile, JSON.stringify(testTokens));
    loadTokens(tmpFile);
  });

  it('returns null for missing Authorization header', () => {
    const result = authenticateRequest({ headers: {} });
    assert.equal(result, null);
  });

  it('returns null for non-Bearer auth', () => {
    const result = authenticateRequest({ headers: { authorization: 'Basic abc' } });
    assert.equal(result, null);
  });

  it('returns null for unknown token', () => {
    const result = authenticateRequest({ headers: { authorization: 'Bearer unknown' } });
    assert.equal(result, null);
  });

  it('returns user for valid token', () => {
    const result = authenticateRequest({ headers: { authorization: 'Bearer abc123' } });
    assert.deepEqual(result, { user: 'zack', identifier: 'claude-code:zack' });
  });

  it('returns correct user for each token', () => {
    const zack = authenticateRequest({ headers: { authorization: 'Bearer abc123' } });
    const derek = authenticateRequest({ headers: { authorization: 'Bearer def456' } });
    assert.equal(zack.user, 'zack');
    assert.equal(derek.user, 'derek');
  });

  it('reloads tokens from file', () => {
    const newTokens = { tokens: { 'new789': { user: 'new', identifier: 'claude-code:new' } } };
    writeFileSync(tmpFile, JSON.stringify(newTokens));
    loadTokens(tmpFile);

    assert.equal(authenticateRequest({ headers: { authorization: 'Bearer abc123' } }), null);
    assert.equal(authenticateRequest({ headers: { authorization: 'Bearer new789' } }).user, 'new');
  });

  it('throws on missing token file', () => {
    assert.throws(() => loadTokens('/nonexistent/path.json'));
  });
});
```

- [ ] **Step 2: Run auth tests**

```bash
cd mcp && node --test test/auth.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Write entity extraction tests**

These test the regex matching logic in `extractAndLinkEntities`. Since that function hits the DB, we test the regex logic in isolation by extracting just the matching part, or by running against the live DB via tunnel.

```javascript
// mcp/test/entity-extraction.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the regex matching pattern used in db.mjs extractAndLinkEntities
function matchesEntity(content, entityName) {
  const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(content);
}

describe('entity matching', () => {
  it('matches exact name', () => {
    assert.equal(matchesEntity('Talked to Zack about the project', 'Zack'), true);
  });

  it('matches case-insensitively', () => {
    assert.equal(matchesEntity('talked to ZACK about it', 'Zack'), true);
  });

  it('does not match partial words', () => {
    assert.equal(matchesEntity('The seance was weird', 'Sean'), false);
  });

  it('matches at start of string', () => {
    assert.equal(matchesEntity('Zack deployed the server', 'Zack'), true);
  });

  it('matches at end of string', () => {
    assert.equal(matchesEntity('Deployed by Zack', 'Zack'), true);
  });

  it('handles names with spaces', () => {
    assert.equal(matchesEntity('Working on God Mode Games stuff', 'God Mode Games'), true);
  });

  it('handles special regex characters', () => {
    assert.equal(matchesEntity('Check the C++ code', 'C++'), true);
  });

  it('does not match empty content', () => {
    assert.equal(matchesEntity('', 'Zack'), false);
  });

  it('handles aliases', () => {
    // Aliases are just alternate names run through the same regex
    assert.equal(matchesEntity('ozuri pushed the fix', 'ozuri'), true);
  });
});
```

- [ ] **Step 4: Run entity tests**

```bash
cd mcp && node --test test/entity-extraction.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Write visibility filter integration tests**

These require an SSH tunnel to gus. They insert test data, query through the visibility filter SQL, and clean up.

```javascript
// mcp/test/visibility-filter.test.mjs
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

describe('visibility filter (integration)', () => {
  let pool;
  const testIds = [];

  before(() => {
    pool = new Pool({
      user: 'openclaw',
      database: 'openclaw',
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5433', 10),
    });
  });

  after(async () => {
    // Clean up test data
    if (testIds.length) {
      await pool.query('DELETE FROM memories WHERE id = ANY($1)', [testIds]);
    }
    await pool.end();
  });

  async function insertMemory(opts) {
    const { rows } = await pool.query(
      `INSERT INTO memories (content, source, sensitivity, audience, pinned, tags)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [opts.content, opts.source || 'test', opts.sensitivity, opts.audience || '{}',
       opts.pinned || false, opts.tags || '{}']
    );
    testIds.push(rows[0].id);
    return rows[0].id;
  }

  async function isVisible(memoryId, userIdentifier) {
    const { rows } = await pool.query(
      `SELECT id FROM memories
       WHERE id = $1 AND (
         sensitivity IN ('shared', 'technical')
         OR '*' = ANY(audience)
         OR $2 = ANY(audience)
       )`,
      [memoryId, userIdentifier]
    );
    return rows.length > 0;
  }

  it('excludes private memories with empty audience', async () => {
    const id = await insertMemory({
      content: 'private test memory',
      sensitivity: 'private',
      audience: '{}',
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), false);
  });

  it('includes shared memories', async () => {
    const id = await insertMemory({
      content: 'shared test memory',
      sensitivity: 'shared',
      audience: '{}',
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), true);
  });

  it('includes technical memories', async () => {
    const id = await insertMemory({
      content: 'technical test memory',
      sensitivity: 'technical',
      audience: '{}',
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), true);
  });

  it('audience override grants access to private memories for target user', async () => {
    const id = await insertMemory({
      content: 'private but audience-granted',
      sensitivity: 'private',
      audience: '{claude-code:zack}',
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), true);
    assert.equal(await isVisible(id, 'claude-code:derek'), false);
  });

  it('wildcard audience grants access to everyone', async () => {
    const id = await insertMemory({
      content: 'private with wildcard',
      sensitivity: 'private',
      audience: '{*}',
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), true);
    assert.equal(await isVisible(id, 'claude-code:derek'), true);
  });

  it('pinned shared memories are visible', async () => {
    const id = await insertMemory({
      content: 'pinned shared memory',
      sensitivity: 'shared',
      pinned: true,
    });
    assert.equal(await isVisible(id, 'claude-code:zack'), true);
  });
});
```

- [ ] **Step 6: Run integration tests (requires SSH tunnel)**

```bash
ssh -L 5433:localhost:5432 gus -N &
TUNNEL_PID=$!
cd mcp && PGHOST=localhost PGPORT=5433 node --test test/visibility-filter.test.mjs
kill $TUNNEL_PID
```

Expected: all pass.

- [ ] **Step 7: Run all tests**

```bash
ssh -L 5433:localhost:5432 gus -N &
TUNNEL_PID=$!
cd mcp && PGHOST=localhost PGPORT=5433 node --test test/
kill $TUNNEL_PID
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add mcp/test/
git commit -m "test: auth, entity extraction, and visibility filter tests"
```

---

## Chunk 2: Deployment Artifacts (Nelson-parallel)

These tasks are all independent and can be worked on simultaneously.

### Task 4: Systemd Service

**Files:**
- Create: `mcp/openclaw-mcp.service`

- [ ] **Step 1: Write the service file**

```ini
[Unit]
Description=OpenClaw Memory MCP Server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/home/openclaw/mcp
EnvironmentFile=/home/openclaw/.openclaw/env
ExecStart=/usr/bin/node /home/openclaw/mcp/mcp-server.mjs
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/openclaw
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add mcp/openclaw-mcp.service
git commit -m "feat: systemd service for MCP memory server"
```

---

### Task 5: Caddyfile Update

**Files:**
- Modify: `Caddyfile`

The repo's Caddyfile only has the gus block. The live Caddyfile on gus also has mantadua and prism blocks. This change only modifies the gus block — the live Caddyfile must be hand-merged during deploy (Task 9).

- [ ] **Step 1: Update the gus block in the repo Caddyfile**

Replace the current contents of `Caddyfile`:

```
gus.giantsofoakland.com {
    handle /mcp/* {
        reverse_proxy localhost:18790
    }
    handle {
        reverse_proxy localhost:18789
    }
}
```

Note: the live Caddyfile on gus has additional site blocks (mantadua, prism). During deployment, only the `gus.giantsofoakland.com` block needs updating. The other blocks stay as-is.

- [ ] **Step 2: Commit**

```bash
git add Caddyfile
git commit -m "feat: add /mcp reverse proxy route to Caddyfile"
```

---

### Task 6: Token Generation + Config

**Files:**
- Create: `mcp/generate-tokens.sh`

- [ ] **Step 1: Write token generation script**

```bash
#!/bin/bash
# Generate bearer tokens for MCP server users
# Run once, save output to /etc/openclaw/mcp-tokens.json on gus
set -euo pipefail

ZACK_TOKEN=$(openssl rand -hex 32)
DEREK_TOKEN=$(openssl rand -hex 32)

cat <<EOF
{
  "tokens": {
    "${ZACK_TOKEN}": { "user": "zack", "identifier": "claude-code:zack" },
    "${DEREK_TOKEN}": { "user": "derek", "identifier": "claude-code:derek" }
  }
}

--- Save the above JSON to /etc/openclaw/mcp-tokens.json on gus ---
--- Give each user their token for ~/.claude/mcp.json: ---

Zack's token: ${ZACK_TOKEN}
Derek's token: ${DEREK_TOKEN}
EOF
```

- [ ] **Step 2: Commit**

```bash
chmod +x mcp/generate-tokens.sh
git add mcp/generate-tokens.sh
git commit -m "feat: token generation script for MCP auth"
```

---

### Task 7: Consolidation Script Patch

**Files:**
- Create: `mcp/DEPLOY-NOTES.md`

The consolidation scripts live on gus at `/home/openclaw/.openclaw/workspace/scripts/memory-consolidate.mjs`. They are not in this repo.

- [ ] **Step 1: Create deployment notes**

```markdown
# Deployment Notes

## Consolidation Script Patch

In `/home/openclaw/.openclaw/workspace/scripts/memory-consolidate.mjs`,
update the `consolidateDay` function's query to exclude pinned memories:

Change:
```sql
SELECT id, content, tags, source FROM memories
WHERE DATE(created_at) = $1
  AND source != 'consolidated'
```

To:
```sql
SELECT id, content, tags, source FROM memories
WHERE DATE(created_at) = $1
  AND source != 'consolidated'
  AND NOT pinned
```

This prevents permanent/pinned memories from being summarized away.

## OPENAI_API_KEY

Ensure `OPENAI_API_KEY=<key>` is set in `/home/openclaw/.openclaw/env`.
The MCP server needs this for generating embeddings. The key may already
be present if OpenClaw's memory scripts use it.
```

- [ ] **Step 2: Commit**

```bash
git add mcp/DEPLOY-NOTES.md
git commit -m "docs: deployment notes for consolidation script patch and env setup"
```

---

### Task 8: Claude Code Client Config Template

**Files:**
- Create: `mcp/claude-mcp-config.example.json`

- [ ] **Step 1: Write the example config**

```json
{
  "mcpServers": {
    "shared-memory": {
      "type": "http",
      "url": "https://gus.giantsofoakland.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add mcp/claude-mcp-config.example.json
git commit -m "docs: example Claude Code MCP config for shared memory"
```

---

## Chunk 3: Deployment

### Task 9: Deploy to Gus

This task is manual/semi-automated. Run steps sequentially via SSH.

- [ ] **Step 1: Verify migration has been applied**

```bash
ssh gus "sudo -u openclaw psql -d openclaw -c 'SELECT pinned, sensitivity, audience FROM memories LIMIT 1'"
```

If the columns don't exist, run the migration first:

```bash
ssh gus "sudo -u openclaw psql -d openclaw -f -" < mcp/migrations/001-add-memory-columns.sql
```

- [ ] **Step 2: Copy MCP server files to gus**

```bash
rsync -avz --exclude node_modules mcp/ gus:/home/openclaw/mcp/
ssh gus "chown -R openclaw:openclaw /home/openclaw/mcp"
```

- [ ] **Step 3: Install dependencies on gus**

```bash
ssh gus "sudo -u openclaw bash -c 'cd /home/openclaw/mcp && npm install --production'"
```

- [ ] **Step 4: Add OPENAI_API_KEY to env file if missing**

```bash
ssh gus "grep -q OPENAI_API_KEY /home/openclaw/.openclaw/env && echo 'Key present' || echo 'MISSING — add OPENAI_API_KEY to /home/openclaw/.openclaw/env'"
```

Verify with Zack that the key is set — do NOT generate one.

- [ ] **Step 5: Generate and install tokens**

```bash
bash mcp/generate-tokens.sh
# Copy the JSON block, then:
ssh gus "sudo mkdir -p /etc/openclaw"
# Pipe or paste the JSON:
ssh gus "sudo tee /etc/openclaw/mcp-tokens.json > /dev/null" <<< '<paste JSON here>'
ssh gus "sudo chmod 640 /etc/openclaw/mcp-tokens.json && sudo chown openclaw:openclaw /etc/openclaw/mcp-tokens.json"
```

Save Zack's and Derek's tokens securely.

- [ ] **Step 6: Install systemd service**

```bash
ssh gus "sudo cp /home/openclaw/mcp/openclaw-mcp.service /etc/systemd/system/"
ssh gus "sudo systemctl daemon-reload && sudo systemctl enable openclaw-mcp"
```

- [ ] **Step 7: Update Caddyfile on gus**

The live Caddyfile has mantadua and prism blocks. Only update the gus block:

```bash
ssh gus "sudo nano /etc/caddy/Caddyfile"
```

Replace the `gus.giantsofoakland.com` block with the handle-based version from Task 5. Leave mantadua and prism blocks untouched. Then validate and reload:

```bash
ssh gus "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
```

- [ ] **Step 8: Patch consolidation script**

```bash
ssh gus "sudo -u openclaw nano /home/openclaw/.openclaw/workspace/scripts/memory-consolidate.mjs"
```

Add `AND NOT pinned` per DEPLOY-NOTES.md.

- [ ] **Step 9: Start the MCP service**

```bash
ssh gus "sudo systemctl start openclaw-mcp"
ssh gus "sudo systemctl status openclaw-mcp"
ssh gus "sudo journalctl -u openclaw-mcp --no-pager -n 20"
```

Expected: service running, listening on 127.0.0.1:18790.

- [ ] **Step 10: Smoke test via HTTPS**

```bash
# Health check (no auth)
curl -s https://gus.giantsofoakland.com/mcp/health

# Auth check (should 401)
curl -s -o /dev/null -w "%{http_code}" https://gus.giantsofoakland.com/mcp/mcp

# Search with valid token
curl -s -X POST https://gus.giantsofoakland.com/mcp/mcp \
  -H "Authorization: Bearer <zack-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Avalon architecture"}}}'
```

Expected: health returns `{"status":"ok"}`, unauthenticated returns 401, search returns results.

- [ ] **Step 11: Configure Claude Code locally**

```bash
cp mcp/claude-mcp-config.example.json ~/.claude/mcp.json
# Edit ~/.claude/mcp.json — replace YOUR_TOKEN_HERE with Zack's token
```

- [ ] **Step 12: Verify from Claude Code**

Start a new Claude Code session and invoke `memory_search` with a test query. Verify results come back from the shared memory pool.

- [ ] **Step 13: Commit any deployment fixes**

```bash
git add -A && git commit -m "fix: deployment adjustments from live testing"
```
