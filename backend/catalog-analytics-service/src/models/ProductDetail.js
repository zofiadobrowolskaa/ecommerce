const mongoose = require('mongoose');

// nested sub-schema for product variants (array of subdocuments)
const variantSchema = new mongoose.Schema({
  id: String,
  color: {
    type: String,
    required: true,
    // custom validator: color name must be at least 2 characters
    validate: {
      validator: (v) => typeof v === 'string' && v.trim().length >= 2,
      message: 'variant color must be at least 2 characters'
    }
  },
  priceAdjustment: {
    type: Number,
    default: 0,
    // custom validator: price adjustment cannot be lower than -1000 (sanity floor)
    validate: {
      validator: (v) => v >= -1000,
      message: props => `price adjustment ${props.value} is unrealistic`
    }
  },
  imageUrl: String,
  size: [String],
  stock: {
    type: Number,
    default: 0,
    // custom validator: stock must be a non-negative integer
    validate: {
      validator: (v) => Number.isInteger(v) && v >= 0,
      message: props => `stock ${props.value} must be a non-negative integer`
    }
  },
  sku: String
}, { _id: false });

const productDetailSchema = new mongoose.Schema({
  productId: { type: Number, required: true, unique: true },
  longDescription: String,
  specs: { type: Map, of: String },
  gallery: [String],
  aboutMaterials: mongoose.Schema.Types.Mixed,
  // nested array of variant subdocuments with their own custom validators
  variants: {
    type: [variantSchema],
    // custom array-level validator: all variant colors must be unique within a product
    validate: {
      validator: function(arr) {
        const colors = arr.map(v => v.color);
        return new Set(colors).size === colors.length;
      },
      message: 'variants must have unique colors within a product'
    }
  }
});

// instance method: returns total stock summed across all variants
productDetailSchema.methods.totalStock = function() {
  return (this.variants || []).reduce((sum, v) => sum + (v.stock || 0), 0);
};

module.exports = mongoose.model('ProductDetail', productDetailSchema);
