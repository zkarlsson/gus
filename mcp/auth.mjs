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
