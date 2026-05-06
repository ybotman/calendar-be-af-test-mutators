// Mongo client singleton for the TEST-mutator Function App.
// Reads MONGODB_URI from environment; expected to point at TEST tier only.

'use strict';

const { MongoClient } = require('mongodb');

let cachedClient = null;

async function getMongoClient() {
    if (cachedClient) return cachedClient;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not configured (expected TEST tier URI)');
    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    return client;
}

async function getDb() {
    const client = await getMongoClient();
    return client.db();
}

async function closeMongo() {
    if (cachedClient) {
        await cachedClient.close();
        cachedClient = null;
    }
}

module.exports = { getMongoClient, getDb, closeMongo };
