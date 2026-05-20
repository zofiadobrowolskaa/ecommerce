const mongoose = require('mongoose');

// nested sub-schema for product variants
const variantSchema = new mongoose.Schema({
  id: String,
  color: {
    type: String,
    required: true,
    // validates that color name has at least 2 characters
    validate: {
      validator: (v) => typeof v === 'string' && v.trim().length >= 2,
      message: 'variant color must be at least 2 characters'
    }
  },
  priceAdjustment: {
    type: Number,
    default: 0,
    // prevents price adjustment from dropping below -1000
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
    // ensures stock is a positive integer or zero
    validate: {
      validator: (v) => Number.isInteger(v) && v >= 0,
      message: props => `stock ${props.value} must be a non-negative integer`
    }
  },
  sku: String
}, { _id: false }); // disables automatic objectid generation for subdocuments

// main schema for detailed product information
const productDetailSchema = new mongoose.Schema({
  // unique numeric identifier for the product
  productId: { type: Number, required: true, unique: true },
  longDescription: String,
  specs: { type: Map, of: String },
  gallery: [String],
  // accepts any data type for material details
  aboutMaterials: mongoose.Schema.Types.Mixed,
  
  // array of variant subdocuments
  variants: {
    type: [variantSchema],
    // ensures all variants within a product have unique colors
    validate: {
      validator: function(arr) {
        const colors = arr.map(v => v.color);
        return new Set(colors).size === colors.length;
      },
      message: 'variants must have unique colors within a product'
    }
  }
});

// instance method calculating total stock across all variants
productDetailSchema.methods.totalStock = function() {
  return (this.variants || []).reduce((sum, v) => sum + (v.stock || 0), 0);
};

module.exports = mongoose.model('ProductDetail', productDetailSchema);