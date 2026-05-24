const express = require('express');
const knex = require('knex')(require('../knexfile').development);
const { sequelize, Cart, CartLine } = require('./db/sequelize');
const pgPool = require('./db/pgPool');
const pgErrorMap = require('./middleware/errorMiddleware');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.use(express.json());

// formats unified error response containing error, code, and details
const sendError = (res, status, error, details) =>
  res.status(status).json({ error, code: status, details: details ?? null });

// synchronizes base product stock with the sum of its variants for legacy support
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

// fetches product categories sorted by id for deterministic testing
app.get('/categories', async (req, res, next) => {
  try {
    // retrieves id and name from categories table
    const rows = await knex('categories').select('id', 'name').orderBy('id', 'asc');
    
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// fetches sku-level inventory variants for a specific product
app.get('/products/:productId/variants', async (req, res, next) => {
  try {
    const pid = Number(req.params.productId);
    if (!Number.isFinite(pid)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    
    // retrieves variants for the product sorted by id
    const rows = await knex('variants').where({ product_id: pid }).orderBy('id', 'asc');
    
    res.json(rows);
  } catch (err) {
    // delegates errors to standard error handler
    next(err);
  }
});

// fetch products with dynamic filters (category, price, stock)
// includes min_price and max_price computed from inventory variants via a single left join
app.get('/products', async (req, res, next) => {
  try {
    const { category, minPrice, maxPrice, inStock } = req.query;

    // convert query strings to numbers to ensure type safety
    const categoryId = category !== undefined ? Number(category) : undefined;
    const minPriceNum = minPrice !== undefined ? Number(minPrice) : undefined;
    const maxPriceNum = maxPrice !== undefined ? Number(maxPrice) : undefined;

    // validate inputs. Return 400 Bad Request if parsed values are not valid numbers
    if (category !== undefined && !Number.isFinite(categoryId)) {
      return sendError(res, 400, 'invalid_filter', 'category must be numeric');
    }
    if (minPrice !== undefined && !Number.isFinite(minPriceNum)) {
      return sendError(res, 400, 'invalid_filter', 'minPrice must be numeric');
    }
    if (maxPrice !== undefined && !Number.isFinite(maxPriceNum)) {
      return sendError(res, 400, 'invalid_filter', 'maxPrice must be numeric');
    }

    // parse boolean flag to check if only available products should be returned
    const onlyInStock = inStock === 'true' || inStock === '1';

    // left join with variants to compute actual min/max prices in a single query
    const query = knex('products as p')
      .leftJoin('variants as v', 'v.product_id', 'p.id')
      .select('p.*')
      .min('v.price as min_price')
      .max('v.price as max_price')
      .groupBy('p.id')
      .where(builder => {
        if (categoryId !== undefined) builder.where('p.category_id', categoryId);
        if (minPriceNum !== undefined) builder.where('p.price', '>=', minPriceNum);
        if (maxPriceNum !== undefined) builder.where('p.price', '<=', maxPriceNum);
        if (onlyInStock) builder.where('p.stock', '>', 0);
      });
    const products = await query;
    res.json(products);
  } catch (err) {
    // forward errors to global handler pgErrorMap
    next(err);
  }
});

// fetches single product by id or sku for gateway aggregation
app.get('/products/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // determines if identifier is sku string or numeric id
    let product;
    if (isNaN(id)) {
        // retrieves product by sku
        product = await knex('products').where({ sku: id }).first();
    } else {
        // retrieves product by numeric id
        product = await knex('products').where({ id: id }).first();
    }

    if (!product) {
      return sendError(res, 404, 'not_found', `product ${id} not found`);
    }

    res.json(product);
  } catch (err) {
    // forwards errors to global error handler
    next(err);
  }
});

// updates product price without affecting historical order line snapshots
app.patch('/products/:id/price', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { price } = req.body || {};
    
    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    
    // ensures price is a valid non-negative number
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      return sendError(res, 400, 'invalid_price', 'price must be a non-negative number');
    }

    // updates price in products table only and returns new data
    const updated = await knex('products').where({ id }).update({ price }).returning(['id', 'sku', 'price']);
    
    if (!updated.length) {
      return sendError(res, 404, 'not_found', `product ${id} not found`);
    }
    
    // sends updated product data as json response
    res.json(updated[0]);
  } catch (err) {
    // forwards errors to global error handler
    next(err);
  }
});

// updates denormalized review counter triggered by gateway saga
// restricts delta to +1 or -1 to prevent arbitrary manipulation
app.patch('/internal/products/:productId/review-count', async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const delta = Number(req.body?.delta);
 
    if (!Number.isFinite(productId)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    
    // ensures delta is exactly +1 or -1
    if (![1, -1].includes(delta)) {
      return sendError(res, 400, 'invalid_delta', 'delta must be +1 or -1');
    }

    // performs atomic update ensuring counter never drops below zero
    const updated = await knex('products')
      .where({ id: productId })
      .update({
        review_count: knex.raw('GREATEST(review_count + ?, 0)', [delta])
      })
      .returning(['id', 'review_count']);

    if (!updated.length) {
      return sendError(res, 404, 'not_found', `product ${productId} not found`);
    }
    
    res.json(updated[0]);
  } catch (err) {
    // forwards errors to global error handler
    next(err);
  }
});

// creates base product record initiated by gateway
app.post('/internal/products', async (req, res, next) => {
  try {
    const [id] = await knex('products').insert(req.body).returning('id');
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// handles rollback by deleting product record
app.delete('/internal/products/:id', async (req, res, next) => {
  try {
    await knex('products').where('id', req.params.id).del();
    res.sendStatus(204);
  } catch (err) {
    // forwards unhandled promise errors to global handler
    next(err);
  }
});

// updates editable base product fields (name, category, price) without touching stock or variants
app.patch('/internal/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendError(res, 400, 'invalid_id', 'id must be numeric');
    
    const { name, category_id, price } = req.body;
    const updates = {};

    if (name !== undefined) updates.name = name;
    if (category_id !== undefined) updates.category_id = Number(category_id);
    if (price !== undefined) updates.price = Number(price);
    if (!Object.keys(updates).length) return sendError(res, 400, 'no_fields', 'at least one field is required');

    const updated = await knex('products').where({ id }).update(updates).returning('*');
    if (!updated.length) return sendError(res, 404, 'not_found', `product ${id} not found`);

    res.json(updated[0]);
  } catch (err) { 
    next(err); 
  }
});

// replaces variant rows for a product during hybrid saga
app.post('/internal/products/:productId/variants', async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isFinite(productId)) {
      return sendError(res, 400, 'invalid_id', 'productId must be numeric');
    }
    
    // ensures variants array is provided and not empty
    const { variants } = req.body || {};
    if (!Array.isArray(variants) || variants.length === 0) {
      return sendError(res, 400, 'variants_required', 'body must include non-empty variants array');
    }

    // verifies parent product exists before proceeding
    const parentRow = await knex('products').where({ id: productId }).first();
    if (!parentRow) {
      return sendError(res, 404, 'not_found', 'product not found');
    }

    // executes transaction to safely replace variants
    await knex.transaction(async (trx) => {
      // removes existing variants for the product
      await trx('variants').where({ product_id: productId }).del();

      // formats new variant rows for insertion
      const rows = variants.map((v) => ({
        product_id: productId,
        sku: String(v.sku),
        price: Number(v.price),
        stock: Number(v.stock) || 0,
        label: v.label != null ? String(v.label) : null
      }));

      // inserts new variant rows
      await trx('variants').insert(rows);

      // calculates total stock and minimum price from new variants
      const sumStock = rows.reduce((s, r) => s + r.stock, 0);
      const minPrice = Math.min(...rows.map((r) => Number(r.price)));

      // updates parent product with aggregated stock and minimum price
      await trx('products').where({ id: productId }).update({
        stock: sumStock,
        price: minPrice
      });
    });

    res.sendStatus(204);
  } catch (err) {
    // forwards errors to global error handler
    next(err);
  }
});

// INVENTORY (PG DRIVER)
// native pg driver, parameterized queries ($1, $2)
app.patch('/inventory/:sku', async (req, res, next) => {
  try {
    const { quantity } = req.body;
    const sku = req.params.sku;
    // get a db connection from the connection pool
    const client = await pgPool.connect();

    try {
      // manual transaction
      await client.query('BEGIN');

      // deduct stock for variant. $1 and $2 are safe parameters (prevents SQL injection)
      await client.query(
        'UPDATE variants SET stock = stock - $1 WHERE sku = $2',
        [quantity, sku]
      );

      // fetch the parent product id for this specific sku
      const parentId = await client.query(
        'SELECT product_id FROM variants WHERE sku = $1 LIMIT 1',
        [sku]
      );

      // if the variant exists, update its parent product's total stock
      if (parentId.rows[0]) {
        const pid = parentId.rows[0].product_id;

        await client.query(
          `UPDATE products SET stock = (
            SELECT COALESCE(SUM(stock), 0)::integer FROM variants WHERE product_id = $1
          ) WHERE id = $1`,
          [pid]
        );
      }

      // log this stock change in the movement history table
      await client.query(
        `INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
         VALUES ($1, $2, 'manual_adjust', NULL)`,
        [sku, -Number(quantity)]
      );

      // save all transaction changes permanently to the database
      await client.query('COMMIT');
      res.sendStatus(204);
    } catch (e) {

      await client.query('ROLLBACK');
      throw e;
    } finally {
      // always release back to pool, even on error - prevents connection leak
      client.release();
    }
  } catch (err) {
    next(err); // delegates to pgErrorMap global handler
  }
});

// SERVER-SIDE CART (SEQUELIZE)

// fetch a user's open cart along with all its items
app.get('/cart/:userId', async (req, res) => {
  try {
    const cart = await Cart.findOne({
      where: { userId: req.params.userId, status: 'OPEN' },
      
      // eager loading: automatically executes a sql join to fetch related CartLine records
      include: [CartLine] 
    });

    if (!cart) {
      return sendError(res, 404, 'cart_not_found', `no open cart for user ${req.params.userId}`);
    }
    res.json(cart);

  } catch (err) {
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// add an item to the user's cart
app.post('/cart/:userId/add', async (req, res) => {
  const { productId, variantSku, quantity, price } = req.body || {};

  // validate required fields before hitting the database
  if (!productId || !quantity || quantity < 1) {
    return sendError(res, 400, 'invalid_payload', 'productId and quantity >= 1 are required');
  }

  try {
    // check stock availability for a specific variant if provided
    if (variantSku) {
      const row = await knex('variants').where({ sku: variantSku }).first();
      if (!row) return sendError(res, 404, 'variant_not_found', `unknown sku ${variantSku}`);
      
      // return 409 conflict if requested quantity exceeds available stock
      if (Number(row.stock) < Number(quantity)) {
        return sendError(res, 409, 'insufficient_stock', {
          sku: variantSku,
          available: Number(row.stock),
          requested: Number(quantity)
        });
      }
    } else {
      // check stock availability for the general product
      const product = await knex('products').where({ id: Number(productId) }).first();
      if (!product) return sendError(res, 404, 'product_not_found', `unknown productId ${productId}`);
      
      // return 409 conflict if requested quantity exceeds available stock
      if (Number(product.stock) < Number(quantity)) {
        return sendError(res, 409, 'insufficient_stock', {
          productId: Number(productId),
          available: Number(product.stock),
          requested: Number(quantity)
        });
      }
    }

    // start auto-managed database transaction (auto-commits or rollbacks on error)
    await sequelize.transaction(async (t) => {
      // find existing open cart for the user or create a new one
      let cart = await Cart.findOne({ where: { userId: req.params.userId, status: 'OPEN' }, transaction: t });
      if (!cart) cart = await Cart.create({ userId: req.params.userId }, { transaction: t });

      // insert item into cart. runs model validations before saving
      await CartLine.create({
        CartId: cart.id,
        productId: Number(productId),
        variantSku: variantSku ?? null,
        quantity: Number(quantity),
        priceAtEntry: Number(price) || 0
      }, { transaction: t });

      // recalculate and save the updated total cart price
      cart.totalPrice = Number(cart.totalPrice) + (Number(price) || 0) * Number(quantity);
      await cart.save({ transaction: t });
    });

    res.sendStatus(201);
  } catch (e) {
    if (e.name === 'SequelizeValidationError' || e.name === 'SequelizeUniqueConstraintError') {
      return sendError(res, 400, 'validation_error', e.errors.map(err => ({ field: err.path, message: err.message })));
    }
    // fallback to 500 internal server error for unhandled exceptions
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// sync frontend cart state with database
app.post('/cart/:userId/sync', async (req, res) => {
  const { items } = req.body;
  
  try {
    // start auto-managed transaction (commits on success, rolls back on error)
    await sequelize.transaction(async (t) => {
      // find user's open cart or create a new one
      let cart = await Cart.findOne({ where: { userId: req.params.userId, status: 'OPEN' }, transaction: t });
      if (!cart) cart = await Cart.create({ userId: req.params.userId }, { transaction: t });

      // delete all existing items in the cart to sync state
      await CartLine.destroy({ where: { CartId: cart.id }, transaction: t });
      let total = 0;

      // loop through items to calculate total and insert them
      for (const item of items) {
        total += item.price * item.quantity;
        
        // extract numeric product id from string (e.g. "p001" -> 1)
        const numericId = parseInt(String(item.productId).replace(/\D/g, '')) || 1;
        const variantSku = item.variantSku || item.sku || null;

        // add item to cart, triggering model validations
        await CartLine.create({
          CartId: cart.id,
          productId: numericId,
          variantSku,
          quantity: item.quantity,
          priceAtEntry: item.price // save current price snapshot
        }, { transaction: t });
      }
      
      cart.totalPrice = total;
      // update total price and validate
      await cart.save({ transaction: t });
    });
    
    res.sendStatus(200);
  } catch (e) {
    if (e.name === 'SequelizeValidationError' || e.name === 'SequelizeUniqueConstraintError') {
      return sendError(res, 400, 'validation_error', e.errors.map(err => ({ field: err.path, message: err.message })));
    }
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// ORDERS AND CHECKOUT SAGA (PRISMA)

// C in prisma CRUD:
// creates order and orderlines atomically with stock deduction and lock
app.post('/checkout', async (req, res) => {
  const { userId, items } = req.body;
  try {
    // start auto-managed prisma transaction
    const order = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;
      const orderLinesData = [];
      const touchedProductIds = [];

      // check stock and deduct at variant level
      for (const item of items) {
        const numericId = parseInt(String(item.productId).replace(/\D/g, '')) || 1;
        const lineSku = item.sku ?? item.variantSku ?? null;

        let locked;
        // safely fetch and lock row (FOR UPDATE) to prevent concurrent oversell
        if (lineSku) {
          // lock the exact variant row so concurrent checkouts wait
          locked = await tx.$queryRaw`
            SELECT id, sku, stock, price, product_id AS "product_id"
            FROM variants WHERE sku = ${lineSku} AND product_id = ${numericId}
            FOR UPDATE`;
        } else {
          // lock the first available variant for this product
          locked = await tx.$queryRaw`
            SELECT id, sku, stock, price, product_id AS "product_id"
            FROM variants WHERE product_id = ${numericId}
            ORDER BY id ASC LIMIT 1
            FOR UPDATE`;
        }

        // extract the locked database record
        const variant = locked[0];
        // fail if not found or requested quantity exceeds available stock
        if (!variant || Number(variant.stock) < item.quantity) {
          throw new Error('409_conflict_oversell');
        }

        // deduct the requested quantity from the variant's stock
        await tx.$executeRaw`
          UPDATE variants SET stock = stock - ${item.quantity}
          WHERE id = ${variant.id}`;

        // store product id to sync its parent stock later
        touchedProductIds.push(Number(variant.product_id));

        // add item cost to the running order total
        totalAmount += Number(item.price) * item.quantity;

        // save item details for the final order lines insert
        orderLinesData.push({
          sku: variant.sku,
          quantity: item.quantity,
          price: item.price
        });
      }

      // create order and nested order lines in one typed query
      const newOrder = await tx.order.create({
        data: {
          userId: userId ?? null,
          totalAmount,
          status: 'PAID',
          lines: {
            create: orderLinesData // insert related order lines atomically
          }
        }
      });

      // log inventory movements
      for (const line of orderLinesData) {
        await tx.$executeRaw`
          INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
          VALUES (${line.sku}, ${-line.quantity}, ${'checkout_deduct'}, ${newOrder.id})`;
      }

      // recalculate total product stock
      await syncProductsStockFromVariants(tx, touchedProductIds);

      return newOrder;
    });

    // close cart outside prisma transaction using sequelize
    await Cart.update({ status: 'CLOSED' }, { where: { userId, status: 'OPEN' } });

    res.status(201).json({ orderId: order.id });
  } catch (err) {
    if (err.message.includes('409')) {
      return sendError(res, 409, 'conflict_oversell', 'one or more items exceed available stock');
    }
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// U in prisma CRUD
// cancel order and restore stock
app.post('/orders/:id/cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    // start auto-managed prisma transaction
    await prisma.$transaction(async (tx) => {
      // fetch order and its associated items
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } });
      if (!order) throw new Error('not_found');

      // mark the order as cancelled in the database
      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' }});

      // track products to update their total stock later
      const touchedProductIds = [];
      
      // iterate through each item in the cancelled order
      for (const line of order.lines) {
        // add cancelled quantity back to variant stock
        await tx.$executeRaw`
          UPDATE variants SET stock = stock + ${line.quantity}
          WHERE sku = ${line.sku}`;
          
        // find the parent product id for this variant
        const parentProductId = await tx.$queryRaw`
          SELECT product_id AS "product_id" FROM variants WHERE sku = ${line.sku} LIMIT 1`;
          
        // store parent product id for stock synchronization
        if (parentProductId[0]) touchedProductIds.push(Number(parentProductId[0].product_id));

        await tx.$executeRaw`
          INSERT INTO inventory_movements (sku, quantity_delta, reason, order_id)
          VALUES (${line.sku}, ${line.quantity}, ${'order_cancel_restore'}, ${orderId})`;
      }

      // recalculate total stock for all affected products
      await syncProductsStockFromVariants(tx, touchedProductIds);
    });
    
    res.sendStatus(200);
  } catch (e) {
    if (e.message === 'not_found') return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    sendError(res, 500, 'internal_server_error', e.message);
  }
});

// R in prisma CRUD: fetch all orders along with their items
app.get('/orders', async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      include: { lines: true } // eagerly load related order lines (executes sql join)
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// fetches user order history using compound index for sorting
app.get('/orders/user/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return sendError(res, 400, 'userId_required', 'userId path param is required');
    }
    
    // retrieves orders with lines sorted descending by date
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

// R in prisma CRUD: fetch a single order by its unique id
app.get('/orders/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true } // automatically join and return associated order items
    });
    if (!order) return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// D in prisma CRUD: delete order and its lines atomically
app.delete('/orders/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    // run array of queries sequentially in a single transaction
    await prisma.$transaction([
      // delete related items first to prevent foreign key constraint errors
      prisma.orderLine.deleteMany({ where: { orderId } }),
      
      // delete the main order record after items are removed
      prisma.order.delete({ where: { id: orderId } })
    ]);
    res.sendStatus(204);
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 404, 'not_found', `order ${req.params.id} not found`);
    next(err);
  }
});

// endpoint for sales analytics using raw sql queries
app.get('/analytics/orders-report', async (req, res) => {
  try {
    // execute raw sql for aggregations using tagged templates
    // variables inside template are automatically parameterized to prevent injection
    const report = await prisma.$queryRaw`
      SELECT
        COUNT("id") as "totalOrders",
        SUM("totalAmount") as "revenue"
      FROM "Order"
    `;

    // convert prisma bigint results to standard javascript numbers
    // json serialization fails on raw bigint types
    const formattedReport = report.map(row => ({
      totalOrders: Number(row.totalOrders),
      revenue: Number(row.revenue)
    }));

    res.json(formattedReport);
  } catch (err) {
    sendError(res, 500, 'internal_server_error', err.message);
  }
});

// fetches inventory movement audit trail for observability
app.get('/internal/inventory-movements', async (req, res, next) => {
  try {
    // parses limit query parameter with a maximum cap of 100
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    
    // retrieves latest movements sorted descending by id
    const rows = await knex('inventory_movements').orderBy('id', 'desc').limit(limit);
    
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// applies global postgres error handler
app.use(pgErrorMap);

const PORT = process.env.PORT || 3001;

// catches unhandled promise rejections to prevent process crash
process.on('unhandledRejection', (reason) => {
  console.error('unhandled_rejection:', reason);
});

// synchronizes database schema and starts server
sequelize.sync({ alter: true }).then(() => {
  app.listen(PORT, () => console.log(`inventory service running on port ${PORT}`));
});