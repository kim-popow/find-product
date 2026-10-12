'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmProduct } = require('../api/_lib/confirmProduct');
const { createSuncoClient } = require('../api/_lib/sunco');
const { productData } = require('../src/data/productData');
const { config, signContext, getPublicKey, attacker, fakeSunco } = require('./helpers');

const NAME = 'Sonnette® Roller Shades';
const SUB = 'submission-0001';

const run = (sunco, overrides = {}) =>
  confirmProduct(
    { token: signContext(), productName: NAME, submissionId: SUB, ...overrides },
    config,
    { sunco, getPublicKey }
  );

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });

test('saves the three keys, keeps existing metadata, then posts the message as the user', async () => {
  const sunco = fakeSunco({ metadata: { lang: 'en-us', customer_tier: 'gold' } });
  const result = await run(sunco);

  assert.deepEqual(result, { ok: true, productName: NAME });
  assert.deepEqual(sunco.state.metadata, {
    lang: 'en-us',
    customer_tier: 'gold',
    identified_product_name: 'Sonnette® Roller Shades',
    product_identification_status: 'completed',
    product_identification_source: 'product_finder',
    product_identification_submission_id: SUB,
  });
  assert.deepEqual(sunco.state.messages, [
    {
      conversationId: 'conv_777',
      userId: 'user_42',
      text: 'I have identified my product: Sonnette® Roller Shades.',
    },
  ]);

  // metadata must be written BEFORE the message is posted
  const ops = sunco.state.log.map(([op]) => op);
  assert.ok(ops.indexOf('PATCH') < ops.indexOf('POST'));
});

test('conversation and user come from the verified token only', async () => {
  const sunco = fakeSunco();
  const token = signContext({ conversationId: 'conv_from_token', appuserId: 'user_from_token' });
  await confirmProduct(
    // extra attacker-controlled fields are ignored
    { token, productName: NAME, submissionId: SUB, conversationId: 'conv_evil', userId: 'evil' },
    config,
    { sunco, getPublicKey }
  );
  assert.equal(sunco.state.messages[0].conversationId, 'conv_from_token');
  assert.equal(sunco.state.messages[0].userId, 'user_from_token');
  assert.ok(sunco.state.log.every(([, id]) => id === 'conv_from_token'));
});

test('rejects products that are not in the catalog and writes nothing', async () => {
  const sunco = fakeSunco();
  await rejects(run(sunco, { productName: 'Made Up Blinds' }), 'invalid_product');
  await rejects(run(sunco, { productName: 'sonnette® roller shades' }), 'invalid_product');
  await rejects(run(sunco, { productName: undefined }), 'invalid_product');
  assert.deepEqual(sunco.state.log, []);
});

test('rejects an invalid token and writes nothing', async () => {
  const sunco = fakeSunco();
  const token = signContext({}, { key: attacker.privateKey });
  await rejects(run(sunco, { token }), 'invalid_token');
  assert.deepEqual(sunco.state.log, []);
});

test('every product in the catalog can be confirmed', async () => {
  for (const product of Object.values(productData.products)) {
    const sunco = fakeSunco();
    await run(sunco, { productName: product.name, submissionId: 'submission-' + product.id });
    assert.equal(sunco.state.metadata.identified_product_name, product.name);
  }
});

test('retry after a failed message post posts exactly one message', async () => {
  const sunco = fakeSunco({ failMessages: 1 });
  await assert.rejects(run(sunco), /message post failed/);
  // metadata was saved, message was not
  assert.equal(sunco.state.metadata.identified_product_name, NAME);
  assert.equal(sunco.state.messages.length, 0);

  await run(sunco); // customer retries with the same submission id
  assert.equal(sunco.state.messages.length, 1);

  await run(sunco); // and even a third time: nothing new is posted
  assert.equal(sunco.state.messages.length, 1);
});

test('retrying an already delivered submission does not post again', async () => {
  const sunco = fakeSunco();
  await run(sunco);
  const again = await run(sunco);
  assert.equal(again.alreadyConfirmed, true);
  assert.equal(sunco.state.messages.length, 1);
});

test('concurrent double submission posts a single message', async () => {
  const sunco = fakeSunco();
  const results = await Promise.all([run(sunco), run(sunco), run(sunco)]);
  assert.equal(results.length, 3);
  assert.equal(sunco.state.messages.length, 1);
});

test('a new result (new submission id) posts a new message', async () => {
  const sunco = fakeSunco();
  await run(sunco);
  await run(sunco, { productName: 'Vertical Blinds', submissionId: 'submission-0002' });
  assert.equal(sunco.state.messages.length, 2);
  assert.equal(sunco.state.metadata.identified_product_name, 'Vertical Blinds');
});

test('failing to store the idempotency marker does not fail an already delivered message', async () => {
  const sunco = fakeSunco({ failMetadataPatchesAfter: 1 });
  const result = await run(sunco);
  assert.equal(result.ok, true);
  assert.equal(sunco.state.messages.length, 1);
});

test('metadata write failure prevents the message from being posted', async () => {
  const sunco = fakeSunco({ failMetadataPatchesAfter: 0 });
  await assert.rejects(run(sunco), /metadata write failed/);
  assert.equal(sunco.state.messages.length, 0);
});

test('real Sunshine client: correct URLs, auth, PATCH merge and user author', async () => {
  const calls = [];
  let stored = { lang: 'en-us' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (init.method === 'GET') {
      return { ok: true, json: async () => ({ conversation: { id: 'conv_777', metadata: stored } }) };
    }
    if (init.method === 'PATCH') {
      stored = JSON.parse(init.body).metadata;
      return { ok: true, json: async () => ({ conversation: { metadata: stored } }) };
    }
    return { ok: true, status: 201, json: async () => ({ messages: [{ id: 'm1' }] }) };
  };
  const sunco = createSuncoClient(config, fetchImpl);
  await run(sunco);

  const base = 'https://acme.zendesk.com/sc/v2/apps/app_123/conversations/conv_777';
  const expectedAuth = 'Basic ' + Buffer.from('app_key:app_secret').toString('base64');
  assert.ok(calls.every((c) => c.auth === expectedAuth));
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      `GET ${base}`,
      `GET ${base}`,
      `PATCH ${base}`,
      `POST ${base}/messages`,
      `GET ${base}`,
      `PATCH ${base}`,
    ]
  );
  assert.deepEqual(calls[3].body, {
    author: { type: 'user', userId: 'user_42' },
    content: { type: 'text', text: 'I have identified my product: Sonnette® Roller Shades.' },
  });
  assert.equal(stored.lang, 'en-us');
  assert.equal(stored.identified_product_name, NAME);
});
