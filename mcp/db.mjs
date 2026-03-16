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
