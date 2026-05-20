const mongoose = require('mongoose');

// nested sub-schema for review images
const reviewImageSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    // validates if string is a valid url format or absolute path
    validate: {
      validator: (v) => /^https?:\/\/.+/.test(v) || v.startsWith('/'),
      message: props => `${props.value} is not a valid image url`
    }
  },
  caption: String
}, { _id: false }); // disables automatic _id generation for subdocuments

// sub-schema for moderation audit trail
// tracks status changes, who made them, and when
const moderationEntrySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    required: true
  },
  moderatorId: { type: String, required: true },
  // optional explanation for the moderation decision
  reason: String,
  changedAt: { type: Date, default: Date.now }
}, { _id: false }); // disables _id for this subdocument too

// main schema for product reviews
const reviewSchema = new mongoose.Schema({
  productId: { type: Number, required: true },
  userId: { type: String, required: true },
  rating: {
    type: Number,
    required: true,
    // min and max constraints for rating
    min: [1, 'rating must be at least 1'],
    max: [5, 'rating cannot exceed 5'],
    // forces rating to be a whole number (no half stars allowed)
    validate: {
      validator: Number.isInteger,
      message: props => `rating ${props.value} must be an integer between 1 and 5`
    }
  },
  title: {
    type: String,
    required: true,
    // prevents users from submitting titles entirely in uppercase
    validate: {
      validator: (v) => v !== v.toUpperCase() || v.length < 4,
      message: 'title cannot be all uppercase'
    }
  },
  body: {
    type: String,
    required: true,
    // requires the review body to contain at least 3 words
    validate: {
      validator: (v) => v.trim().split(/\s+/).length >= 3,
      message: 'review body must contain at least 3 words'
    }
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING'
  },
  createdAt: { type: Date, default: Date.now },

  // array of image subdocuments attached to the review
  gallery: [reviewImageSchema],

  // array of moderation history subdocuments
  moderationHistory: [moderationEntrySchema],

  updatedAt: { type: Date, default: Date.now }
}, {
  // ensures virtual fields are included in json outputs
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// links review to product details using the numeric product id
// allows fetching product data without storing an objectid reference
reviewSchema.virtual('productDetail', {
  ref: 'ProductDetail',      // target model name
  localField: 'productId',   // field in this schema
  foreignField: 'productId', // matching field in target schema
  justOne: true              // returns a single object instead of an array
});

// runs automatically before saving document to db
// updates the modification timestamp on every save
reviewSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

// custom static method attached to the model
// fetches all approved reviews for a specific product, newest first
reviewSchema.statics.findByProduct = function(productId) {
  return this.find({ productId, status: 'APPROVED' }).sort({ createdAt: -1 });
};

// instance method to approve a specific review
// updates status and appends a record to the moderation history
reviewSchema.methods.approve = function(moderatorId, reason) {
  this.status = 'APPROVED';
  this.moderationHistory.push({ status: 'APPROVED', moderatorId, reason });
  return this.save(); // commits changes to database
};

// instance method to reject a specific review
// updates status and logs the rejection in history
reviewSchema.methods.reject = function(moderatorId, reason) {
  this.status = 'REJECTED';
  this.moderationHistory.push({ status: 'REJECTED', moderatorId, reason });
  return this.save(); // commits changes to database
};

// index for analytics aggregation pipelines
// speeds up queries filtering by status and grouping by product id
reviewSchema.index({ status: 1, productId: 1 });

// compound index for frontend queries
// optimizes fetching approved reviews for a product sorted by date
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);