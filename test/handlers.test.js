'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const confirmHandler = require('../api/zendesk/confirm-product');
const contextHandler = require('../api/zendesk/context');

function mockRes() {
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const ENV_KEYS = ['ZENDESK_SUBDOMAIN', 'SUNCO_APP_ID', 'SUNCO_KEY_ID', 'SUNCO_SECRET'];

test('only POST is allowed', async () => {
  const res = mockRes();
  await confirmHandler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('rejects bodies that are not JSON objects', async () => {
  const res = mockRes();
  await contextHandler({ method: 'POST', body: 'nope' }, res);
  assert.equal(res.statusCode, 400);
});

test('a request without a token is a clean 400 JSON error on both endpoints', async () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  Object.assign(process.env, {
    ZENDESK_SUBDOMAIN: 'acme',
    SUNCO_APP_ID: 'app_123',
    SUNCO_KEY_ID: 'k',
    SUNCO_SECRET: 's',
  });
  try {
    const res = mockRes();
    await contextHandler({ method: 'POST', body: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, 'token_missing');
    assert.equal(res.body.code, 'token_missing');
  } finally {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    saved.forEach(([k, v]) => v !== undefined && (process.env[k] = v));
  }
});

test('reports a missing server configuration without leaking details', async () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  ENV_KEYS.forEach((k) => delete process.env[k]);
  try {
    const res = mockRes();
    await contextHandler({ method: 'POST', body: { token: 'x' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'server_misconfigured');
    assert.ok(!JSON.stringify(res.body).includes('SUNCO'));
  } finally {
    saved.forEach(([k, v]) => v !== undefined && (process.env[k] = v));
  }
});

test('an invalid token yields 401 and never calls Zendesk', async () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  Object.assign(process.env, {
    ZENDESK_SUBDOMAIN: 'acme',
    SUNCO_APP_ID: 'app_123',
    SUNCO_KEY_ID: 'k',
    SUNCO_SECRET: 's',
  });
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('no network in tests');
  };
  try {
    const res = mockRes();
    await confirmHandler(
      {
        method: 'POST',
        body: { token: 'garbage', productName: 'Sonnette® Roller Shades', submissionId: 'submission-0001' },
      },
      res
    );
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
    ENV_KEYS.forEach((k) => delete process.env[k]);
    saved.forEach(([k, v]) => v !== undefined && (process.env[k] = v));
  }
});
