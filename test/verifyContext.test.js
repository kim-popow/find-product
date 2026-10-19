'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { verifyContextToken } = require('../api/_lib/verifyContext');
const { config, signContext, getPublicKey, attacker } = require('./helpers');

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });

test('accepts a valid token and returns the verified claims', async () => {
  const ctx = await verifyContextToken(signContext(), config, getPublicKey);
  assert.equal(ctx.conversationId, 'conv_777');
  assert.equal(ctx.appuserId, 'user_42');
  assert.equal(ctx.appId, 'app_123');
});

test('rejects an expired token', async () => {
  const token = signContext({}, { expiresIn: -10 });
  await rejects(verifyContextToken(token, config, getPublicKey), 'token_expired');
});

test('rejects a token without exp', async () => {
  const token = signContext({}, { expiresIn: null });
  await rejects(verifyContextToken(token, config, getPublicKey), 'invalid_token');
});

test('rejects a token signed with a different key (same kid)', async () => {
  const token = signContext({}, { key: attacker.privateKey });
  await rejects(verifyContextToken(token, config, getPublicKey), 'invalid_token');
});

test('rejects an unknown kid', async () => {
  const token = signContext({}, { kid: 'other' });
  await rejects(verifyContextToken(token, config, getPublicKey), 'invalid_token');
});

test('rejects tokens from another Zendesk subdomain without fetching keys', async () => {
  let fetched = false;
  const spy = async () => {
    fetched = true;
    throw new Error('should not be called');
  };
  const token = signContext({ subdomain: 'evil' });
  await rejects(verifyContextToken(token, config, spy), 'untrusted_subdomain');
  assert.equal(fetched, false);
});

test('rejects tokens from another application', async () => {
  const token = signContext({ appId: 'app_other' });
  await rejects(verifyContextToken(token, config, getPublicKey), 'untrusted_app');
});

test('rejects tokens for a non-allowed integration when a list is configured', async () => {
  const cfg = { ...config, allowedIntegrationIds: ['int_allowed'] };
  await rejects(verifyContextToken(signContext(), cfg, getPublicKey), 'untrusted_integration');
  const ok = await verifyContextToken(signContext({ integrationId: 'int_allowed' }), cfg, getPublicKey);
  assert.equal(ok.integrationId, 'int_allowed');
});

test('rejects verified tokens that do not identify a conversation', async () => {
  const token = signContext({ conversationId: undefined });
  await rejects(verifyContextToken(token, config, getPublicKey), 'invalid_claims');
});

test('rejects HS256 / unsigned tokens (algorithm confusion)', async () => {
  const hs = jwt.sign({ subdomain: 'acme', appId: 'app_123' }, 'secret', {
    algorithm: 'HS256',
    keyid: 'kid-1',
    expiresIn: 60,
  });
  await rejects(verifyContextToken(hs, config, getPublicKey), 'invalid_token');
  const none = jwt.sign({ subdomain: 'acme', appId: 'app_123' }, '', { algorithm: 'none' });
  await rejects(verifyContextToken(none, config, getPublicKey), 'invalid_token');
});

test('accepts the real-world claim name appUserId', async () => {
  const token = signContext({ appuserId: undefined, appUserId: 'user_42' });
  const ctx = await verifyContextToken(token, config, getPublicKey);
  assert.equal(ctx.appuserId, 'user_42');
});

test('rejects garbage', async () => {
  await rejects(verifyContextToken('not-a-jwt', config, getPublicKey), 'invalid_token');
  await rejects(verifyContextToken(undefined, config, getPublicKey), 'token_missing');
  await rejects(verifyContextToken('', config, getPublicKey), 'token_missing');
  await rejects(verifyContextToken(12345, config, getPublicKey), 'invalid_token');
});
