const mongoose = require('mongoose');

// use environment variable or default local uri
const uri = process.env.MONGO_URI || 'mongodb://admin:password@mongodb:27017/ecommerce_mongo?authSource=admin';

// connect using mongoose with recommended settings
const connectMongoose = async () => {
  try {
    await mongoose.connect(uri);
    console.log('connected to mongodb via mongoose');
  } catch (error) {
    console.error('mongoose connection error:', error);
  }
};

module.exports = connectMongoose;