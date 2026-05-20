const request = require('supertest');

const API_URL = process.env.API_URL || 'http://127.0.0.1:3000';

// tests critical end-to-end business flows across microservices
describe('e2e critical paths', () => {
  const testUserId = 'u1';
  
  // fetched dynamically to prevent id drift between test runs
  let testProductId = null;
  let initialStock = 0;
  let createdOrderId = null;

  // verifies if api gateway is reachable
  it('step 0: gateway /health responds 200', async () => {
    const res = await request(API_URL).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('step 1: should fetch initial stock', async () => {
    const res = await request(API_URL).get('/api/products');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // selects first product with sufficient stock for testing
    const product = res.body.find(p => Number(p.stock) > 0);
    expect(product).toBeDefined();

    testProductId = product.id;
    initialStock = Number(product.stock);
  });

  it('step 2: should block overselling with 409 conflict', async () => {
    const payload = {
      userId: testUserId,
      items: [{ productId: testProductId, quantity: 9999, price: 120 }]
    };

    const res = await request(API_URL).post('/api/checkout').send(payload);

    // expects conflict status on oversell attempt
    expect(res.status).toBe(409);
    
    // verifies unified error envelope structure
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
      code: 409
    }));
  });

  it('step 3: should process valid checkout successfully', async () => {
    const payload = {
      userId: testUserId,
      items: [{ productId: testProductId, quantity: 1, price: 120 }]
    };

    const res = await request(API_URL).post('/api/checkout').send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    createdOrderId = res.body.orderId;
  });

  it('step 4: should verify inventory stock was strictly reduced', async () => {
    const res = await request(API_URL).get('/api/products');
    const product = res.body.find(p => p.id === testProductId);

    // confirms inventory stock decreased exactly by ordered amount
    expect(product.stock).toBe(initialStock - 1);
  });

  it('step 5: should restore stock on order cancellation', async () => {
    const cancelRes = await request(API_URL).post(`/api/orders/${createdOrderId}/cancel`);
    expect(cancelRes.status).toBe(200);

    const res = await request(API_URL).get('/api/products');
    const product = res.body.find(p => p.id === testProductId);

    // confirms stock is restored upon order cancellation
    expect(product.stock).toBe(initialStock);
  });

  it('step 6: should aggregate single product from PG and Mongo', async () => {
    const res = await request(API_URL).get(`/api/products/${testProductId}`);
    expect(res.status).toBe(200);

    // validates merged data from postgres and mongodb
    expect(res.body.id).toBe(testProductId);
    expect(typeof res.body.sku).toBe('string');
    
    // safely checks decimal values returned as strings
    expect(Number.isFinite(Number(res.body.price))).toBe(true);
    expect(Array.isArray(res.body.variants)).toBe(true);
    expect(Array.isArray(res.body.gallery)).toBe(true);
  });

  it('step 7: should successfully execute hybrid product creation saga', async () => {
    const payload = {
      name: 'e2e test necklace',
      sku: `E2E-${Date.now()}`,
      price: 150,
      category_id: 1,
      long_description: 'beautiful e2e testing necklace',
      specs: { material: 'silver' },
      variants: [
        { id: 'a', color: 'Gold', stock: 3 },
        { id: 'b', color: 'Silver', stock: 2 }
      ]
    };

    const res = await request(API_URL).post('/api/products').send(payload);

    // validates successful product creation in both databases
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('step 8: should compensate (rollback PG) when Mongo step fails', async () => {
    // triggers mongoose validator to simulate step failure and test rollback
    const payload = {
      name: 'compensation probe',
      sku: `E2E-ROLLBACK-${Date.now()}`,
      price: 50,
      category_id: 1,
      long_description: 'mongo validator must reject duplicate colors',
      variants: [
        { id: 'x', color: 'Red', stock: 1 },
        { id: 'y', color: 'Red', stock: 1 }
      ]
    };

    const res = await request(API_URL).post('/api/products').send(payload);

    // checks if gateway surfaces mongo errors in unified envelope format
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
      code: expect.any(Number)
    }));
    
    // validates rollback success header
    expect(res.headers['x-rollback-status']).toBe('success');
  });

  it('step 9: should block invalid product data using zod validation', async () => {
    const invalidPayload = {
      name: '',
      sku: 'E2E-INVALID',
      price: -50
    };

    const res = await request(API_URL).post('/api/products').send(invalidPayload);

    // expects validation layer to catch and reject bad payload
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('step 10: should round-trip a server-side cart sync', async () => {
    const userId = `cart-e2e-${Date.now()}`;
    const items = [{ productId: testProductId, quantity: 2, price: 120 }];

    // syncs local client cart state to server
    const syncRes = await request(API_URL).post(`/api/cart/${userId}/sync`).send({ items });
    expect(syncRes.status).toBe(200);

    // retrieves cart to verify state persistence
    const getRes = await request(API_URL).get(`/api/cart/${userId}`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.lines)).toBe(true);
    expect(getRes.body.lines.length).toBeGreaterThan(0);
  });

  it('step 11: empty cart for unknown user returns safe default (no leak)', async () => {
    const res = await request(API_URL).get(`/api/cart/unknown-user-${Date.now()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lines: [], totalPrice: 0 });
  });
});