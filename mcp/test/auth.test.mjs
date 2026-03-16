import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
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
