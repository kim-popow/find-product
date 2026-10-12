'use strict';

const { HttpError } = require('./errors');
const { isCatalogProductName } = require('./catalog');
const { verifyContextToken } = require('./verifyContext');
const { createSuncoClient } = require('./sunco');

// Custom (non-native) keys read by the AI agent through "Get conversation".
const KEY_NAME = 'identified_product_name';
const KEY_STATUS = 'product_identification_status';
const KEY_SOURCE = 'product_identification_source';
// Internal idempotency marker (see below). Not meant for the AI agent.
const KEY_SUBMISSION = 'product_identification_submission_id';

const SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

// Best-effort protection against two concurrent requests handled by the same
// warm function instance (e.g. a double click that slipped past the UI lock).
const inFlight = new Map();

/**
 * Saves the identified product on the verified conversation and posts the
 * confirmation message on behalf of the verified user.
 *
 * Idempotency: a retry carries the same `submissionId`. After the message has
 * been posted we stamp `product_identification_submission_id` on the
 * conversation; a later request with the same id returns success without
 * writing/posting anything again. A retry after a failure *before* that point
 * simply redoes the (idempotent) metadata write and posts the message once.
 */
async function confirmProduct({ token, productName, submissionId }, config, deps = {}) {
  const verify = deps.verify || verifyContextToken;
  const sunco = deps.sunco || createSuncoClient(config);

  if (!isCatalogProductName(productName)) {
    throw new HttpError(400, 'invalid_product', 'Unknown product name.');
  }
  if (typeof submissionId !== 'string' || !SUBMISSION_ID_RE.test(submissionId)) {
    throw new HttpError(400, 'invalid_submission', 'Missing or invalid submission id.');
  }

  // Identity comes ONLY from the verified token, never from the request body.
  const context = await verify(token, config, deps.getPublicKey);
  const { conversationId, appuserId } = context;

  const lockKey = `${conversationId}:${submissionId}`;
  if (inFlight.has(lockKey)) return inFlight.get(lockKey);

  const run = (async () => {
    const existing = await sunco.getConversationMetadata(conversationId);
    if (existing[KEY_SUBMISSION] === submissionId) {
      return { ok: true, productName, alreadyConfirmed: true };
    }

    // 1. Save the metadata, keeping everything that is already there.
    await sunco.mergeConversationMetadata(conversationId, {
      [KEY_NAME]: productName,
      [KEY_STATUS]: 'completed',
      [KEY_SOURCE]: 'product_finder',
    });

    // 2. Only after the metadata is stored, tell the AI agent.
    await sunco.postUserMessage(
      conversationId,
      appuserId,
      `I have identified my product: ${productName}.`
    );

    // 3. Mark this submission as delivered so retries do not repost. The
    //    message is already delivered, so a failure here must not fail the
    //    request (that would invite the customer to post it a second time).
    try {
      await sunco.mergeConversationMetadata(conversationId, { [KEY_SUBMISSION]: submissionId });
    } catch (err) {
      console.error('[confirm-product] could not store idempotency marker:', err && err.message);
    }

    return { ok: true, productName };
  })();

  inFlight.set(lockKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(lockKey);
  }
}

module.exports = {
  confirmProduct,
  METADATA_KEYS: { KEY_NAME, KEY_STATUS, KEY_SOURCE, KEY_SUBMISSION },
};
