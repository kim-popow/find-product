'use strict';

const { loadConfig } = require('../_lib/config');
const { jsonPostHandler } = require('../_lib/http');
const { confirmProduct } = require('../_lib/confirmProduct');

// POST /api/zendesk/confirm-product
// body: { token, productName, submissionId }
module.exports = jsonPostHandler(async (body) => {
  const config = loadConfig();
  const { token, productName, submissionId } = body;
  return confirmProduct({ token, productName, submissionId }, config);
});
