const express = require('express');
const { connectMongo, getDb } = require('./db/mongoClient');
const connectMongoose = require('./db/mongoose');
const ProductDetail = require('./models/ProductDetail');
const Review = require('./models/Review');
const mongoErrorMap = require('./middleware/mongoErrorMiddleware');

const app = express();
app.use(express.json());

// unified error response helper: every failure responds with { error, code, details }
const sendError = (res, status, error, details) =>
  res.status(status).json({ error, code: status, details: details ?? null });

// simple healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'catalog-analytics-service' });
});

// handles wishlist operations using native mongodb driver
// adds item to wishlist using multiple update operators and upsert
app.post('/wishlists/:userId/add', async (req, res) => {
  try {
    // fetch connected database instance synchronously
    const db = getDb(); 
    
    const { userId } = req.params;
    const { productId, note } = req.body;
    
    if (!productId) {
      return sendError(res, 400, 'productId_required', 'body must include productId');
    }

    // update user's wishlist atomically
    const result = await db.collection('wishlists').updateOne(
      // match document by user id
      { userId },                                      
      {
        // append new item to the items array
        $push: { items: { productId, note: note ?? null, addedAt: new Date() } }, 
        // atomically increment total item count by 1
        $inc: { itemCount: 1 },                        
        // update the last modified timestamp
        $set: { lastModified: new Date() }             
      },
      // create a new wishlist if one doesn't exist yet
      { upsert: true } 
    );
    
    res.status(200).json({ success: true, result });
    
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// remove an item from a user's wishlist
app.post('/wishlists/:userId/remove', async (req, res) => {
  try {
    // fetch connected database instance synchronously
    const db = getDb();

    const { userId } = req.params;
    const { productId } = req.body;
    
    if (!productId) {
      return sendError(res, 400, 'productId_required', 'body must include productId');
    }

    // update wishlist document atomically
    const result = await db.collection('wishlists').updateOne(
      // match document by user id
      { userId },
      {
        // remove item from the items array matching the product id
        $pull: { items: { productId } },
        // atomically decrement total item count by 1
        $inc: { itemCount: -1 },
        // update the last modified timestamp
        $set: { lastModified: new Date() }
      }
    );

    if (result.matchedCount === 0) {
      return sendError(res, 404, 'wishlist_not_found', `no wishlist for user ${userId}`);
    }
    
    // return success status with modified count
    res.json({ success: true, modified: result.modifiedCount });
    
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// fetch a user's wishlist
app.get('/wishlists/:userId', async (req, res) => {
  try {
    // get connected database instance
    const db = getDb();
    
    const { userId } = req.params;
    
    // find single wishlist document matching the user id
    const doc = await db.collection('wishlists').findOne({ userId });
    
    if (!doc) {
      return sendError(res, 404, 'wishlist_not_found', `no wishlist for user ${userId}`);
    }
    
    res.json(doc);
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// create a new product review
app.post('/reviews', async (req, res) => {
  try {
    // initialize new review document with request body
    const review = new Review(req.body);
    
    // save to db, triggering custom validators and hooks
    await review.save();
    
    res.status(201).json(review);
  } catch (error) {
    sendError(res, 400, 'validation_error', error.message);
  }
});

// fetch approved reviews for a specific product
// uses compound index for fast, newest-first sorting
app.get('/reviews/:productId', async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    
    // fetch reviews using custom static method
    // automatically attach product details via virtual populate
    const reviews = await Review.findByProduct(productId).populate('productDetail');
    
    res.json(reviews);
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// moderate a review and log history
app.post('/reviews/:id/moderate', async (req, res) => {
  try {
    const { decision, moderatorId, reason } = req.body;
    
    // validate decision type
    if (!['approve', 'reject'].includes(decision)) {
      return sendError(res, 400, 'invalid_decision', 'decision must be approve or reject');
    }
    
    if (!moderatorId) {
      return sendError(res, 400, 'moderator_required', 'moderatorId is required');
    }

    // find review by id
    const review = await Review.findById(req.params.id);
    if (!review) return sendError(res, 404, 'not_found', `review ${req.params.id} not found`);

    // execute instance method to update status and save
    if (decision === 'approve') await review.approve(moderatorId, reason);
    else await review.reject(moderatorId, reason);

    res.json(review);
  } catch (error) {
    sendError(res, 400, 'validation_error', error.message);
  }
});

// get top rated products using aggregation pipeline
app.get('/analytics/average-ratings', async (req, res) => {
  try {
    // limit results, defaulting to 10 and maxing at 100
    const limit = Math.min(Number(req.query.limit) || 10, 100);

    // execute mongodb aggregation pipeline
    const report = await Review.aggregate([
      // filter only approved reviews using index
      { $match: { status: 'APPROVED' } },

      // group by product to calculate average rating and total reviews
      { $group: {
          _id: "$productId",
          avgRating: { $avg: "$rating" },
          reviewCount: { $sum: 1 }
      } },

      // join product details from another collection
      { $lookup: {
          from: "productdetails",
          localField: "_id",
          foreignField: "productId",
          as: "details"
      } },

      // flatten joined details array into a single object
      { $unwind: "$details" },

      // sort by highest rating, then by review count
      { $sort: { avgRating: -1, reviewCount: -1 } },

      // limit the number of returned documents
      { $limit: limit },

      // format output and round average rating to 1 decimal
      { $project: {
          _id: 0,
          productId: "$_id",
          avgRating: { $round: ["$avgRating", 1] },
          reviewCount: 1,
          productName: "$details.longDescription"
      } }
    ]);


    res.json(report);
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// get query execution plan for performance testing
app.get('/analytics/average-ratings/explain', async (req, res) => {
  try {
    // runs aggregation in explain mode to verify index usage
    const explain = await Review.aggregate([
      // matches approved reviews using the compound index
      { $match: { status: 'APPROVED' } },
      // groups by product id to calculate average rating
      { $group: { _id: "$productId", avgRating: { $avg: "$rating" } } }
    ]).explain('queryPlanner');

    res.json(explain);
  } catch (error) {
    sendError(res, 500, 'internal_server_error', error.message);
  }
});

// dummy data setup for testing (bodies must satisfy the 3-word custom validator)
app.post('/test/setup', async (req, res) => {
  try {
    // clear existing test data to prevent duplicate key errors
    await ProductDetail.deleteMany({ productId: 1 });
    await Review.deleteMany({ productId: 1 });

    await ProductDetail.create({ productId: 1, longDescription: "Golden Necklace", specs: { material: "Gold" } });
    await Review.create({ productId: 1, userId: "u1", rating: 5, status: "APPROVED", title: "Great", body: "really nice product" });
    await Review.create({ productId: 1, userId: "u2", rating: 4, status: "APPROVED", title: "Nice", body: "good quality piece" });
    res.send("test data created successfully");
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// internal route to create new product details
app.post('/internal/product-details', async (req, res) => {
  try {
    // create new product detail instance from request body
    const detail = new ProductDetail(req.body);
    
    // save document to database triggering validators
    await detail.save();
    
    res.status(201).json(detail);
  } catch (error) {
    sendError(res, 400, 'validation_error', error.message);
  }
});

//  fetch product details and aggregated reviews
app.get('/product-details/:productId', async (req, res, next) => {
  try {
    const id = Number(req.params.productId);

    if (!Number.isFinite(id)) {
      return sendError(res, 400, 'invalid_id_format', {
        path: 'productId',
        value: req.params.productId,
        kind: 'numeric'
      });
    }

    // find product details in database
    const detail = await ProductDetail.findOne({ productId: id });
    if (!detail) {
      return sendError(res, 404, 'not_found', `product details for ${req.params.productId} not found`);
    }

    // fetch approved reviews sorted from newest to oldest
    const reviews = await Review.find({ productId: id, status: 'APPROVED' }).sort({
      createdAt: -1
    });

    // return product details combined with reviews as json
    res.status(200).json({
      ...detail.toObject(),
      reviews: reviews
    });
  } catch (error) {
    // pass errors to global error handler middleware
    next(error);
  }
});

// register global error handler to prevent stack trace leaks
app.use(mongoErrorMap);

const PORT = process.env.PORT || 3002;

// initialize native and mongoose database connections concurrently
Promise.all([connectMongo(), connectMongoose()])
  .then(async () => {
    
    // synchronize indexes for reviews collection in database
    await Review.syncIndexes();
    
    // synchronize indexes for product details collection
    await ProductDetail.syncIndexes();
    
    app.listen(PORT, () => console.log(`catalog service running on ${PORT}`));
  })
  .catch((err) => {
    console.error('catalog_service_startup_failed', err);
    process.exit(1);
  });