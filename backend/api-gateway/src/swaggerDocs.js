// openapi 3.0 specification - publishable contract for the api gateway
// served by swagger-ui at GET /api-docs and as raw JSON at GET /api-docs.json
//
// every endpoint includes request and response examples + the
// unified error envelope { error, code, details } reused by all services.

const errorEnvelope = {
  type: 'object',
  required: ['error', 'code', 'details'],
  properties: {
    error: { type: 'string', example: 'validation_error' },
    code: { type: 'integer', example: 400 },
    details: { description: 'any extra context (string, object or array)' }
  }
};

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'E-commerce API Gateway',
    version: '1.0.0',
    description:
      'Public REST contract for the polyglot kiosk e-commerce backend. ' +
      'All failure responses follow the unified envelope `{ error, code, details }`.',
    contact: { name: 'BD2 project', url: 'http://localhost:3000/api-docs' }
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local docker compose' }
  ],
  tags: [
    { name: 'Health', description: 'Liveness and readiness probes' },
    { name: 'Products', description: 'Hybrid product catalog (PG base data + Mongo details)' },
    { name: 'Cart', description: 'Server-side cart synchronization' },
    { name: 'Checkout', description: 'Transactional checkout with oversell protection' },
    { name: 'Orders', description: 'Order lifecycle' }
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Gateway liveness probe',
        responses: {
          200: {
            description: 'Service is alive',
            content: {
              'application/json': {
                example: { status: 'ok', service: 'api-gateway' }
              }
            }
          }
        }
      }
    },
    '/api/products': {
      get: {
        tags: ['Products'],
        summary: 'List products with optional filtering',
        description:
          'Aggregates base product data from PostgreSQL with extended catalog details from MongoDB. ' +
          'Filters are bound by Knex query builder - safe against SQL injection.',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'integer' }, example: 1, description: 'Filter by category id' },
          { name: 'minPrice', in: 'query', schema: { type: 'number' }, example: 100, description: 'Lower bound of price range' },
          { name: 'maxPrice', in: 'query', schema: { type: 'number' }, example: 500, description: 'Upper bound of price range' },
          { name: 'inStock', in: 'query', schema: { type: 'boolean' }, example: true, description: 'Availability — return only products with stock > 0 when set to true' },
          { name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 },
          { name: 'limit', in: 'query', schema: { type: 'integer' }, example: 10 }
        ],
        responses: {
          200: {
            description: 'Aggregated product list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
                example: [
                  {
                    id: 1,
                    sku: 'AURA-001',
                    name: 'Ocean Ring',
                    price: 250,
                    stock: 12,
                    category_id: 1,
                    variants: [{ id: 'v1', color: 'Gold', stock: 6 }],
                    gallery: ['https://cdn.example.com/ocean-ring.jpg']
                  }
                ]
              }
            }
          },
          400: {
            description: 'Invalid filter values',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          },
          500: {
            description: 'Gateway or downstream error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      },
      post: {
        tags: ['Products'],
        summary: 'Create product through hybrid saga (PG + Mongo)',
        description:
          'Step 1: insert base row in PostgreSQL. Step 2: insert document in MongoDB. ' +
          'On step 2 failure the gateway compensates by deleting the PG row and sets the ' +
          '`X-Rollback-Status` response header to `success` or `failed`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProductCreateRequest' },
              example: {
                name: 'Ocean Ring',
                sku: 'AURA-001',
                price: 250,
                category_id: 1,
                long_description: 'Hand-crafted silver ring with wave motif.',
                specs: { material: 'silver-925', weight: '3g' },
                variants: [
                  { id: 'v1', color: 'Gold', stock: 5 },
                  { id: 'v2', color: 'Silver', stock: 5 }
                ],
                gallery: ['https://cdn.example.com/ocean-ring.jpg']
              }
            }
          }
        },
        responses: {
          201: {
            description: 'Created in both databases',
            content: {
              'application/json': {
                example: { id: 42, message: 'product created in both databases' }
              }
            }
          },
          400: {
            description: 'Zod validation failed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: {
                  error: 'validation_error',
                  code: 400,
                  details: [{ path: 'price', message: 'Expected number, received string' }]
                }
              }
            }
          },
          409: {
            description: 'Unique constraint on sku (PG SQLSTATE 23505)',
            headers: {
              'X-Rollback-Status': {
                schema: { type: 'string', enum: ['not_attempted', 'success', 'failed'] },
                description: 'Outcome of the compensating action'
              }
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: {
                  error: 'conflict',
                  code: 409,
                  details: { message: 'sku already exists', rollbackStatus: 'not_attempted' }
                }
              }
            }
          },
          500: {
            description: 'Hybrid transaction failed, compensation status in header',
            headers: {
              'X-Rollback-Status': { schema: { type: 'string', enum: ['not_attempted', 'success', 'failed'] } }
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: {
                  error: 'hybrid_transaction_failed',
                  code: 500,
                  details: { message: 'mongo write failed', rollbackStatus: 'success' }
                }
              }
            }
          }
        }
      }
    },
    '/api/products/{id}': {
      get: {
        tags: ['Products'],
        summary: 'Get one product (aggregated from PG and Mongo)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
        responses: {
          200: {
            description: 'Aggregated product',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Product' } }
            }
          },
          404: {
            description: 'Product not found in inventory',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    },
    '/api/cart/{userId}': {
      get: {
        tags: ['Cart'],
        summary: 'Get server-side cart',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'user-123' }],
        responses: {
          200: {
            description: 'Cart state (empty if never created)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Cart' },
                example: {
                  id: 7,
                  userId: 'user-123',
                  status: 'OPEN',
                  totalPrice: 500,
                  lines: [{ id: 11, productId: 1, quantity: 2, priceAtEntry: 250 }]
                }
              }
            }
          }
        }
      }
    },
    '/api/products/{id}/price': {
      patch: {
        tags: ['Products'],
        summary: 'Update product list price (req 18 business rule: snapshot-safe)',
        description:
          'Changes products.price only. Historical OrderLine.price snapshots are intentionally not touched, ' +
          'so existing orders keep the price the buyer originally paid.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['price'], properties: { price: { type: 'number', minimum: 0 } } },
              example: { price: 299.99 }
            }
          }
        },
        responses: {
          200: {
            description: 'Updated product row (only id, sku, price)',
            content: { 'application/json': { example: { id: 1, sku: 'AURA-001', price: 299.99 } } }
          },
          400: {
            description: 'invalid_id or invalid_price',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          },
          404: {
            description: 'Product not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    },
    '/api/cart/{userId}/add': {
      post: {
        tags: ['Cart'],
        summary: 'Add a single item to the server cart with stock validation (req 17)',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'user-123' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CartAddRequest' },
              example: { productId: 1, variantSku: 'p001__v001a', quantity: 2, price: 250 }
            }
          }
        },
        responses: {
          201: { description: 'Item added to cart' },
          400: {
            description: 'Zod validation failed',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          },
          404: {
            description: 'Product or variant not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          },
          409: {
            description: 'Insufficient stock — available/requested returned in details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    },
    '/api/users/{userId}/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List orders for a single user, newest-first (req 17 order history)',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'user-123' }],
        responses: {
          200: {
            description: 'User orders sorted by createdAt desc (compound index { userId, createdAt })',
            content: {
              'application/json': {
                example: [
                  { id: 17, userId: 'user-123', status: 'PAID', totalAmount: '500.00', createdAt: '2026-05-15T11:32:00Z', lines: [] }
                ]
              }
            }
          }
        }
      }
    },
    '/api/cart/{userId}/sync': {
      post: {
        tags: ['Cart'],
        summary: 'Sync the whole cart from the client',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'user-123' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CartSyncRequest' },
              example: { items: [{ productId: 1, quantity: 2, price: 250 }] }
            }
          }
        },
        responses: {
          200: { description: 'Cart synchronized in PG (single source of truth)' },
          400: {
            description: 'Zod validation failed',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    },
    '/api/checkout': {
      post: {
        tags: ['Checkout'],
        summary: 'Transactional checkout (variants SELECT FOR UPDATE + Prisma tx)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CheckoutRequest' },
              example: { userId: 'user-123', items: [{ productId: 1, sku: 'p001__v001a', quantity: 2, price: 250 }] }
            }
          }
        },
        responses: {
          201: {
            description: 'Order created, stock decremented atomically',
            content: { 'application/json': { example: { success: true, orderId: 17 } } }
          },
          409: {
            description: 'Oversell conflict (stock < requested quantity)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: {
                  error: 'checkout_failed',
                  code: 409,
                  details: { error: 'conflict_oversell', code: 409, details: 'requested quantity exceeds stock' }
                }
              }
            }
          },
          400: {
            description: 'Zod validation failed',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    },
    '/api/orders/{orderId}/cancel': {
      post: {
        tags: ['Orders'],
        summary: 'Cancel an order and restore stock',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer' }, example: 17 }],
        responses: {
          200: { description: 'Order cancelled, stock restored via $executeRaw' },
          404: {
            description: 'Order not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Error: errorEnvelope,
      Product: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 1 },
          sku: { type: 'string', example: 'AURA-001' },
          name: { type: 'string', example: 'Ocean Ring' },
          price: { type: 'number', example: 250 },
          stock: { type: 'integer', example: 12 },
          category_id: { type: 'integer', example: 1 },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                color: { type: 'string' },
                stock: { type: 'integer' }
              }
            }
          },
          gallery: { type: 'array', items: { type: 'string' } }
        }
      },
      ProductCreateRequest: {
        type: 'object',
        required: ['name', 'sku', 'price', 'category_id', 'variants'],
        properties: {
          name: { type: 'string' },
          sku: { type: 'string' },
          price: { type: 'number' },
          category_id: { type: 'integer' },
          long_description: { type: 'string' },
          specs: { type: 'object', additionalProperties: true },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'color', 'stock'],
              properties: {
                id: { type: 'string' },
                color: { type: 'string' },
                stock: { type: 'integer' }
              }
            }
          },
          gallery: { type: 'array', items: { type: 'string' } }
        }
      },
      Cart: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          userId: { type: 'string' },
          status: { type: 'string', enum: ['OPEN', 'CHECKED_OUT', 'CANCELLED'] },
          totalPrice: { type: 'number' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                productId: { type: 'integer' },
                variantSku: {
                  type: 'string',
                  nullable: true,
                  description: 'Optional pinned variants.sku copied from Sequelize CartLine.variantSku'
                },
                quantity: { type: 'integer' },
                priceAtEntry: { type: 'number' }
              }
            }
          }
        }
      },
      CartSyncRequest: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'quantity', 'price'],
              properties: {
                productId: { type: 'integer' },
                sku: { type: 'string', description: 'Optional variants.sku' },
                variantSku: { type: 'string', description: 'Alias of sku for cart round-trips' },
                quantity: { type: 'integer', minimum: 1 },
                price: { type: 'number', minimum: 0 }
              }
            }
          }
        }
      },
      CartAddRequest: {
        type: 'object',
        required: ['productId', 'quantity'],
        properties: {
          productId: { type: 'integer', example: 1 },
          variantSku: { type: 'string', description: 'Optional saleable SKU; if present, stock is checked at variant grain' },
          quantity: { type: 'integer', minimum: 1, example: 2 },
          price: { type: 'number', minimum: 0, example: 250 }
        }
      },
      CheckoutRequest: {
        type: 'object',
        required: ['userId', 'items'],
        properties: {
          userId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'quantity', 'price'],
              properties: {
                productId: { type: 'integer' },
                sku: {
                  type: 'string',
                  description: 'Optional concrete variants.sku — required for multi-SKU products at checkout'
                },
                variantSku: { type: 'string', description: 'Alias of sku' },
                quantity: { type: 'integer', minimum: 1 },
                price: { type: 'number', minimum: 0 }
              }
            }
          }
        }
      }
    }
  }
};

module.exports = swaggerDocument;
