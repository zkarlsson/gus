// MCP tool handler implementations
import { pool, getEmbedding, extractAndLinkEntities } from './db.mjs';

export async function memorySearch(args, userIdentifier) {
  const { query, limit = 5, tags, entity } = args;

  const queryEmbedding = await getEmbedding(query);
  const vecLiteral = `[${queryEmbedding.join(',')}]`;

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
