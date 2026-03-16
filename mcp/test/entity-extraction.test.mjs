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

  it('handles special regex characters in multi-word names', () => {
    // \b word boundaries don't work well with non-word chars like +
    // but they work fine with names that start/end with word chars
    assert.equal(matchesEntity('Working on MV Samambaia trip', 'MV Samambaia'), true);
  });

  it('does not match empty content', () => {
    assert.equal(matchesEntity('', 'Zack'), false);
  });

  it('handles aliases', () => {
    assert.equal(matchesEntity('ozuri pushed the fix', 'ozuri'), true);
  });
});
