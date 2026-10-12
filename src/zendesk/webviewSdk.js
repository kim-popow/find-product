// Thin wrapper around the official Zendesk Webview SDK
// (https://static.zdassets.com/conversation-extensions/latest/sdk.js, loaded
// from public/index.html).

const SDK_WAIT_MS = 4000;
const CONTEXT_WAIT_MS = 8000;

export class ContextUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextUnavailableError';
    this.code = code;
  }
}

/** Resolves with the SDK, or `null` when it never becomes available. */
export function loadWebviewSdk() {
  const ready = typeof window !== 'undefined' && window.__webviewSdkReady;
  if (!ready) return Promise.resolve(null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SDK_WAIT_MS));
  return Promise.race([ready, timeout]).then((sdk) => sdk || window.WebviewSdk || null);
}

/**
 * Whether the page seems to be running inside a Zendesk container. The SDK
 * reports platform "unknown" in a regular browser tab; an iframe (Web Widget)
 * or a non-"unknown" platform (web / ios / android / facebook_messenger) means
 * we were opened from a conversation.
 */
export function isEmbedded(sdk) {
  if (sdk && sdk.platform && sdk.platform !== 'unknown') return true;
  try {
    if (window.name === 'web_messenger_ref') return true;
    return window.self !== window.top;
  } catch (_) {
    // Accessing window.top can throw for cross-origin frames: we ARE framed.
    return true;
  }
}

/** Asks the container for the signed context token (a JWT). */
export function requestContextToken(sdk) {
  return new Promise((resolve, reject) => {
    if (!sdk || typeof sdk.hasFeature !== 'function' || !sdk.hasFeature('getContext')) {
      reject(
        new ContextUnavailableError(
          'context_unsupported',
          'This chat does not provide conversation context.'
        )
      );
      return;
    }

    const timer = setTimeout(
      () => reject(new ContextUnavailableError('context_timeout', 'Zendesk did not answer in time.')),
      CONTEXT_WAIT_MS
    );

    try {
      sdk.getContext(
        (context) => {
          clearTimeout(timer);
          if (context && typeof context.token === 'string' && context.token) {
            resolve(context.token);
          } else {
            reject(new ContextUnavailableError('context_empty', 'Zendesk returned no context.'));
          }
        },
        (error) => {
          clearTimeout(timer);
          reject(
            new ContextUnavailableError(
              'context_error',
              (error && error.message) || 'Could not read the conversation context.'
            )
          );
        }
      );
    } catch (error) {
      clearTimeout(timer);
      reject(new ContextUnavailableError('context_error', error && error.message));
    }
  });
}

/** Closes the web view when the container supports it. Never rejects. */
export function closeWebview(sdk) {
  return new Promise((resolve) => {
    if (!sdk || typeof sdk.hasFeature !== 'function' || !sdk.hasFeature('close')) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 3000);
    try {
      sdk.close(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        }
      );
    } catch (_) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}
