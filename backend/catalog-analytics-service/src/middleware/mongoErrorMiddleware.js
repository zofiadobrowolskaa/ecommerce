// explicit handling of mongo / mongoose errors. mirrors the pg side so every
// failure crosses the network as the unified { error, code, details } envelope
// and never as a raw stack trace.
const mongoErrorMap = (err, req, res, next) => {
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

  // mongoose schema validation - 400 Bad Request
  if (err.name === 'ValidationError') {
    const fields = Object.entries(err.errors || {}).map(([path, e]) => ({
      path,
      message: e.message,
      kind: e.kind
    }));
    return res.status(400).json({
      error: 'mongoose_validation_error',
      code: 400,
      details: fields
    });
  }

  // invalid ObjectId or cast failure - 400 Bad Request
  if (err.name === 'CastError') {
    return res.status(400).json({
      error: 'invalid_id_format',
      code: 400,
      details: { path: err.path, value: err.value, kind: err.kind }
    });
  }

  // duplicate key violation (unique index) - 409 Conflict
  // mongoServerError code 11000 is the canonical duplicate key code
  if (err.code === 11000 || err.codeName === 'DuplicateKey') {
    return res.status(409).json({
      error: 'conflict_duplicate_key',
      code: 409,
      details: { keyValue: err.keyValue }
    });
  }

  // network/connectivity issues at the driver level
  if (err.name === 'MongoServerSelectionError' || err.name === 'MongoNetworkError') {
    return res.status(503).json({
      error: 'database_unavailable',
      code: 503,
      details: 'mongo cluster unreachable'
    });
  }

  // fallback: never leak err.stack to the client
  console.error('catalog_unhandled_error:', err.name, err.message);
  return res.status(500).json({
    error: 'internal_server_error',
    code: 500,
    details: 'unexpected critical error'
  });
};

module.exports = mongoErrorMap;
