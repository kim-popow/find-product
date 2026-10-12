'use strict';

const { loadConfig } = require('../_lib/config');
const { jsonPostHandler } = require('../_lib/http');
const { verifyContextToken } = require('../_lib/verifyContext');

// POST /api/zendesk/context
// body: { token }
// Lets the page learn early whether it was opened from a valid conversation.
// The conversation / user ids stay on the server; the browser only learns
// that the context is valid.
module.exports = jsonPostHandler(async (body) => {
  const config = loadConfig();
  await verifyContextToken(body.token, config);
  return { ok: true, valid: true };
});
