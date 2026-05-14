const express = require('express');
const knex = require('knex')(require('../knexfile').development);
const { sequelize, Cart, CartLine } = require('./db/sequelize');
const pgPool = require('./db/pgPool');
const pgErrorMap = require('./middleware/errorMiddleware');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.use(express.json());

// simple healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'inventory-order-service' });
});

// CATALOG (KNEX)

// dynamic filtering endpoint
app.get('/products', async (req, res, next) => {
  try {
    const { category, maxPrice } = req.query;

    // coerce filters to numbers up-front so malformed values cannot reach SQL
    const categoryId = category !== undefined ? Number(category) : undefined;
    const maxPriceNum = maxPrice !== undefined ? Number(maxPrice) : undefined;

    // reject non-numeric filters as 400 instead of crashing on a Postgres cast error
    if (category !== undefined && !Number.isFinite(categoryId)) {
      return res.status(400).json({ error: 'invalid_filter', details: 'category must be numeric' });
    }
    if (maxPrice !== undefined && !Number.isFinite(maxPriceNum)) {
      return res.status(400).json({ error: 'invalid_filter', details: 'maxPrice must be numeric' });
    }

    // dynamic where builder (no string concatenation, all values bound as parameters)
    const query = knex('products').where(builder => {
      if (categoryId !== undefined) builder.where('category_id', categoryId);
      if (maxPriceNum !== undefined) builder.where('price', '<=', maxPriceNum);
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
      return res.status(404).json({ error: 'not_found' });
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

// INVENTORY (PG DRIVER)
// native pg driver, parameterized queries ($1, $2)
app.patch('/inventory/:sku', async (req, res, next) => {
  try {
    const { quantity } = req.body;
    // use parameterized query for safety
    await pgPool.query(
      'UPDATE products SET stock = stock - $1 WHERE sku = $2',
      [quantity, req.params.sku]
    );
    res.sendStatus(204);
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
    if (!cart) return res.status(404).json({ error: 'cart not found' });
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

        // CartLine.create runs model validators (quantity >= 1, price >= 0, ...)
        await CartLine.create({
          CartId: cart.id,
          productId: numericId,
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
      return res.status(400).json({
        error: 'validation_error',
        details: e.errors.map(err => ({ field: err.path, message: err.message }))
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// ORDERS AND CHECKOUT SAGA (PRISMA)
// checkout with lock and oversell protection
app.post('/checkout', async (req, res) => {
  const { userId, items } = req.body;
  try {
    // prisma interactive transaction quarantees atomicity
    const order = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;
      const orderLinesData = [];
      
      // oversell check and stock deduction
      for (const item of items) {
        const numericId = parseInt(String(item.productId).replace(/\D/g, '')) || 1;
        
        // use raw query to lock the row for update to prevent race conditions
        const [product] = await tx.$queryRaw`SELECT sku, stock, price FROM products WHERE id = ${numericId} FOR UPDATE`;
        
        if (!product || product.stock < item.quantity) {
          throw new Error('409_CONFLICT_OVERSELL');
        }
        
        // reduce stock
        await tx.$executeRaw`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${numericId}`;
        totalAmount += Number(product.price) * item.quantity;

        orderLinesData.push({
          sku: product.sku,
          quantity: item.quantity,
          price: item.price
        });
      }

      // create order and snapshot price
      const newOrder = await tx.order.create({
        data: {
          totalAmount,
          status: 'PAID',
          lines: {
            create: orderLinesData
          }
        }
      });
      
      // mark cart as closed
      await Cart.update({ status: 'CLOSED' }, { where: { userId, status: 'OPEN' }});
      
      return newOrder;
    });

    res.status(201).json({ orderId: order.id });
  } catch (err) {
    if (err.message.includes('409')) return res.status(409).json({ error: 'conflict_oversell' });
    res.status(500).json({ error: err.message });
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
      
      // return stock to inventory
      for (const line of order.lines) {
        await tx.$executeRaw`UPDATE products SET stock = stock + ${line.quantity} WHERE sku = ${line.sku}`;
      }
    });
    res.sendStatus(200);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.status(500).json({ error: err.message });
  }
});


// global error handler
app.use(pgErrorMap);

const PORT = process.env.PORT || 3001;

// last-resort safety net: log unhandled rejections instead of letting Node kill the container
process.on('unhandledRejection', (reason) => {
  console.error('unhandled_rejection:', reason);
});

sequelize.sync().then(() => {
  app.listen(PORT, () => console.log(`inventory service running on port ${PORT}`));
});