# Shared Memory MCP Server

**Date**: 2026-03-16
**Status**: Draft
**Authors**: Zack, with input from Derek

## Problem

OpenClaw on gus has a semantic memory system (PG 18 + pgvector + OpenAI embeddings) that stores cross-session knowledge. Claude Code has a separate flat-file memory system with no semantic search and no cross-project recall. Zack and Derek both want unified memory accessible from Claude Code sessions on any project, while ensuring personal/sensitive memories from OpenClaw never leak into Anthropic's API.

## Solution

An MCP server running on gus alongside OpenClaw, exposing the existing `openclaw` PostgreSQL memory database to Claude Code over HTTPS. The server provides hybrid semantic + keyword search, two-tier memory persistence (pinned and managed), per-user auth with bearer tokens, and privacy controls that keep OpenClaw-sourced personal memories off the wire.

## Architecture

```
┌─────────────────────┐     HTTPS + Bearer Token
│  Claude Code (Zack) │──────────────────────┐
└─────────────────────┘                      │
┌─────────────────────┐                      ▼
│ Claude Code (Derek) │───────►  Caddy (gus.giantsofoakland.com/mcp)
└─────────────────────┘                      │
┌─────────────────────┐                      ▼
│   OpenClaw (Gus)    │───────►  MCP Server (localhost:18790)
└─────────────────────┘                      │
                                             ▼
                                   PostgreSQL (openclaw db)
                                   pgvector + pg_trgm
```

- **MCP server**: Node.js, systemd service, localhost:18790
- **Caddy**: reverse-proxies `gus.giantsofoakland.com/mcp/*` → localhost:18790, terminates TLS
- **Auth**: per-user bearer tokens mapped to user identity via `/etc/openclaw/mcp-tokens.json`
- **DB**: existing `openclaw` database with schema additions

## Schema Changes

Three new columns on the existing `memories` table. The `source`, `content`, `context`, `tags`, `embedding`, `created_at`, and `updated_at` columns already exist.

```sql
ALTER TABLE memories ADD COLUMN pinned BOOLEAN DEFAULT false;
ALTER TABLE memories ADD COLUMN sensitivity TEXT DEFAULT 'private';
ALTER TABLE memories ADD COLUMN audience TEXT[] DEFAULT '{}';
```

No new tables. No changes to `entities`, `memory_entities`, or `conversations`.

### Sensitivity Levels

| Level | Meaning | Visible to MCP clients |
|-------|---------|----------------------|
| `private` | Personal, stays on gus | No (default for OpenClaw) |
| `shared` | Explicitly shared | Yes |
| `technical` | Project facts, architecture | Yes |

### Audience Rules

Audience is an explicit override that takes precedence over sensitivity. Setting a specific audience on a `private` memory is an intentional act that grants access to those identifiers — this is by design, not a loophole.

- `{}` (empty) — follows sensitivity level rules only
- `{'claude-code:zack', 'openclaw:derek'}` — those specific clients can see it, regardless of sensitivity
- `{'*'}` — visible to everyone regardless of sensitivity

### Defaults by Source

| Source | Sensitivity | Audience | Rationale |
|--------|------------|----------|-----------|
| OpenClaw conversations | `private` | `{}` | Stays on gus unless explicitly shared |
| `memory_pin` (Claude Code) | `shared` | `{}` | Explicit save = implicit consent to share |
| `memory_save` (Claude Code) | `technical` | `{}` | LLM-managed, assumed project-relevant |

### MCP Server Visibility Filter

```sql
WHERE (
  sensitivity IN ('shared', 'technical')
  OR '*' = ANY(audience)
  OR $user_identifier = ANY(audience)
)
```

Note: audience intentionally overrides sensitivity. A `private` memory with `audience = '{claude-code:zack}'` is visible to Zack's Claude Code — this requires someone to explicitly set that audience, either through OpenClaw or direct DB access.

### Consolidation Script Change

Add to the existing daily consolidation query:

```sql
AND NOT pinned
```

Pinned memories are never summarized or compressed.

## MCP Tools

### `memory_search`

Hybrid semantic + keyword search across visible memories.

**Input**:
- `query` (string, required) — search text
- `limit` (number, optional, default 5) — max results
- `tags` (string[], optional) — filter by tags
- `entity` (string, optional) — filter by linked entity name

**Behavior**: generates embedding for query, runs hybrid search (cosine similarity + trigram) filtered by user visibility rules.

**Returns**: array of `{ content, tags, source, similarity, created_at }`

### `memory_pin`

Save an explicit, permanent memory. Never consolidated or compressed.

**Input**:
- `content` (string, required) — the memory
- `tags` (string[], optional) — additional tags

**Behavior**: generates embedding via OpenAI, extracts entities by querying `entities` table, saves with `pinned: true`, `sensitivity: 'shared'`, `source: 'claude-code:<user>'`.

**Returns**: `{ id, created_at }`

### `memory_save`

Save an LLM-managed memory. Subject to daily consolidation.

**Input**:
- `content` (string, required) — the memory
- `tags` (string[], optional) — additional tags

**Behavior**: same as `memory_pin` but with `pinned: false`, `sensitivity: 'technical'`.

**Returns**: `{ id, created_at }`

### `entity_search`

Browse known entities. Read-only.

**Input**:
- `type` (string, optional) — filter by type (`person`, `project`, `infrastructure`)
- `name` (string, optional) — fuzzy name search

**Returns**: array of `{ name, type, aliases, notes }`

## Authentication

- Token file: `/etc/openclaw/mcp-tokens.json`
- Format:
  ```json
  {
    "tokens": {
      "a1b2c3...": { "user": "zack", "identifier": "claude-code:zack" },
      "d4e5f6...": { "user": "derek", "identifier": "claude-code:derek" }
    }
  }
  ```
- Tokens are generated as random 256-bit hex strings
- Server validates `Authorization: Bearer <token>` on every request
- Invalid/missing token → 401
- User identity from token flows into source tagging and visibility filtering
- Token file is re-read on `SIGHUP` — to revoke or rotate a token, update the file and `kill -HUP <pid>` (no restart required)

## Entity Extraction

Server-side, dynamic — no hardcoded entity lists.

When saving a memory (`memory_pin` or `memory_save`):
1. Query all entities from `entities` table
2. Regex match entity names and aliases against the memory content
3. Auto-link matches via `memory_entities` junction table
4. Auto-generate tags (`person:<name>`, `project:<name>`)

This replaces the hardcoded `KNOWN_PEOPLE` / `KNOWN_PROJECTS` arrays in the existing OpenClaw scripts.

**Scaling note**: the entity table is currently ~19 rows and expected to stay small (dozens, not thousands). If it grows significantly, cache entities in memory and refresh on a timer or SIGHUP.

**Deduplication**: out of scope for v1. Near-duplicate detection (e.g., cosine similarity > 0.95 against recent memories) is a future enhancement.

## Deployment

### MCP Server

- Node.js, `@modelcontextprotocol/sdk` for protocol handling
- Streamable HTTP transport (current MCP spec standard for remote servers)
- Connects to PG via unix socket as the `openclaw` OS user (peer auth, no password needed)
- `OPENAI_API_KEY` must be added to `/home/openclaw/.openclaw/env` if not already present — required for embedding generation
- If the OpenAI API call fails (429, quota, network), the save operation fails and returns an error to the client. Memories are never stored without embeddings.
- Systemd service: `openclaw-mcp.service`
  - `User=openclaw`, `Group=openclaw`
  - `NoNewPrivileges=true`, `ProtectSystem=strict`
  - `ReadWritePaths=/home/openclaw`
  - `EnvironmentFile=/home/openclaw/.openclaw/env`

### Caddy — Full Resulting Caddyfile

The existing catch-all `reverse_proxy` must be wrapped in a `handle` block. The complete Caddyfile becomes:

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

The `/mcp/*` block must come first so the more-specific route matches before the catch-all.

### Claude Code Client Config

Each user adds to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "shared-memory": {
      "type": "http",
      "url": "https://gus.giantsofoakland.com/mcp",
      "headers": {
        "Authorization": "Bearer <user-token>"
      }
    }
  }
}
```

## Privacy Guarantees

1. OpenClaw-sourced memories default to `sensitivity: 'private'` — they never leave gus unless someone explicitly sets audience or changes sensitivity
2. The MCP server enforces visibility filtering server-side — Claude Code cannot request private memories (unless explicitly granted via audience)
3. Embeddings are generated on gus via OpenAI — memory content is sent to OpenAI for embedding but never to Anthropic unless it passes the visibility filter
4. Bearer tokens never leave the user's local machine (stored in `~/.claude/mcp.json`)
5. PG only listens on localhost via unix socket — no direct database access from outside gus

## Rate Limiting

Out of scope for v1. The server is behind Caddy (which can add rate limiting later) and is only accessible to authenticated users with bearer tokens. OpenAI embedding costs are minimal at current usage levels (~$0.02 per 1M tokens with text-embedding-3-small). Monitor usage and add limits if needed.

## File Inventory

| File | Location | Purpose |
|------|----------|---------|
| `mcp-server.mjs` | `/home/openclaw/mcp/` | MCP server entry point |
| `package.json` | `/home/openclaw/mcp/` | Dependencies |
| `openclaw-mcp.service` | `/etc/systemd/system/` | Systemd unit |
| `mcp-tokens.json` | `/etc/openclaw/` | Token → user mapping |
| Caddyfile | `/etc/caddy/Caddyfile` | Full replacement with /mcp route |
| Consolidation patch | Existing script | Add `AND NOT pinned` guard |
| Schema migration | One-time SQL | Add `pinned`, `sensitivity`, `audience` columns |
