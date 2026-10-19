'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { getPublicKey, clearCache } = require('../api/_lib/jwks');
const { verifyContextToken } = require('../api/_lib/verifyContext');
const { config, signContext, trusted } = require('./helpers');

const jwkOf = (pem, kid) => ({
  ...crypto.createPublicKey(pem).export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

test.beforeEach(() => clearCache());

test('resolves a key from the JWKS and verifies a token with it', async () => {
  const fetchImpl = async () => jsonResponse({ keys: [jwkOf(trusted.publicKey, 'kid-1')] });
  const resolver = (subdomain, kid) => getPublicKey(subdomain, kid, fetchImpl);
  const ctx = await verifyContextToken(signContext(), config, resolver);
  assert.equal(ctx.conversationId, 'conv_777');
});

test('caches keys: a second lookup does not hit the network', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ keys: [jwkOf(trusted.publicKey, 'kid-1')] });
  };
  await getPublicKey('acme', 'kid-1', fetchImpl);
  await getPublicKey('acme', 'kid-1', fetchImpl);
  assert.equal(calls, 1);
});

test('an EMPTY key set is a 503 response, not a crash', async () => {
  const fetchImpl = async () => jsonResponse({ keys: [] });
  await rejectsWith(getPublicKey('acme', 'kid-1', fetchImpl), 503, 'jwks_empty');
});

test('malformed JWKS bodies are handled', async () => {
  await rejectsWith(getPublicKey('acme', 'kid-1', async () => jsonResponse({})), 503, 'jwks_empty');
  clearCache();
  await rejectsWith(
    getPublicKey('acme', 'kid-1', async () => jsonResponse({ keys: [{ kty: 'RSA', kid: 'kid-1', n: '!' }] })),
    503,
    'jwks_empty'
  );
  clearCache();
  const badJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('bad json');
    },
  });
  await rejectsWith(getPublicKey('acme', 'kid-1', badJson), 502, 'jwks_unavailable');
});

test('an unknown kid is a 401', async () => {
  const fetchImpl = async () => jsonResponse({ keys: [jwkOf(trusted.publicKey, 'kid-1')] });
  await rejectsWith(getPublicKey('acme', 'other', fetchImpl), 401, 'invalid_token');
});

test('network failures and upstream errors map to 502/503', async () => {
  await rejectsWith(
    getPublicKey('acme', 'kid-1', async () => {
      throw new Error('ECONNRESET');
    }),
    502,
    'jwks_unreachable'
  );
  clearCache();
  await rejectsWith(getPublicKey('acme', 'kid-1', async () => jsonResponse({}, 500)), 502, 'jwks_unavailable');
  clearCache();
  await rejectsWith(getPublicKey('acme', 'kid-1', async () => jsonResponse({}, 429)), 503, 'jwks_unavailable');
});

test('upstream failures keep their status through token verification', async () => {
  const fetchImpl = async () => jsonResponse({ keys: [] });
  const resolver = (subdomain, kid) => getPublicKey(subdomain, kid, fetchImpl);
  await rejectsWith(verifyContextToken(signContext(), config, resolver), 503, 'jwks_empty');
});
