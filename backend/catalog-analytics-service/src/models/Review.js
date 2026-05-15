const mongoose = require('mongoose');

// nested sub-schema for review images (array of subdocuments)
const reviewImageSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    // custom validator: must look like a real url
    validate: {
      validator: (v) => /^https?:\/\/.+/.test(v) || v.startsWith('/'),
      message: props => `${props.value} is not a valid image url`
    }
  },
  caption: String
}, { _id: false });

// nested sub-schema for moderation history entries
// tracks who changed the review status and when (audit trail)
const moderationEntrySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    required: true
  },
  moderatorId: { type: String, required: true },
  reason: String,
  changedAt: { type: Date, default: Date.now }
}, { _id: false });

const reviewSchema = new mongoose.Schema({
  productId: { type: Number, required: true, index: true },
  userId: { type: String, required: true },
  rating: {
    type: Number,
    required: true,
    min: [1, 'rating must be at least 1'],
    max: [5, 'rating cannot exceed 5'],
    // custom validator: rating must be an integer (no 4.5 stars allowed)
    validate: {
      validator: Number.isInteger,
      message: props => `rating ${props.value} must be an integer between 1 and 5`
    }
  },
  title: {
    type: String,
    required: true,
    // custom validator: title cannot be all uppercase (anti-shouting rule)
    validate: {
      validator: (v) => v !== v.toUpperCase() || v.length < 4,
      message: 'title cannot be all uppercase'
    }
  },
  body: {
    type: String,
    required: true,
    // custom validator: review body must have at least 3 words for meaningful content
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
  // first nested array of subdocuments: image gallery
  gallery: [reviewImageSchema],
  // second nested array of subdocuments: moderation audit trail
  moderationHistory: [moderationEntrySchema],
  updatedAt: { type: Date, default: Date.now }
}, {
  // expose virtuals (populate) in json and object outputs
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// virtual populate: links review.productId (Number) to ProductDetail.productId (Number)
// allows .populate('productDetail') without changing review.productId to ObjectId
reviewSchema.virtual('productDetail', {
  ref: 'ProductDetail',
  localField: 'productId',
  foreignField: 'productId',
  justOne: true
});

// pre hook: refresh updatedAt on every save (covers create and update)
reviewSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

// static method: convenience finder used by the public endpoint
reviewSchema.statics.findByProduct = function(productId) {
  return this.find({ productId, status: 'APPROVED' });
};

// instance method: approve review and append entry to moderation history
reviewSchema.methods.approve = function(moderatorId, reason) {
  this.status = 'APPROVED';
  this.moderationHistory.push({ status: 'APPROVED', moderatorId, reason });
  return this.save();
};

// instance method: reject review and append entry to moderation history
reviewSchema.methods.reject = function(moderatorId, reason) {
  this.status = 'REJECTED';
  this.moderationHistory.push({ status: 'REJECTED', moderatorId, reason });
  return this.save();
};

// compound index dedicated to the analytics aggregation pipeline:
// supports the first $match on status (index prefix) and then groups by productId
// without a collection scan
reviewSchema.index({ status: 1, productId: 1 });

module.exports = mongoose.model('Review', reviewSchema);
