import { describe, it, before, after } from 'node:test';
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
