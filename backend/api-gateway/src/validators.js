const { z } = require('zod');

// defines shape for product variants
const variantShape = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  color: z.string().optional(),
  priceAdjustment: z.number().optional(),
  stock: z.number().int().nonnegative().optional(),
  imageUrl: z.string().optional(),
  size: z.array(z.union([z.string(), z.number()])).optional()
});

// validates incoming product creation payload
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
  // optional stock fallback when variants array is omitted
  stock: z.number().int().nonnegative().optional()
});

// validates individual items during checkout or cart sync
const checkoutLineSchema = z.object({
  productId: z.union([z.string(), z.number()]),
  // maps to variant sku; server picks default if omitted
  sku: z.string().min(1).optional(),
  variantSku: z.string().min(1).optional(),
  quantity: z.number().int().positive('quantity must be positive'),
  price: z.number().nonnegative('price cannot be negative')
});

// validates full cart synchronization payload
const cartSyncSchema = z.object({
  items: z.array(checkoutLineSchema)
});

// validates final checkout payload
const checkoutSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  items: z.array(checkoutLineSchema).min(1, 'cart cannot be empty')
});

// validates single item addition to cart
const cartAddSchema = z.object({
  productId: z.union([z.string(), z.number()]),
  variantSku: z.string().min(1).optional(),
  quantity: z.number().int().positive('quantity must be positive'),
  price: z.number().nonnegative('price cannot be negative').optional()
});

// generic express middleware for zod validation
const validate = (schema) => (req, res, next) => {
  try {
    schema.parse(req.body);
    next();
  } catch (err) {
    res.status(400).json({ error: 'validation_error', code: 400, details: err.issues ?? err.errors ?? [] });
  }
};

module.exports = { productSchema, cartSyncSchema, cartAddSchema, checkoutSchema, validate };