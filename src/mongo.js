const { MongoClient, GridFSBucket } = require('mongodb');

let clientPromise = null;

function getMongoUri() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri || !String(uri).trim()) return null;
  return String(uri).trim();
}

function getDbName() {
  return String(process.env.MONGODB_DB || process.env.MONGO_DB || 'avyro_editor').trim();
}

async function getClient() {
  const uri = getMongoUri();
  if (!uri) throw new Error('Missing MONGODB_URI.');

  if (!clientPromise) {
    const client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  return await clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(getDbName());
}

async function getBucket() {
  const db = await getDb();
  return new GridFSBucket(db, { bucketName: 'pdfFiles' });
}

module.exports = {
  getMongoUri,
  getDb,
  getBucket
};

