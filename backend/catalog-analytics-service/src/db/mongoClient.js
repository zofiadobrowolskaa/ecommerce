const { MongoClient } = require('mongodb');

// connection uri fallback
const uri = process.env.MONGO_URI || 'mongodb://admin:password@mongodb:27017';

// single shared MongoClient instance for the entire process (singleton)
const client = new MongoClient(uri);

let dbInstance = null;

// singleton pattern: connect once, reuse the same db handle everywhere
async function connectMongo() {
  if (!dbInstance) {
    await client.connect();
    dbInstance = client.db('ecommerce_mongo');
    console.log('connected to mongodb via native driver');

    // mongo only allows one text index per collection;
    // drop legacy index (top-level fields) if present before re-creating with the correct nested path
    try {
      await dbInstance.collection('event_log').dropIndex('details_text_action_text');
    } catch (e) {
      // ignore if it does not exist (clean db / already migrated)
    }

    // text index on nested array fields: events[] contains the actual action/details payload
    await dbInstance.collection('event_log').createIndex({ "events.details": "text", "events.action": "text" });

    // composite index speeds up "events of user X with action Y" lookups
    await dbInstance.collection('event_log').createIndex({ userId: 1, lastAction: 1 });

    // unique index ensures one draft per session
    await dbInstance.collection('cart_draft').createIndex({ sessionId: 1 }, { unique: true });
  }
  return dbInstance;
}

// synchronous accessor used by endpoints after init has completed
function getDb() {
  if (!dbInstance) {
    throw new Error('db not initialized');
  }
  return dbInstance;
}

// graceful shutdown: drop the connection cleanly before the process exits
async function closeMongo(signal) {
  console.log(`${signal} received: closing mongodb connection`);
  await client.close();
  process.exit(0);
}

// SIGINT is sent by Ctrl+C in local dev
process.on('SIGINT', () => closeMongo('SIGINT'));
// SIGTERM is the default signal sent by docker stop / orchestrators
process.on('SIGTERM', () => closeMongo('SIGTERM'));

module.exports = { connectMongo, getDb, client };