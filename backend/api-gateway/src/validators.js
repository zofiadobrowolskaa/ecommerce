const { z } = require('zod');

const variantShape = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  color: z.string().optional(),
  priceAdjustment: z.number().optional(),
  stock: z.number().int().nonnegative().optional(),
  imageUrl: z.string().optional(),
  size: z.array(z.union([z.string(), z.number()])).optional()
});

// input validation schemas to protect databases
const productSchema = z.object({
  name: z.string().min(1, 'name is required'),
  sku: z.string().min(1, 'sku is required'),
  price: z.number().positive('price must be positive'),
  category_id: z.number().int().positive('category_id must be valid'),
  long_description: z.string().optional(),
  description: z.string().optional(),
  specs: z.record(z.any()).optional(),
  variants: z.array(variantShape).optional(),
  aboutMaterials: z.record(z.any()).optional(),
  gallery: z.array(z.any()).optional(),
  rating: z.number().optional(),
  tags: z.array(z.any()).optional(),
  // optional rollup used only when variants[] is omitted (single default variant row)
  stock: z.number().int().nonnegative().optional()
});

const checkoutLineSchema = z.object({
  productId: z.union([z.string(), z.number()]),
  // maps to variants.sku (saleable grain); omit => server picks default variant per product
  sku: z.string().min(1).optional(),
  variantSku: z.string().min(1).optional(),
  quantity: z.number().int().positive('quantity must be positive'),
  price: z.number().nonnegative('price cannot be negative')
});

const cartSyncSchema = z.object({
  items: z.array(checkoutLineSchema)
});

const checkoutSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  items: z.array(checkoutLineSchema).min(1, 'cart cannot be empty')
});

// schema for the single-item cart-add endpoint (add to cart with stock validation)
const cartAddSchema = z.object({
  productId: z.union([z.string(), z.number()]),
  variantSku: z.string().min(1).optional(),
  quantity: z.number().int().positive('quantity must be positive'),
  price: z.number().nonnegative('price cannot be negative').optional()
});

// generic validation middleware
const validate = (schema) => (req, res, next) => {
  try {
    schema.parse(req.body);
    next();
  } catch (err) {
    // return safe, standardized 400 error without leaking server state
    res.status(400).json({ error: 'validation_error', code: 400, details: err.issues ?? err.errors ?? [] });
  }
};

module.exports = { productSchema, cartSyncSchema, cartAddSchema, checkoutSchema, validate };
