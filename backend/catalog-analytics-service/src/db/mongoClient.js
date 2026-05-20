const { MongoClient } = require('mongodb');

// fallback to default uri if env variable is missing
const uri = process.env.MONGO_URI || 'mongodb://admin:password@mongodb:27017';

// shared singleton client instance for the entire app
const client = new MongoClient(uri);

let dbInstance = null;

// connects once and reuses the database instance
async function connectMongo() {
  if (!dbInstance) {
    await client.connect();
    dbInstance = client.db('ecommerce_mongo');
    console.log('connected to mongodb via native driver');

    // create compound index to speed up user wishlist queries
    await dbInstance.collection('wishlists').createIndex({ userId: 1, lastModified: -1 });

    // create text index for full-text searches inside item notes
    await dbInstance.collection('wishlists').createIndex({ "items.note": "text" });
  }
  return dbInstance;
}

// sync getter used by endpoints after initialization
function getDb() {
  if (!dbInstance) {
    throw new Error('db not initialized');
  }
  return dbInstance;
}

// gracefully close database connection to prevent memory leaks
async function closeMongo(signal) {
  console.log(`${signal} received: closing mongodb connection`);
  await client.close();
  process.exit(0);
}

// handle shutdown signals (e.g. ctrl+c or docker stop)
process.on('SIGINT', () => closeMongo('SIGINT'));
process.on('SIGTERM', () => closeMongo('SIGTERM'));

module.exports = { connectMongo, getDb, client };