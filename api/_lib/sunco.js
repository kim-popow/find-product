'use strict';

const { HttpError } = require('./errors');

const REQUEST_TIMEOUT_MS = 8000;

function createSuncoClient(config, fetchImpl = globalThis.fetch) {
  const base =
    `https://${config.subdomain}.zendesk.com/sc/v2/apps/` + encodeURIComponent(config.appId);
  const authorization =
    'Basic ' + Buffer.from(`${config.keyId}:${config.secret}`).toString('base64');

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[sunco] ${method} ${path} failed:`, err && err.message);
      throw new HttpError(502, 'zendesk_unreachable', 'Could not reach Zendesk.');
    }

    if (!res.ok) {
      // Log details server-side only; never forward Zendesk bodies to the browser.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch (_) {
        /* ignore */
      }
      console.error(`[sunco] ${method} ${path} -> ${res.status} ${detail}`);
      throw new HttpError(
        res.status === 404 ? 404 : 502,
        res.status === 404 ? 'conversation_not_found' : 'zendesk_error',
        res.status === 404
          ? 'The conversation could not be found.'
          : 'Zendesk rejected the request.'
      );
    }
    return res.json();
  }

  const conversationPath = (id) => `/conversations/${encodeURIComponent(id)}`;

  return {
    async getConversationMetadata(conversationId) {
      const data = await request('GET', conversationPath(conversationId));
      return (data && data.conversation && data.conversation.metadata) || {};
    },

    /**
     * Merges `patch` into the conversation metadata. The API treats the
     * `metadata` object we send as the whole new value, so we read the current
     * metadata immediately before writing and keep every existing key.
     * Returns the merged metadata that was written.
     */
    async mergeConversationMetadata(conversationId, patch) {
      const current = await this.getConversationMetadata(conversationId);
      const merged = { ...current, ...patch };
      await request('PATCH', conversationPath(conversationId), { metadata: merged });
      return merged;
    },

    /** Posts a text message authored by the (verified) end user. */
    async postUserMessage(conversationId, userId, text) {
      return request('POST', `${conversationPath(conversationId)}/messages`, {
        author: { type: 'user', userId },
        content: { type: 'text', text },
      });
    },
  };
}

module.exports = { createSuncoClient };
