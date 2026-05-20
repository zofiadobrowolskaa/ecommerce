// centralizes pg error -> http mapping so every route just calls next(err).
// unified response envelope: { error, code, details } on every failure.
const pgErrorMap = (err, req, res, next) => {
  // malformed json body -> 400 instead of crashing with generic 500
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: 'invalid_json',
      code: 400,
      details: err.message
    });
  }

  // pg sqlstate codes -> http status mapping
  // duplicate key -> 409 Conflict; referenced row missing -> 400 Bad Request
  const codes = {
    '23505': { status: 409, error: 'conflict_unique_violation' },
    '23503': { status: 400, error: 'foreign_key_violation' }
  };

  // check if the current error matches a known pg database error
  const mapped = codes[err.code];
  if (mapped) {
    // return the mapped http status and pg error details
    return res.status(mapped.status).json({
      error: mapped.error,
      code: mapped.status,
      details: { sqlstate: err.code, message: err.detail || err.message }
    });
  }
  // fallback: unknown error still returns the unified envelope (never leaks a stack trace)
  res.status(500).json({
    error: 'internal_server_error',
    code: 500,
    details: err.message || 'unexpected error'
  });
};

module.exports = pgErrorMap;