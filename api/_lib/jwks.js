'use strict';

// Minimal JWKS client for Zendesk's Webview SDK context tokens.
//
// Deliberately dependency-free (global fetch + node:crypto). The previous
// implementation used `jwks-rsa@4`, which depends on the ESM-only `jose@6`;
// `require()`-ing that crashes the whole function at load time on Node
// runtimes older than 20.19 / 22.12 (FUNCTION_INVOCATION_FAILED).
//
// Contract: this module never throws a non-HttpError for expected situations
// (network failure, bad JSON, empty key set, unknown kid). Callers map those
// to 4xx/5xx JSON responses instead of crashing.

const crypto = require('crypto');
const { HttpError } = require('./errors');

const CACHE_TTL_MS = 60 * 60 * 1000; // keep keys for 1h
const MIN_REFETCH_MS = 15 * 1000; // Zendesk limits the endpoint to 5 req/min
const FETCH_TIMEOUT_MS = 5000;

// subdomain -> { keys: Map<kid, KeyObject>, fetchedAt: number, pending: Promise|null }
const caches = new Map();

async function fetchKeys(subdomain, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`https://${subdomain}.zendesk.com/.well-known/jwks.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[jwks] fetch failed:', err && err.message);
    throw new HttpError(502, 'jwks_unreachable', 'Could not reach Zendesk to verify the token.');
  }

  if (!res.ok) {
    console.error('[jwks] unexpected status:', res.status);
    throw new HttpError(
      res.status === 429 ? 503 : 502,
      'jwks_unavailable',
      'Zendesk signing keys are temporarily unavailable.'
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new HttpError(502, 'jwks_unavailable', 'Zendesk returned invalid signing keys.');
  }

  const keys = new Map();
  const list = data && Array.isArray(data.keys) ? data.keys : [];
  for (const jwk of list) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (_) {
      // skip a malformed key, keep the others
    }
  }
  return keys;
}

async function refresh(subdomain, entry, fetchImpl) {
  if (entry.pending) return entry.pending; // de-duplicate concurrent refreshes
  entry.pending = (async () => {
    try {
      const keys = await fetchKeys(subdomain, fetchImpl);
      entry.fetchedAt = Date.now();
      // An empty set (Zendesk had no keys published yet) must not replace
      // good cached keys.
      if (keys.size > 0 || entry.keys.size === 0) entry.keys = keys;
    } finally {
      entry.pending = null;
    }
  })();
  return entry.pending;
}

/**
 * Resolves the RSA public key (KeyObject) for `kid` from the JWKS of `subdomain`.
 * @throws {HttpError} 401 unknown key, 502/503 upstream problems
 */
async function getPublicKey(subdomain, kid, fetchImpl = globalThis.fetch) {
  let entry = caches.get(subdomain);
  if (!entry) {
    entry = { keys: new Map(), fetchedAt: 0, pending: null };
    caches.set(subdomain, entry);
  }

  const age = Date.now() - entry.fetchedAt;
  const fresh = entry.fetchedAt > 0 && age < CACHE_TTL_MS;

  if (fresh && entry.keys.has(kid)) return entry.keys.get(kid);

  // Refresh when the cache is stale/empty, or the kid is unknown (key rotation),
  // but never more often than MIN_REFETCH_MS.
  if (!entry.fetchedAt || age >= MIN_REFETCH_MS) {
    try {
      await refresh(subdomain, entry, fetchImpl);
    } catch (err) {
      // Upstream trouble: fall back to a previously cached key when we have it.
      if (entry.keys.has(kid)) return entry.keys.get(kid);
      throw err;
    }
  }

  if (entry.keys.has(kid)) return entry.keys.get(kid);

  if (entry.keys.size === 0) {
    throw new HttpError(503, 'jwks_empty', 'Zendesk has no signing keys available right now.');
  }
  throw new HttpError(401, 'invalid_token', 'Unknown signing key.');
}

function clearCache() {
  caches.clear();
}

module.exports = { getPublicKey, clearCache };
