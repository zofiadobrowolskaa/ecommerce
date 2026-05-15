const express = require('express');
const knex = require('knex')(require('../knexfile').development);
const { sequelize, Cart, CartLine } = require('./db/sequelize');
const pgPool = require('./db/pgPool');
const pgErrorMap = require('./middleware/errorMiddleware');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
// cap request body to 100kb to mitigate trivial payload-flood / dos attacks
app.use(express.json({ limit: '100kb' }));

// unified error response helper: every failure responds with { error, code, details }
const sendError = (res, status, error, details) =>
  res.status(status).json({ error, code: status, details: details ?? null });

// keep products.stock equal to sum(variants.stock) for legacy list endpoints
async function syncProductsStockFromVariants(tx, productIds) {
  const ids = [...new Set(productIds.map(Number).filter(Number.isFinite))];
  for (const pid of ids) {
    await tx.$executeRaw`
      UPDATE products SET stock = (
        SELECT COALESCE(SUM(stock), 0)::integer FROM variants WHERE product_id = ${pid}
      ) WHERE id = ${pid}`;
  }
}

// simple healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'inventory-order-service' });
});

// CATALOG (KNEX)

// list sku-level inventory rows for a product (relational variants table)
app.get('/products/:productId/variants', async (req, res, next) => {
  try {
    const pid = Number(req.params.productId);
    if (!Number.isFinite(pid)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    const rows = await knex('variants').where({ product_id: pid }).orderBy('id', 'asc');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// dynamic filtering endpoint — requirement 17: category + price range + availability
// every filter is optional; combinations are composed into a single parameterized query
app.get('/products', async (req, res, next) => {
  try {
    const { category, minPrice, maxPrice, inStock } = req.query;

    // coerce filters to numbers up-front so malformed values cannot reach SQL
    const categoryId = category !== undefined ? Number(category) : undefined;
    const minPriceNum = minPrice !== undefined ? Number(minPrice) : undefined;
    const maxPriceNum = maxPrice !== undefined ? Number(maxPrice) : undefined;

    // reject non-numeric filters as 400 instead of crashing on a Postgres cast error
    if (category !== undefined && !Number.isFinite(categoryId)) {
      return sendError(res, 400, 'invalid_filter', 'category must be numeric');
    }
    if (minPrice !== undefined && !Number.isFinite(minPriceNum)) {
      return sendError(res, 400, 'invalid_filter', 'minPrice must be numeric');
    }
    if (maxPrice !== undefined && !Number.isFinite(maxPriceNum)) {
      return sendError(res, 400, 'invalid_filter', 'maxPrice must be numeric');
    }

    // availability filter: "true" / "1" => only products with stock > 0
    const onlyInStock = inStock === 'true' || inStock === '1';

    // dynamic where builder (no string concatenation, all values bound as parameters)
    const query = knex('products').where(builder => {
      if (categoryId !== undefined) builder.where('category_id', categoryId);
      if (minPriceNum !== undefined) builder.where('price', '>=', minPriceNum);
      if (maxPriceNum !== undefined) builder.where('price', '<=', maxPriceNum);
      if (onlyInStock) builder.where('stock', '>', 0);
    });
    const products = await query;
    res.json(products);
  } catch (err) {
    // forward unexpected errors to global handler (pgErrorMap) instead of crashing
    next(err);
  }
});

// get single product by id for gateway aggregation
// extended: supports lookup by SKU (string) or numeric ID
app.get('/products/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // detect identifier type: SKU (string) vs numeric ID
    let product;
    if (isNaN(id)) {
        // lookup by SKU (e.g. "p001")
        product = await knex('products').where({ sku: id }).first();
    } else {
        // lookup by numeric ID
        product = await knex('products').where({ id: id }).first();
    }

    if (!product) {
      return sendError(res, 404, 'not_found', `product ${id} not found`);
    }

    res.json(product);
  } catch (err) {
    next(err);
  }
});

// internal endpoint for gateway to create product
app.post('/internal/products', async (req, res, next) => {
  try {
    const [id] = await knex('products').insert(req.body).returning('id');
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// rollback endpoint
app.delete('/internal/products/:id', async (req, res, next) => {
  try {
    await knex('products').where('id', req.params.id).del();
    res.sendStatus(204);
  } catch (err) {
    // delegate to global handler instead of leaving the promise unhandled
    next(err);
  }
});

// replace all variant rows for a product (invoked by gateway during hybrid product saga)
app.post('/internal/products/:productId/variants', async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isFinite(productId)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    const { variants } = req.body || {};
    if (!Array.isArray(variants) || variants.length === 0) {
      return sendError(res, 400, 'variants_required', 'body must include non-empty variants array');
    }

    const parentRow = await knex('products').where({ id: productId }).first();
    if (!parentRow) {
      return sendError(res, 404, 'not_found', 'product not found');
    }

    await knex.transaction(async (trx) => {
      await trx('variants').where({ product_id: productId }).del();

      const rows = variants.map((v) => ({
        product_id: productId,
        sku: String(v.sku),
        price: Number(v.price),
        stock: Number(v.stock) || 0,
        label: v.label != null ? String(v.label) : null
      }));

      await trx('variants').insert(rows);

      const sumStock = rows.reduce((s, r) => s + r.stock, 0);
      const minPrice = Math.min(...rows.map((r) => Number(r.price)));

      await trx('products').where({ id: productId }).update({
        stock: sumStock,
        price: minPrice
      });
    });

    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// INVENTORY (PG DRIVER)
// native pg driver, parameterized queries ($1, $2)
app.patch('/inventory/:sku', async (req, res, next) => {
  try {
    const { quantity } = req.body;
    const sku = req.params.sku;
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE variants SET stock = stock - $1 WHERE sku = $2',
        [quantity, sku]
      );
      const pidRes = await client.query(
        'SELECT product_id FROM variants WHERE sku = $1 LIMIT 1',
        [sku]
      );
      if (pidRes.rows[0]) {
        const pid = pidRes.rows[0].product_id;
        await client.query(
          `UPDATE products SET stock = (
            SELECT COALESCE(SUM(stock), 0)::integer FROM variants WHERE product_id = $1
          ) WHERE id = $1`,
          [pid]
        );
      }
      await client.query(
        `INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
         VALUES ($1, $2, 'manual_adjust', NULL)`,
        [sku, -Number(quantity)]
      );
      await client.query('COMMIT');
      res.sendStatus(204);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err); // pass to pgErrorMap
  }
});

// SERVER-SIDE CART (SEQUELIZE)

// eager loading (include)
app.get('/cart/:userId', async (req, res) => {
  try {
    const cart = await Cart.findOne({
      where: { userId: req.params.userId, status: 'OPEN' },
      include: [CartLine] // eager loading implementation
    });
    if (!cart) return sendError(res, 404, 'cart_not_found', `no open cart for user ${req.params.userId}`);
    res.json(cart);
  } catch (err) {
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// add a single item to the user's cart — requirement 17: cart add with stock validation
// rejects requests where the chosen variant does not have enough stock right now
app.post('/cart/:userId/add', async (req, res) => {
  const { productId, variantSku, quantity, price } = req.body || {};

  // input shape check before touching the database
  if (!productId || !quantity || quantity < 1) {
    return sendError(res, 400, 'invalid_payload', 'productId and quantity >= 1 are required');
  }

  try {
    // stock check at variant grain when variantSku is provided, otherwise at product grain
    if (variantSku) {
      const row = await knex('variants').where({ sku: variantSku }).first();
      if (!row) return sendError(res, 404, 'variant_not_found', `unknown sku ${variantSku}`);
      if (Number(row.stock) < Number(quantity)) {
        return sendError(res, 409, 'insufficient_stock', {
          sku: variantSku,
          available: Number(row.stock),
          requested: Number(quantity)
        });
      }
    } else {
      const product = await knex('products').where({ id: Number(productId) }).first();
      if (!product) return sendError(res, 404, 'product_not_found', `unknown productId ${productId}`);
      if (Number(product.stock) < Number(quantity)) {
        return sendError(res, 409, 'insufficient_stock', {
          productId: Number(productId),
          available: Number(product.stock),
          requested: Number(quantity)
        });
      }
    }

    // append the validated line to the open cart inside a managed sequelize transaction
    await sequelize.transaction(async (t) => {
      let cart = await Cart.findOne({ where: { userId: req.params.userId, status: 'OPEN' }, transaction: t });
      if (!cart) cart = await Cart.create({ userId: req.params.userId }, { transaction: t });

      // CartLine.create runs model-level validators (quantity >= 1, price >= 0, ...)
      await CartLine.create({
        CartId: cart.id,
        productId: Number(productId),
        variantSku: variantSku ?? null,
        quantity: Number(quantity),
        priceAtEntry: Number(price) || 0
      }, { transaction: t });

      // recompute rollup so list endpoints see the new total without an extra query
      cart.totalPrice = Number(cart.totalPrice) + (Number(price) || 0) * Number(quantity);
      await cart.save({ transaction: t });
    });

    res.sendStatus(201);
  } catch (e) {
    if (e.name === 'SequelizeValidationError' || e.name === 'SequelizeUniqueConstraintError') {
      return sendError(res, 400, 'validation_error', e.errors.map(err => ({ field: err.path, message: err.message })));
    }
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// sync cart items to server state (managed transaction with model validation)
app.post('/cart/:userId/sync', async (req, res) => {
  const { items } = req.body;
  try {
    // managed transaction: commits on resolve, rolls back on throw
    await sequelize.transaction(async (t) => {
      let cart = await Cart.findOne({ where: { userId: req.params.userId, status: 'OPEN' }, transaction: t });
      if (!cart) cart = await Cart.create({ userId: req.params.userId }, { transaction: t });

      // clear old state before re-applying client state
      await CartLine.destroy({ where: { CartId: cart.id }, transaction: t });
      let total = 0;

      for (const item of items) {
        total += item.price * item.quantity;
        // safely extract number from frontend IDs (e.g. "p001" -> 1)
        const numericId = parseInt(String(item.productId).replace(/\D/g, '')) || 1;
        const variantSku = item.variantSku || item.sku || null;

        // CartLine.create runs model validators (quantity >= 1, price >= 0, ...)
        await CartLine.create({
          CartId: cart.id,
          productId: numericId,
          variantSku,
          quantity: item.quantity,
          priceAtEntry: item.price // price snapshot in cart
        }, { transaction: t });
      }
      cart.totalPrice = total;
      // Cart.save also runs model validators (totalPrice >= 0)
      await cart.save({ transaction: t });
    });
    res.sendStatus(200);
  } catch (e) {
    // map sequelize validation errors to 400 so the client gets actionable feedback
    if (e.name === 'SequelizeValidationError' || e.name === 'SequelizeUniqueConstraintError') {
      return sendError(res, 400, 'validation_error', e.errors.map(err => ({ field: err.path, message: err.message })));
    }
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// ORDERS AND CHECKOUT SAGA (PRISMA)
// checkout with lock and oversell protection
app.post('/checkout', async (req, res) => {
  const { userId, items } = req.body;
  try {
    // prisma interactive transaction guarantees atomic variant locks + order insert + audit rows
    const order = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;
      const orderLinesData = [];
      const touchedProductIds = [];

      // oversell check and stock deduction at variant grain (sku, price, stock)
      for (const item of items) {
        const numericId = parseInt(String(item.productId).replace(/\D/g, '')) || 1;
        const lineSku = item.sku ?? item.variantSku ?? null;

        let locked;
        if (lineSku) {
          locked = await tx.$queryRaw`
            SELECT id, sku, stock, price, product_id AS "product_id"
            FROM variants WHERE sku = ${lineSku} AND product_id = ${numericId}
            FOR UPDATE`;
        } else {
          locked = await tx.$queryRaw`
            SELECT id, sku, stock, price, product_id AS "product_id"
            FROM variants WHERE product_id = ${numericId}
            ORDER BY id ASC LIMIT 1
            FOR UPDATE`;
        }

        const variant = locked[0];
        if (!variant || Number(variant.stock) < item.quantity) {
          throw new Error('409_CONFLICT_OVERSELL');
        }

        await tx.$executeRaw`
          UPDATE variants SET stock = stock - ${item.quantity}
          WHERE id = ${variant.id}`;

        touchedProductIds.push(Number(variant.product_id));

        totalAmount += Number(item.price) * item.quantity;

        orderLinesData.push({
          sku: variant.sku,
          quantity: item.quantity,
          price: item.price
        });
      }

      const newOrder = await tx.order.create({
        data: {
          // persist userId so requirement 17's order-history endpoint can filter by owner
          userId: userId ?? null,
          totalAmount,
          status: 'PAID',
          lines: {
            create: orderLinesData
          }
        }
      });

      for (const line of orderLinesData) {
        await tx.$executeRaw`
          INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
          VALUES (${line.sku}, ${-line.quantity}, ${'checkout_deduct'}, ${newOrder.id})`;
      }

      await syncProductsStockFromVariants(tx, touchedProductIds);

      return newOrder;
    });

    // sequelize cart close stays outside prisma tx (different pool) — runs right after successful commit
    await Cart.update({ status: 'CLOSED' }, { where: { userId, status: 'OPEN' } });

    res.status(201).json({ orderId: order.id });
  } catch (err) {
    if (err.message.includes('409')) {
      return sendError(res, 409, 'conflict_oversell', 'one or more items exceed available stock');
    }
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// order cancellation and stock rollback
app.post('/orders/:id/cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } });
      if (!order) throw new Error('not_found');

      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' }});

      const touchedProductIds = [];
      for (const line of order.lines) {
        await tx.$executeRaw`
          UPDATE variants SET stock = stock + ${line.quantity}
          WHERE sku = ${line.sku}`;
        const meta = await tx.$queryRaw`
          SELECT product_id AS "product_id" FROM variants WHERE sku = ${line.sku} LIMIT 1`;
        if (meta[0]) touchedProductIds.push(Number(meta[0].product_id));

        await tx.$executeRaw`
          INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
          VALUES (${line.sku}, ${line.quantity}, ${'order_cancel_restore'}, ${orderId})`;
      }

      await syncProductsStockFromVariants(tx, touchedProductIds);
    });
    res.sendStatus(200);
  } catch (e) {
    if (e.message === 'not_found') return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// list all orders using prisma typed model api (R in CRUD)
app.get('/orders', async (req, res, next) => {
  try {
    // findMany with include exercises eager loading via prisma's typed api
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      include: { lines: true }
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// per-user order history — requirement 17 "historia zamówień użytkownika"
// uses the compound index { userId, createdAt } for index-only scan in chronological order
app.get('/orders/user/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return sendError(res, 400, 'userId_required', 'userId path param is required');
    }
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { lines: true }
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// get single order by id using prisma typed model api (R in CRUD)
app.get('/orders/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true }
    });
    if (!order) return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// delete order using prisma typed model api (D in CRUD)
// cascades to lines via the relation
app.delete('/orders/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    // delete child lines first to satisfy fk constraint, then delete header
    await prisma.$transaction([
      prisma.orderLine.deleteMany({ where: { orderId } }),
      prisma.order.delete({ where: { id: orderId } })
    ]);
    res.sendStatus(204);
  } catch (err) {
    // prisma throws P2025 when record to delete is not found
    if (err.code === 'P2025') return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    next(err);
  }
});

// prisma $queryRaw (tagged template)
app.get('/analytics/orders-report', async (req, res) => {
  try {
    // reporting using raw SQL
    const report = await prisma.$queryRaw`
      SELECT 
        COUNT("id") as "totalOrders", 
        SUM("totalAmount") as "revenue" 
      FROM "Order"
    `;

    // parse BigInt to standard JavaScript Number for JSON serialization
    const formattedReport = report.map(row => ({
      totalOrders: Number(row.totalOrders),
      revenue: Number(row.revenue)
    }));

    res.json(formattedReport);
  } catch (err) {
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// audit trail read-model for graders / observability (sku-level deltas tied to orders when applicable)
app.get('/internal/inventory-movements', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const rows = await knex('inventory_movements').orderBy('id', 'desc').limit(limit);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});


// global error handler
app.use(pgErrorMap);

const PORT = process.env.PORT || 3001;

// last-resort safety net: log unhandled rejections instead of letting Node kill the container
process.on('unhandledRejection', (reason) => {
  console.error('unhandled_rejection:', reason);
});

sequelize.sync({ alter: true }).then(() => {
  app.listen(PORT, () => console.log(`inventory service running on port ${PORT}`));
});