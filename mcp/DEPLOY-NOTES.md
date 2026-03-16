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
