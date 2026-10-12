'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const config = {
  subdomain: 'acme',
  appId: 'app_123',
  keyId: 'app_key',
  secret: 'app_secret',
  allowedIntegrationIds: [],
};

function makeKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const trusted = makeKeyPair();
const attacker = makeKeyPair();

/** Signs a token shaped like the one returned by WebviewSdk.getContext. */
function signContext(overrides = {}, { key = trusted.privateKey, kid = 'kid-1', expiresIn = 300 } = {}) {
  const claims = {
    appuserId: 'user_42',
    subdomain: 'acme',
    appId: 'app_123',
    integrationId: 'int_1',
    conversationId: 'conv_777',
    messageId: 'msg_1',
    messageMetadata: {},
    ...overrides,
  };
  const options = { algorithm: 'RS256', keyid: kid };
  if (expiresIn !== null) options.expiresIn = expiresIn;
  return jwt.sign(claims, key, options);
}

/** Stand-in for the JWKS lookup: only `kid-1` resolves to the trusted key. */
async function getPublicKey(subdomain, kid) {
  if (subdomain !== 'acme') throw new Error('unexpected subdomain ' + subdomain);
  if (kid !== 'kid-1') throw new Error('unknown kid');
  return trusted.publicKey;
}

/**
 * In-memory Sunshine Conversations. `PATCH metadata` REPLACES the object like
 * the real API, so a client that does not merge would lose existing keys.
 */
function fakeSunco({ metadata = {}, failMessages = 0, failMetadataPatchesAfter = Infinity } = {}) {
  const state = {
    metadata: { ...metadata },
    messages: [],
    log: [],
    failMessages,
    patches: 0,
  };
  return {
    state,
    async getConversationMetadata(conversationId) {
      state.log.push(['GET', conversationId]);
      return { ...state.metadata };
    },
    async mergeConversationMetadata(conversationId, patch) {
      state.patches += 1;
      if (state.patches > failMetadataPatchesAfter) throw new Error('metadata write failed');
      state.log.push(['PATCH', conversationId, patch]);
      state.metadata = { ...state.metadata, ...patch };
      return state.metadata;
    },
    async postUserMessage(conversationId, userId, text) {
      state.log.push(['POST', conversationId, userId, text]);
      if (state.failMessages > 0) {
        state.failMessages -= 1;
        throw new Error('message post failed');
      }
      state.messages.push({ conversationId, userId, text });
      return {};
    },
  };
}

module.exports = { config, signContext, getPublicKey, attacker, trusted, fakeSunco };
