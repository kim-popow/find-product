'use strict';

/** Error that maps to an HTTP response sent to the browser. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
