// map pg error codes to http and respond in the unified { error, code, details } envelope
const pgErrorMap = (err, req, res, next) => {
  // body-parser DoS protection: oversized json bodies surface as 413
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: 'payload_too_large',
      code: 413,
      details: { limit: err.limit, length: err.length }
    });
  }

  // malformed json -> 400 instead of generic 500
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: 'invalid_json',
      code: 400,
      details: err.message
    });
  }

  const codes = {
    '23505': { status: 409, error: 'conflict_unique_violation' },
    '23503': { status: 400, error: 'foreign_key_violation' }
  };

  const mapped = codes[err.code];
  if (mapped) {
    // unified envelope: { error, code, details }
    // code is the HTTP status; details carries the pg sqlstate for diagnostics
    return res.status(mapped.status).json({
      error: mapped.error,
      code: mapped.status,
      details: { sqlstate: err.code, message: err.detail || err.message }
    });
  }
  // generic fallback so any unhandled error still respects the contract
  res.status(500).json({
    error: 'internal_server_error',
    code: 500,
    details: err.message || 'unexpected error'
  });
};

module.exports = pgErrorMap;