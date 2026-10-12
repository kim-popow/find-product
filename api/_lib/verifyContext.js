'use strict';

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { HttpError } = require('./errors');

// One client per subdomain, reused across invocations of a warm function so
// the JWKS cache is honoured (the Zendesk endpoint is limited to 5 req/min).
const clients = new Map();

function getJwksClient(subdomain) {
  let client = clients.get(subdomain);
  if (!client) {
    client = jwksClient({
      jwksUri: `https://${subdomain}.zendesk.com/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 4,
      timeout: 5000,
    });
    clients.set(subdomain, client);
  }
  return client;
}

/** Default key resolver: fetch (or reuse the cached) public key for `kid`. */
async function defaultGetPublicKey(subdomain, kid) {
  const key = await getJwksClient(subdomain).getSigningKey(kid);
  return key.getPublicKey();
}

const REQUIRED_CLAIMS = ['appuserId', 'subdomain', 'appId', 'conversationId'];

/**
 * Verifies a Webview SDK `getContext` token as described in the Zendesk docs:
 *   1. read `kid` from the (unverified) header,
 *   2. fetch the JWKS of the configured subdomain and pick the matching key,
 *   3. verify the RS256 signature and the `exp` claim,
 *   4. only then trust the claims.
 *
 * Additionally the token must belong to OUR Zendesk subdomain and OUR
 * Sunshine Conversations app. The subdomain used to build the JWKS URL is
 * always the configured one, never the one found inside the (still untrusted)
 * token, so a forged token cannot make the server fetch keys from elsewhere.
 *
 * @returns {Promise<{appuserId:string, conversationId:string, appId:string,
 *   subdomain:string, integrationId?:string, messageId?:string}>}
 */
async function verifyContextToken(token, config, getPublicKey = defaultGetPublicKey) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    throw new HttpError(401, 'invalid_token', 'Missing or malformed context token.');
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.payload || typeof decoded.payload !== 'object') {
    throw new HttpError(401, 'invalid_token', 'Malformed context token.');
  }
  if (decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string') {
    throw new HttpError(401, 'invalid_token', 'Unsupported token header.');
  }

  // Cheap rejection before any network call.
  const claimedSubdomain = String(decoded.payload.subdomain || '').toLowerCase();
  if (claimedSubdomain !== config.subdomain) {
    throw new HttpError(403, 'untrusted_subdomain', 'Token was not issued for this Zendesk account.');
  }

  let publicKey;
  try {
    publicKey = await getPublicKey(config.subdomain, decoded.header.kid);
  } catch (err) {
    // Unknown kid, JWKS unreachable or rate limited.
    console.error('[zendesk-context] could not resolve signing key:', err && err.message);
    throw new HttpError(401, 'invalid_token', 'Could not verify the context token signature.');
  }

  let payload;
  try {
    payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'token_expired', 'The context token has expired.');
    }
    throw new HttpError(401, 'invalid_token', 'The context token is not valid.');
  }

  // jsonwebtoken only checks `exp` when present: make it mandatory.
  if (typeof payload.exp !== 'number') {
    throw new HttpError(401, 'invalid_token', 'The context token has no expiration.');
  }

  const missing = REQUIRED_CLAIMS.filter(
    (name) => typeof payload[name] !== 'string' || payload[name].length === 0
  );
  if (missing.length) {
    console.error('[zendesk-context] verified token lacks claims:', missing.join(', '));
    throw new HttpError(401, 'invalid_claims', 'The context token does not identify a conversation.');
  }

  if (payload.appId !== config.appId) {
    throw new HttpError(403, 'untrusted_app', 'Token was not issued for this application.');
  }
  if (
    config.allowedIntegrationIds.length > 0 &&
    !config.allowedIntegrationIds.includes(payload.integrationId)
  ) {
    throw new HttpError(403, 'untrusted_integration', 'Token was not issued for an allowed integration.');
  }

  return {
    appuserId: payload.appuserId,
    conversationId: payload.conversationId,
    appId: payload.appId,
    subdomain: String(payload.subdomain).toLowerCase(),
    integrationId: payload.integrationId,
    messageId: payload.messageId,
  };
}

module.exports = { verifyContextToken };
