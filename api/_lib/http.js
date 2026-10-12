'use strict';

const { HttpError } = require('./errors');
const { ConfigError } = require('./config');

/** Wraps a POST-only JSON handler with uniform error handling. */
function jsonPostHandler(fn) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'method_not_allowed', 'Use POST.');
      }
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (_) {
          body = null;
        }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'invalid_body', 'Expected a JSON object.');
      }
      const result = await fn(body);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ ok: false, code: err.code, message: err.message });
        return;
      }
      if (err instanceof ConfigError) {
        console.error('[api]', err.message);
        res.status(500).json({
          ok: false,
          code: 'server_misconfigured',
          message: 'The server is not configured for Zendesk yet.',
        });
        return;
      }
      console.error('[api] unexpected error:', err);
      res.status(500).json({ ok: false, code: 'internal_error', message: 'Unexpected server error.' });
    }
  };
}

module.exports = { jsonPostHandler };
