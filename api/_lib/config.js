'use strict';

/**
 * Server-side configuration. Everything comes from environment variables so
 * that no Sunshine Conversations credential ever reaches the browser bundle.
 *
 *   ZENDESK_SUBDOMAIN            e.g. "acme"  (for acme.zendesk.com)
 *   SUNCO_APP_ID                 Sunshine Conversations app id
 *   SUNCO_KEY_ID                 API key id   (Basic auth username)
 *   SUNCO_SECRET                 API key secret (Basic auth password)
 *   ZENDESK_ALLOWED_INTEGRATION_IDS  (optional) comma separated integration ids
 */

class ConfigError extends Error {
  constructor(missing) {
    super(`Missing server configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function loadConfig(env = process.env) {
  const subdomain = clean(env.ZENDESK_SUBDOMAIN)
    .toLowerCase()
    // tolerate "acme.zendesk.com" or a full URL being pasted by mistake
    .replace(/^https?:\/\//, '')
    .replace(/\.zendesk\.com.*$/, '');
  const appId = clean(env.SUNCO_APP_ID);
  const keyId = clean(env.SUNCO_KEY_ID);
  const secret = clean(env.SUNCO_SECRET);

  const missing = [];
  if (!subdomain) missing.push('ZENDESK_SUBDOMAIN');
  if (!appId) missing.push('SUNCO_APP_ID');
  if (!keyId) missing.push('SUNCO_KEY_ID');
  if (!secret) missing.push('SUNCO_SECRET');
  if (missing.length) throw new ConfigError(missing);

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    throw new ConfigError(['ZENDESK_SUBDOMAIN (invalid value)']);
  }

  const allowedIntegrationIds = clean(env.ZENDESK_ALLOWED_INTEGRATION_IDS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { subdomain, appId, keyId, secret, allowedIntegrationIds };
}

module.exports = { loadConfig, ConfigError };
