// Calls to our own backend (Vercel serverless functions in /api).

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function postJson(path, payload) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
    });
  } catch (_) {
    throw new ApiError('network', 'Network error', 0);
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    /* non-JSON body */
  }

  if (!response.ok || !data || data.ok !== true) {
    throw new ApiError(
      (data && data.code) || 'server_error',
      (data && data.message) || `Request failed (${response.status})`,
      response.status
    );
  }
  return data;
}

/** Asks the server to verify the context token. Resolves only when valid. */
export function verifyContext(token) {
  return postJson('/api/zendesk/context', { token });
}

/** Saves the product on the verified conversation and posts the message. */
export function confirmProductOnServer({ token, productName, submissionId }) {
  return postJson('/api/zendesk/confirm-product', { token, productName, submissionId });
}
