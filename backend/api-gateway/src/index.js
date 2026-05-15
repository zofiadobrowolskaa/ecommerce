const express = require('express');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swaggerDocs');
const { validate, productSchema, cartSyncSchema, checkoutSchema } = require('./validators');

const app = express();

// allow CORS for frontend communication
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

  // aggregate variant stocks so postgres products.stock reflects the real available inventory
  // (variants are kept in mongo as denormalized data; pg holds the transactional total)
  const aggregatedStock = Array.isArray(variants)
    ? variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0)
    : 0;

  // will store ID of product created in postgres (needed for step 2 and rollback)
  let createdProductId = null;

  try {
    // step 1: save base product data to postgres (inventory service)
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/internal/products`, {
      name,
      sku,
      price,
      category_id,
      stock: aggregatedStock
    });

    // handle different response shapes (id can be nested or primitive)
    createdProductId =
      typeof pgRes.data.id === 'object'
        ? pgRes.data.id.id
        : pgRes.data.id;

    // step 2: save product details to mongo (catalog service)
    await axios.post(`${CATALOG_SERVICE}/internal/product-details`, {
      productId: createdProductId, 
      longDescription: long_description || req.body.description, // fallback support for legacy field
      specs,
      variants, // store variants in catalog
      aboutMaterials, // store additional material info
      gallery // store product gallery
    });

    // success: both operations completed
    res.status(201).json({
      id: createdProductId,
      message: 'product created in both databases'
    });

  } catch (error) {
    // track rollback attempt status for observability/debugging
    let rollbackStatus = 'not_attempted';

    // compensation: if step 2 (mongo) failed, undo step 1 (pg) by deleting the row
    if (createdProductId) {
      try {
        await axios.delete(`${INVENTORY_SERVICE}/internal/products/${createdProductId}`);
        rollbackStatus = 'success';
      } catch (rbError) {
        // rollback failure leaves the system inconsistent - emit a loud log entry
        rollbackStatus = 'failed';
        console.error('saga_compensation_failed', { productId: createdProductId, error: rbError.message });
      }
    }

    // expose rollback outcome via a response header so the body stays in the
    // strict { error, code, details }
    res.setHeader('X-Rollback-Status', rollbackStatus);

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

// proxy product list: fetch base products from inventory and enrich with catalog details
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

// sync entire cart state from frontend to backend
// applied validation
app.post('/api/cart/:userId/sync', validate(cartSyncSchema), async (req, res) => {
  try {
    const { items } = req.body;

    // update cart in inventory service (main persistence layer)
    await axios.post(`${INVENTORY_SERVICE}/cart/${req.params.userId}/sync`, { items });
    
    // save cart draft in mongo for analytics (fire and forget, should not break main flow)
    axios.post(`${CATALOG_SERVICE}/cart-draft/${req.params.userId}/add`, { items }).catch(() => {});
    
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
    // step 1: transaction in postgres (price snapshot, reduce stock, create order)
    const pgRes = await axios.post(`${INVENTORY_SERVICE}/checkout`, { userId, items });
    orderId = pgRes.data.orderId;

    // step 2: close draft / emit event in mongo (telemetry / analytics)
    await axios.post(`${CATALOG_SERVICE}/telemetry/event`, {
      action: 'checkout_completed',
      userId,
      details: `order_${orderId}`
    });

    res.status(201).json({ success: true, orderId });

  } catch (error) {
    // oversell (race condition on stock) will typically return 409 from inventory service
    // note: no compensation here -> inventory service owns transaction consistency
    handleError(res, error, 'checkout_failed');
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
  // log internal error (should be replaced with structured logging in production)
  console.error('system_error:', err.message);

  // do not leak internals to client; respond in the unified { error, code, details } shape
  sendError(res, 500, 'internal_server_error', 'unexpected critical error');
});

const PORT = 3000;
app.listen(PORT, () => console.log(`api gateway listening on port ${PORT}`));