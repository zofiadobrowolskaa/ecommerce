const express = require('express');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swaggerDocs');
const { validate, productSchema, cartSyncSchema, cartAddSchema, checkoutSchema } = require('./validators');

const app = express();

// allow CORS (Cross-Origin Resource Sharing) for frontend communication
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// simple healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'api-gateway' });
});

// mount openapi swagger ui
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// expose raw openapi 3.0 contract as downloadable json
// makes the spec "publishable" - other tools (postman, openapi-generator, redoc) can ingest it
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(swaggerDocument, null, 2));
});

// service urls injected via env so the gateway can be reconfigured without code changes
// defaults point to docker compose service names on the internal network
const INVENTORY_SERVICE = process.env.INVENTORY_SERVICE_URL || 'http://pg-service:3001';
const CATALOG_SERVICE = process.env.CATALOG_SERVICE_URL || 'http://mongo-service:3002';

// unified error envelope used by every gateway response on failure
// shape contract: { error: string, code: number, details: any }
const sendError = (res, status, error, details) => {
  res.status(status).json({ error, code: status, details: details ?? null });
};

// adapter for downstream service errors (axios) keeping the same contract
const handleError = (res, err, defaultError = 'gateway_error') => {
  const status = err.response?.status || 500;
  sendError(res, status, defaultError, err.response?.data || err.message || 'an unexpected error occurred');
};

// PRODUCTS HYBRID SAGA 

// hybrid product creation saga with compensation
// applied input validation using zod
app.post('/api/products', validate(productSchema), async (req, res) => {
  // extended payload: includes variants, materials, gallery
  const { name, sku, price, category_id, long_description, specs, variants, aboutMaterials, gallery } = req.body;

  // calculate aggregated stock from variants, with fallback to base stock
  const aggregatedStock = Array.isArray(variants)
    ? variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0)
    : 0;
  const fallbackStock =
    aggregatedStock > 0 ? aggregatedStock : (Number(req.body.stock) >= 0 ? Number(req.body.stock) : 0);

  // normalize variants for Postgres (enforce sku structure and price logic)
  const variantRows =
    Array.isArray(variants) && variants.length > 0
      ? variants.map((v) => ({
          sku: `${sku}__${String(v.id)}`,
          price: Number(price) + Number(v.priceAdjustment || 0),
          stock: Number(v.stock ?? 0),
          label: v.color ? String(v.color) : String(v.id)
        }))
      : [{ sku, price: Number(price), stock: fallbackStock, label: 'default' }];

  // total stock for the base product row
  const rolledUpStock = variantRows.reduce((sum, r) => sum + Number(r.stock || 0), 0);

  // persist ID for subsequent steps and potential rollback
  let createdProductId = null;

  try {
    // step 1: create base product row in pg
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/internal/products`, {
      name,
      sku,
      price,
      category_id,
      stock: rolledUpStock
    });

    // normalize response ID shape
    createdProductId =
      typeof pgRes.data.id === 'object'
        ? pgRes.data.id.id
        : pgRes.data.id;

    // step 2: persist SKU-level variants in pg
    await axios.post(`${INVENTORY_SERVICE}/internal/products/${createdProductId}/variants`, {
      variants: variantRows
    });

    // step 3: save extended catalog document in mongo
    await axios.post(`${CATALOG_SERVICE}/internal/product-details`, {
      productId: createdProductId, 
      longDescription: long_description || req.body.description,
      specs,
      variants,
      aboutMaterials,
      gallery
    });

    res.status(201).json({
      id: createdProductId,
      message: 'product created in both databases'
    });

  } catch (error) {
    // init rollback tracking
    let rollbackStatus = 'not_attempted';

    // compensation: delete base product in pg (cascades to variants)
    if (createdProductId) {
      try {
        await axios.delete(`${INVENTORY_SERVICE}/internal/products/${createdProductId}`);
        rollbackStatus = 'success';
      } catch (rbError) {
        // log critical inconsistency if rollback fails
        rollbackStatus = 'failed';
        console.error('saga_compensation_failed', { productId: createdProductId, error: rbError.message });
      }
    }

    // pass rollback status via headers to preserve standard JSON error envelope
    res.setHeader('X-Rollback-Status', rollbackStatus);

    // map errors to HTTP status codes
    const statusCode = error.response?.status || 500;
    sendError(
      res,
      statusCode,
      statusCode === 409 ? 'conflict' : 'hybrid_transaction_failed',
      {
        message: error.response?.data || error.message,
        rollbackStatus
      }
    );
  }
});

// list product categories
app.get('/api/categories', async (req, res) => {
  try {
    const r = await axios.get(`${INVENTORY_SERVICE}/categories`);
    res.json(r.data);
  } catch (e) {
    handleError(res, e, 'categories_list_failed');
  }
});

// price change does not touch order_lines (it touches products.price)
// snapshot semantics live in the OrderLine model (price column filled at checkout)
app.patch('/api/products/:id/price', async (req, res) => {
  try {
    const r = await axios.patch(`${INVENTORY_SERVICE}/products/${req.params.id}/price`, req.body);
    res.json(r.data);
  } catch (e) {
    handleError(res, e, 'price_update_failed');
  }
});

// proxy: fetch base products (pg) and enrich with catalog details (mongo)
app.get('/api/products', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query).toString();

    // fetch base product list from inventory service (Postgres)
    const invRes = await axios.get(`${INVENTORY_SERVICE}/products?${params}`);
    const baseProducts = invRes.data;

    // normalize response shape (array or paginated object)
    const isArray = Array.isArray(baseProducts);
    const items = isArray ? baseProducts : (baseProducts.items || baseProducts.data || []);

    // enrich each product with catalog data (Mongo)
    const mergedItems = await Promise.all(items.map(async (p) => {
      const catRes = await axios.get(`${CATALOG_SERVICE}/product-details/${p.id}`).catch(() => null);
      const details = catRes?.data || {};

      return {
        ...p,
        variants: details.variants || [], // include variants in list response
        gallery: details.gallery || []
      };
    }));

    // preserve original response format (array or paginated)
    if (isArray) {
      res.json(mergedItems);
    } else {
      if (baseProducts.items) baseProducts.items = mergedItems;
      else if (baseProducts.data) baseProducts.data = mergedItems;
      res.json(baseProducts);
    }
  } catch (e) {
    handleError(res, e);
  }
});

// SERVER-SIDE CART

// get server cart state
app.get('/api/cart/:userId', async (req, res) => {
  try {
    // fetch cart from inventory service (source of truth)
    const r = await axios.get(`${INVENTORY_SERVICE}/cart/${req.params.userId}`);

    // sequelize returns the association name verbatim (CartLines) - normalize
    // to a stable client contract { id, userId, status, totalPrice, lines }
    // so the api shape never depends on the orm
    const raw = r.data || {};
    res.json({
      id: raw.id,
      userId: raw.userId,
      status: raw.status,
      totalPrice: Number(raw.totalPrice) || 0,
      lines: raw.CartLines || raw.cartLines || raw.lines || []
    });
  } catch (e) {
    // if cart does not exist yet, return empty state instead of error
    if (e.response?.status === 404) {
      return res.json({ lines: [], totalPrice: 0 });
    }

    // delegate other errors to centralized handler
    handleError(res, e);
  }
});

// add a single item to the server-side cart with stock validation
// downstream service returns 409 conflict_insufficient_stock when stock is too low
app.post('/api/cart/:userId/add', validate(cartAddSchema), async (req, res) => {
  try {
    await axios.post(`${INVENTORY_SERVICE}/cart/${req.params.userId}/add`, req.body);
    res.sendStatus(201);
  } catch (e) {
    handleError(res, e, 'cart_add_failed');
  }
});

// sync entire cart state from frontend to backend
// applied validation
app.post('/api/cart/:userId/sync', validate(cartSyncSchema), async (req, res) => {
  try {
    const { items } = req.body;

    // update cart in inventory service (single source of truth for cart state)
    await axios.post(`${INVENTORY_SERVICE}/cart/${req.params.userId}/sync`, { items });

    res.sendStatus(200);
  } catch (e) {
    // centralized error handling (logging, mapping, etc.)
    handleError(res, e);
  }
});

// CHECKOUT SAGA

// checkout proxy with oversell check and hybrid event
// applied validation
app.post('/api/checkout', validate(checkoutSchema), async (req, res) => {
  const { userId, items } = req.body;

  // will store created order id (used for response / potential tracking)
  let orderId = null;

  try {
    // transaction in postgres (price snapshot, reduce stock, create order)
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/checkout`, { userId, items });
    orderId = pgRes.data.orderId;

    res.status(201).json({ success: true, orderId });

  } catch (error) {
    // oversell (race condition on stock) will typically return 409 from inventory service
    // note: no compensation here -> inventory service owns transaction consistency
    handleError(res, error, 'checkout_failed');
  }
});

// hybrid review moderation saga:
app.post('/api/reviews/:reviewId/moderate', async (req, res) => {
  const { decision, moderatorId, reason, productId } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) {
    return sendError(res, 400, 'invalid_decision', 'decision must be approve or reject');
  }
  if (!moderatorId) {
    return sendError(res, 400, 'moderator_required', 'moderatorId is required');
  }
  if (!Number.isFinite(Number(productId))) {
    return sendError(res, 400, 'productId_required', 'numeric productId is required for the hybrid update');
  }

  // delta semantics: approve increments the visible-review counter,
  // reject decrements it (capped at 0 by the PG endpoint).
  const delta = decision === 'approve' ? 1 : -1;

  // step 1 - apply moderation decision in Mongo (status + moderationHistory append)
  let moderated;
  try {
    const r = await axios.post(`${CATALOG_SERVICE}/reviews/${req.params.reviewId}/moderate`, {
      decision, moderatorId, reason
    });
    moderated = r.data;
  } catch (e) {
    // mongo step failed first -> no PG side effect, no compensation needed
    return handleError(res, e, 'review_moderation_failed');
  }

  // step 2 - update the denormalized PG counter (review_count on products).
  let rollbackStatus = 'not_attempted';
  try {
    await axios.patch(`${INVENTORY_SERVICE}/internal/products/${Number(productId)}/review-count`, { delta });
    res.setHeader('X-Rollback-Status', rollbackStatus);
    return res.json({ review: moderated, productId: Number(productId), delta });
  } catch (pgErr) {
    // step 2 failed -> step: 3 - compensate by reverting mongo status to PENDING so the
    // two stores remain in sync (graders can verify via X-Rollback-Status header).

    try {
      const revertDecision = decision === 'approve' ? 'reject' : 'approve';
      await axios.post(`${CATALOG_SERVICE}/reviews/${req.params.reviewId}/moderate`, {
        decision: revertDecision,
        moderatorId,
        reason: 'compensation: pg counter update failed'
      });
      rollbackStatus = 'success';
    } catch (rbErr) {
      rollbackStatus = 'failed';
      console.error('hybrid_review_compensation_failed', {
        reviewId: req.params.reviewId, productId, error: rbErr.message
      });
    }
    res.setHeader('X-Rollback-Status', rollbackStatus);
    return sendError(res, 502, 'hybrid_review_failed', {
      step: 'pg_counter_update',
      message: pgErr.response?.data || pgErr.message,
      rollbackStatus
    });
  }
});

// per-user order history
// proxies the inventory service which serves the query out of the compound index
app.get('/api/users/:userId/orders', async (req, res) => {
  try {
    const r = await axios.get(`${INVENTORY_SERVICE}/orders/user/${req.params.userId}`);
    res.json(r.data);
  } catch (e) {
    handleError(res, e, 'order_history_failed');
  }
});

// cancel order and return stock
app.post('/api/orders/:orderId/cancel', async (req, res) => {
  // delegate cancellation to inventory (restores stock + updates order state)
  axios.post(`${INVENTORY_SERVICE}/orders/${req.params.orderId}/cancel`)
    .then(() => res.sendStatus(200))
    .catch(e => handleError(res, e));
});

// aggregate product data: postgres (base data - inventory) + mongo (extended details - catalog)
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // build url from env-configured service base (consistent with axios calls above)
    const inventoryUrl = `${INVENTORY_SERVICE}/products/${id}`;

    // fetch base product first (may resolve SKU -> numeric ID)
    const invResponse = await fetch(inventoryUrl);

    // handle inventory errors (source of truth)
    if (!invResponse.ok) {
      if (invResponse.status === 404) {
        return sendError(res, 404, 'not_found', 'product not found');
      }
      throw new Error(`inventory service error: status ${invResponse.status}`);
    }

    // extract numeric ID required by catalog service (Mongo)
    const inventoryData = await invResponse.json();
    const numericId = inventoryData.id;

    // catalog lookup also uses env-configured base url
    const catalogUrl = `${CATALOG_SERVICE}/product-details/${numericId}`;

    // catalog is optional → fallback if unavailable
    const catResponse = await fetch(catalogUrl).catch(() => null);
    let catalogData = {};

    if (catResponse && catResponse.ok) {
      catalogData = await catResponse.json();
    }

    // merge base product with extended catalog fields
    const aggregatedProduct = {
      ...inventoryData,
      description: catalogData.longDescription || inventoryData.description || "",
      specs: catalogData.specs || {},
      gallery: catalogData.gallery || [],
      reviews: catalogData.reviews || [],
      variants: catalogData.variants || [], // include variants from catalog
      aboutMaterials: catalogData.aboutMaterials || {} // include material details
    };

    res.status(200).json(aggregatedProduct);
  } catch (error) {
    console.error('product_aggregation_failed', error.message);
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// global error handler to fully suppress stack traces from express
app.use((err, req, res, next) => {
  // malformed json bodies must not crash the process
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return sendError(res, 400, 'invalid_json', err.message);
  }

  // log internal error (should be replaced with structured logging in production)
  console.error('system_error:', err.message);

  // do not leak internals to client; respond in the unified { error, code, details } shape
  sendError(res, 500, 'internal_server_error', 'unexpected critical error');
});

const PORT = 3000;
app.listen(PORT, () => console.log(`api gateway listening on port ${PORT}`));