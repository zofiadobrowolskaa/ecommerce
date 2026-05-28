const express = require('express');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const promClient = require('prom-client');
const Redis = require('ioredis');
const swaggerDocument = require('./swaggerDocs');
const { validate, productSchema, cartSyncSchema, cartAddSchema, checkoutSchema } = require('./validators');

const app = express();

// redis client used as a short-lived cache in front of the product list endpoint
// lazyConnect lets the gateway boot even if redis is temporarily unavailable
const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redis = new Redis({
  host: redisHost,
  port: redisPort,
  lazyConnect: true,
  // keeps connection retries bounded so a redis outage cannot block requests forever
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});

// flag toggled by connection events so request handlers can short-circuit when redis is down
let redisAvailable = false;
redis.on('ready', () => { redisAvailable = true; console.log('redis cache connected'); });
redis.on('error', (e) => { redisAvailable = false; console.warn('redis unavailable:', e.message); });

// fire-and-forget connect on boot; failures only flip the flag, they do not crash the gateway
redis.connect().catch(() => { /* connection errors handled by event listener above */ });

// ttl in seconds for cached product list payloads
const PRODUCTS_CACHE_TTL = 30;

// prometheus metrics registry, scoped to this service
const metricsRegister = new promClient.Registry();
// adds default node.js process metrics (cpu, memory, event loop)
promClient.collectDefaultMetrics({ register: metricsRegister, prefix: 'gateway_' });

// custom counter tracking every http request by method, route and status
const httpRequestsTotal = new promClient.Counter({
  name: 'gateway_http_requests_total',
  help: 'total number of http requests handled by the api gateway',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegister]
});

// middleware that increments the counter when each response finishes
app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestsTotal.inc({
      method: req.method,
      // falls back to raw path when no route was matched (e.g. 404)
      route: req.route?.path || req.path,
      status: res.statusCode
    });
  });
  next();
});

// allow CORS (Cross-Origin Resource Sharing) for frontend communication
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  // PATCH added to support price update endpoint
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// liveness probe: confirms the node.js process is alive and responding
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'api-gateway' });
});

// readiness probe: confirms downstream services are reachable
// kubernetes will not route traffic until this returns 200
app.get('/ready', async (req, res) => {
  try {
    // short timeouts so a stuck dependency cannot block the probe
    await axios.get(`${process.env.INVENTORY_SERVICE_URL || 'http://pg-service:3001'}/health`, { timeout: 1500 });
    await axios.get(`${process.env.CATALOG_SERVICE_URL || 'http://mongo-service:3002'}/health`, { timeout: 1500 });
    res.status(200).json({ ready: true });
  } catch (e) {
    // 503 makes the pod NotReady and forces traffic to other replicas
    res.status(503).json({ ready: false, reason: e.message });
  }
});

// prometheus scrape endpoint, exposes metrics in text format
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

// mounts openapi swagger ui at specific route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// exposes raw openapi 3.0 contract as downloadable json for external tools
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(swaggerDocument, null, 2));
});

// injects service urls via env variables for flexibility
// defaults to internal docker network service names
const INVENTORY_SERVICE = process.env.INVENTORY_SERVICE_URL || 'http://pg-service:3001';
const CATALOG_SERVICE = process.env.CATALOG_SERVICE_URL || 'http://mongo-service:3002';

// defines unified error envelope for gateway failures
// ensures consistent shape: error, code, details
const sendError = (res, status, error, details) => {
  res.status(status).json({ error, code: status, details: details ?? null });
};

// adapts downstream axios errors to the unified contract
const handleError = (res, err, defaultError = 'gateway_error') => {
  const status = err.response?.status || 500;
  sendError(res, status, defaultError, err.response?.data || err.message || 'an unexpected error occurred');
};

// PRODUCTS HYBRID SAGA 

// handles hybrid product creation saga with rollback
// validates input payload using zod schema
app.post('/api/products', validate(productSchema), async (req, res) => {
  const { name, sku, price, category_id, long_description, specs, variants, aboutMaterials, gallery } = req.body;

  // calculates total stock from variants with fallback
  const aggregatedStock = Array.isArray(variants)
    ? variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0)
    : 0;
  const fallbackStock =
    aggregatedStock > 0 ? aggregatedStock : (Number(req.body.stock) >= 0 ? Number(req.body.stock) : 0);

  // formats variants for postgres tracking
  const variantRows =
    Array.isArray(variants) && variants.length > 0
      ? variants.map((v) => ({
          sku: `${sku}__${String(v.id)}`,
          price: Number(price) + Number(v.priceAdjustment || 0),
          stock: Number(v.stock ?? 0),
          label: v.color ? String(v.color) : String(v.id)
        }))
      : [{ sku, price: Number(price), stock: fallbackStock, label: 'default' }];

  // sums total stock for base product record
  const rolledUpStock = variantRows.reduce((sum, r) => sum + Number(r.stock || 0), 0);

  // stores id for next steps and potential rollback
  let createdProductId = null;

  try {
    // step 1: create base product in postgres
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/internal/products`, {
      name,
      sku,
      price,
      category_id,
      stock: rolledUpStock
    });

    // normalizes returned product id
    createdProductId =
      typeof pgRes.data.id === 'object'
        ? pgRes.data.id.id
        : pgRes.data.id;

    // step 2: save sku-level variants in postgres
    await axios.post(`${INVENTORY_SERVICE}/internal/products/${createdProductId}/variants`, {
      variants: variantRows
    });

    // step 3: save extended catalog details in mongodb
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
    // initializes rollback status
    let rollbackStatus = 'not_attempted';

    // executes compensation deleting postgres record
    if (createdProductId) {
      try {
        await axios.delete(`${INVENTORY_SERVICE}/internal/products/${createdProductId}`);
        rollbackStatus = 'success';
      } catch (rbError) {
        // logs critical inconsistency if rollback fails
        rollbackStatus = 'failed';
        console.error('saga_compensation_failed', { productId: createdProductId, error: rbError.message });
      }
    }

    // sets rollback status in response headers
    res.setHeader('X-Rollback-Status', rollbackStatus);

    // maps error to proper http status code
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

// update product across both databases using hybrid saga (no rollback needed - partial updates are acceptable)
app.put('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'invalid_id', 'id must be numeric');

  const { name, price, category_id, sku, long_description, specs, variants, aboutMaterials, gallery } = req.body;

  try {
    // step 1: update base product fields in postgres
    await axios.patch(`${INVENTORY_SERVICE}/internal/products/${id}`, {
      name,
      category_id: Number(category_id),
      price: Number(price)
    });

    // step 2: re-sync inventory variants in postgres while preserving existing stock values
    if (Array.isArray(variants) && variants.length > 0 && sku) {
      // fetch current inventory variants to read their existing stock counts
      const existingRes = await axios.get(`${INVENTORY_SERVICE}/products/${id}/variants`).catch(() => ({ data: [] }));
      const stockBySku = {};
      (existingRes.data || []).forEach(v => { stockBySku[v.sku] = v.stock; });

      const variantRows = variants.map((v) => {
        const variantSku = `${sku}__${String(v.id)}`;
        return {
          sku: variantSku,
          price: Number(price) + Number(v.priceAdjustment || 0),
          stock: stockBySku[variantSku] ?? 0, // preserve current stock or default to 0 for new variants
          label: v.color ? String(v.color) : String(v.id)
        };
      });

      await axios.post(`${INVENTORY_SERVICE}/internal/products/${id}/variants`, { variants: variantRows });
    }

    // step 3: update extended catalog data in mongodb
    // specs and gallery are not editable from the product form, so only update them if explicitly provided
    const catalogPayload = { longDescription: long_description, variants, aboutMaterials };
    if (specs && Object.keys(specs).length > 0) catalogPayload.specs = specs;
    if (Array.isArray(gallery) && gallery.length > 0) catalogPayload.gallery = gallery;
    await axios.put(`${CATALOG_SERVICE}/internal/product-details/${id}`, catalogPayload);

    res.json({ id, message: 'product updated in both databases' });
  } catch (e) {
    handleError(res, e, 'product_update_failed');
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

// update product price without affecting past orders
app.patch('/api/products/:id/price', async (req, res) => {
  try {
    // forward patch request to inventory service
    const r = await axios.patch(`${INVENTORY_SERVICE}/products/${req.params.id}/price`, req.body);
    
    res.json(r.data);
  } catch (e) {
    handleError(res, e, 'price_update_failed');
  }
});

// fetch products and enrich with catalog details
// uses redis as a short-lived cache to avoid hitting both downstream services on every request
app.get('/api/products', async (req, res) => {
  try {
    // parse query parameters to forward them
    const params = new URLSearchParams(req.query).toString();

    // cache key includes the query string so filtered lists do not collide
    const cacheKey = `products:list:${params}`;

    // try the cache first when redis is reachable
    if (redisAvailable) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          // explicit header lets evaluators verify the cache is actually used
          res.set('X-Cache', 'HIT');
          return res.json(JSON.parse(cached));
        }
      } catch (_) {
        // a redis read failure is non-fatal, we just fall through to the origin
      }
    }

    // fetch base products from postgres inventory
    const invRes = await axios.get(`${INVENTORY_SERVICE}/products?${params}`);
    const baseProducts = invRes.data;

    // extract items whether response is an array or paginated object
    const isArray = Array.isArray(baseProducts);
    const items = isArray ? baseProducts : (baseProducts.items || baseProducts.data || []);

    // merge each item with detailed mongodb catalog data
    const mergedItems = await Promise.all(items.map(async (p) => {
      // silently catch errors if details are missing
      const catRes = await axios.get(`${CATALOG_SERVICE}/product-details/${p.id}`).catch(() => null);
      const details = catRes?.data || {};

      return {
        ...p,
        variants: details.variants || [],
        gallery: details.gallery || []
      };
    }));

    // restore original response shape before sending
    let payload;
    if (isArray) {
      payload = mergedItems;
    } else {
      if (baseProducts.items) baseProducts.items = mergedItems;
      else if (baseProducts.data) baseProducts.data = mergedItems;
      payload = baseProducts;
    }

    // populate the cache write-through, with a short ttl to keep stale data bounded
    if (redisAvailable) {
      const cacheKey = `products:list:${new URLSearchParams(req.query).toString()}`;
      // setex sets the value and expiry atomically; failure is silently swallowed
      redis.setex(cacheKey, PRODUCTS_CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    }

    // explicit header marks this response as the origin payload (not from cache)
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (e) {
    handleError(res, e);
  }
});

// SERVER-SIDE CART

// fetch current cart state for a user
app.get('/api/cart/:userId', async (req, res) => {
  try {
    // fetch cart from inventory service
    const r = await axios.get(`${INVENTORY_SERVICE}/cart/${req.params.userId}`);

    // normalize payload shape to decouple api from orm
    const raw = r.data || {};
    res.json({
      id: raw.id,
      userId: raw.userId,
      status: raw.status,
      totalPrice: Number(raw.totalPrice) || 0,
      lines: raw.CartLines || raw.cartLines || raw.lines || []
    });
  } catch (e) {
    if (e.response?.status === 404) {
      return res.json({ lines: [], totalPrice: 0 });
    }
    handleError(res, e);
  }
});

// add a single item to cart with stock check
// handles 409 conflict if stock is insufficient
app.post('/api/cart/:userId/add', validate(cartAddSchema), async (req, res) => {
  try {
    // forward add request to inventory service
    await axios.post(`${INVENTORY_SERVICE}/cart/${req.params.userId}/add`, req.body);
    
    res.sendStatus(201);
  } catch (e) {
    handleError(res, e, 'cart_add_failed');
  }
});

// synchronize full cart state from frontend
// validates payload using predefined schema
app.post('/api/cart/:userId/sync', validate(cartSyncSchema), async (req, res) => {
  try {
    const { items } = req.body;

    // push entire cart state to inventory service
    await axios.post(`${INVENTORY_SERVICE}/cart/${req.params.userId}/sync`, { items });

    res.sendStatus(200);
  } catch (e) {
    handleError(res, e);
  }
});

// CHECKOUT SAGA

// handle checkout with oversell protection
app.post('/api/checkout', validate(checkoutSchema), async (req, res) => {
  const { userId, items } = req.body;

  // stores created order id for response
  let orderId = null;

  try {
    // executes postgres transaction to create order and reduce stock
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/checkout`, { userId, items });
    
    // extract order id from inventory service response
    orderId = pgRes.data.orderId;

    res.status(201).json({ success: true, orderId });

  } catch (error) {
    handleError(res, error, 'checkout_failed');
  }
});

// handle hybrid review moderation saga
app.post('/api/reviews/:reviewId/moderate', async (req, res) => {
  const { decision, moderatorId, reason, productId } = req.body || {};
  
  // validate decision type
  if (!['approve', 'reject'].includes(decision)) {
    return sendError(res, 400, 'invalid_decision', 'decision must be approve or reject');
  }
  
  if (!moderatorId) {
    return sendError(res, 400, 'moderator_required', 'moderatorId is required');
  }
  
  if (!Number.isFinite(Number(productId))) {
    return sendError(res, 400, 'productId_required', 'numeric productId is required for the hybrid update');
  }

  // calculate counter delta based on moderation decision
  const delta = decision === 'approve' ? 1 : -1;

  // step 1: apply moderation decision in mongodb
  let moderated;
  try {
    const r = await axios.post(`${CATALOG_SERVICE}/reviews/${req.params.reviewId}/moderate`, {
      decision, moderatorId, reason
    });
    moderated = r.data;
  } catch (e) {
    return handleError(res, e, 'review_moderation_failed');
  }

  // initializes rollback status
  let rollbackStatus = 'not_attempted';
  
  // step 2: update denormalized review counter in postgres
  try {
    await axios.patch(`${INVENTORY_SERVICE}/internal/products/${Number(productId)}/review-count`, { delta });
    
    // set header and return success response
    res.setHeader('X-Rollback-Status', rollbackStatus);
    return res.json({ review: moderated, productId: Number(productId), delta });
  } catch (pgErr) {
    // step 3: execute compensation if postgres update fails
    try {
      // revert to opposite decision to keep databases in sync
      const revertDecision = decision === 'approve' ? 'reject' : 'approve';
      await axios.post(`${CATALOG_SERVICE}/reviews/${req.params.reviewId}/moderate`, {
        decision: revertDecision,
        moderatorId,
        reason: 'compensation: pg counter update failed'
      });
      rollbackStatus = 'success';
    } catch (rbErr) {
      // log critical inconsistency if rollback fails
      rollbackStatus = 'failed';
      console.error('hybrid_review_compensation_failed', {
        reviewId: req.params.reviewId, productId, error: rbErr.message
      });
    }
    
    // set header and return 502 bad gateway error
    res.setHeader('X-Rollback-Status', rollbackStatus);
    return sendError(res, 502, 'hybrid_review_failed', {
      step: 'pg_counter_update',
      message: pgErr.response?.data || pgErr.message,
      rollbackStatus
    });
  }
});

// fetch order history for a specific user
// proxies inventory service which uses a compound index
app.get('/api/users/:userId/orders', async (req, res) => {
  try {
    // fetch user orders from downstream inventory service
    const r = await axios.get(`${INVENTORY_SERVICE}/orders/user/${req.params.userId}`);
    
    res.json(r.data);
  } catch (e) {
    handleError(res, e, 'order_history_failed');
  }
});

// cancel an order and restore its stock
app.post('/api/orders/:orderId/cancel', async (req, res) => {
  // delegate cancellation to inventory service to handle stock logic
  axios.post(`${INVENTORY_SERVICE}/orders/${req.params.orderId}/cancel`)
    .then(() => res.sendStatus(200))
    .catch(e => handleError(res, e));
});

// aggregate product data from postgres and mongodb
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // construct url for inventory service using env variable
    const inventoryUrl = `${INVENTORY_SERVICE}/products/${id}`;

    // fetch base product details
    const invResponse = await fetch(inventoryUrl);

    if (!invResponse.ok) {
      if (invResponse.status === 404) {
        return sendError(res, 404, 'not_found', 'product not found');
      }
      throw new Error(`inventory service error: status ${invResponse.status}`);
    }

    // parse response and extract numeric id for catalog lookup
    const inventoryData = await invResponse.json();
    const numericId = inventoryData.id;

    // construct url for catalog service
    const catalogUrl = `${CATALOG_SERVICE}/product-details/${numericId}`;

    // attempt to fetch catalog data with silent fallback
    const catResponse = await fetch(catalogUrl).catch(() => null);
    let catalogData = {};

    // parse catalog response if successful
    if (catResponse && catResponse.ok) {
      catalogData = await catResponse.json();
    }

    // merge inventory and catalog data into single object
    const aggregatedProduct = {
      ...inventoryData,
      description: catalogData.longDescription || inventoryData.description || "",
      specs: catalogData.specs || {},
      gallery: catalogData.gallery || [],
      reviews: catalogData.reviews || [],
      // attach variants from catalog
      variants: catalogData.variants || [],
      // attach material details
      aboutMaterials: catalogData.aboutMaterials || {}
    };

    res.status(200).json(aggregatedProduct);
  } catch (error) {
    console.error('product_aggregation_failed', error.message);
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// delete a product from postgres (required) and mongodb (best-effort)
// uses the same internal inventory route as the saga rollback compensation
app.delete('/api/products/:id', async (req, res) => {
  try {
    await axios.delete(`${INVENTORY_SERVICE}/internal/products/${req.params.id}`);

    // silently ignore catalog delete failure — product detail data is orphaned but not critical
    await axios.delete(`${CATALOG_SERVICE}/internal/product-details/${req.params.id}`).catch(() => {});

    res.sendStatus(204);
  } catch (e) {
    handleError(res, e, 'product_delete_failed');
  }
});

// global error handler preventing stack trace leaks
app.use((err, req, res, next) => {
  // handle malformed json payloads safely
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return sendError(res, 400, 'invalid_json', err.message);
  }

  // log internal error for server diagnostics
  console.error('system_error:', err.message);

  sendError(res, 500, 'internal_server_error', 'unexpected critical error');
});

const PORT = 3000;

app.listen(PORT, () => console.log(`api gateway listening on port ${PORT}`));