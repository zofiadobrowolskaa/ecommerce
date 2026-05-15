// map pg error codes to http and respond in the unified { error, code, details } envelope
const pgErrorMap = (err, req, res, next) => {
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