/**
 * Migration script:
 * - Drops legacy unique indexes that block round-scoped evaluations/assignments
 * - Rebuilds indexes from current Mongoose schemas
 *
 * Usage:
 *   node scripts/migrateRoundScopedIndexes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Evaluation = require('../models/Evaluation');
const SubmissionAssignment = require('../models/SubmissionAssignment');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';

async function dropIndexIfExists(collection, indexName) {
  const indexes = await collection.indexes();
  const exists = indexes.some((index) => index.name === indexName);
  if (!exists) {
    console.log(`- Index not present, skipping: ${collection.collectionName}.${indexName}`);
    return;
  }
  await collection.dropIndex(indexName);
  console.log(`- Dropped index: ${collection.collectionName}.${indexName}`);
}

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    await dropIndexIfExists(Evaluation.collection, 'submissionId_1_judgeId_1');
    await dropIndexIfExists(SubmissionAssignment.collection, 'submissionId_1');
    await dropIndexIfExists(SubmissionAssignment.collection, 'roundId_1_submissionId_1');

    await Evaluation.syncIndexes();
    await SubmissionAssignment.syncIndexes();

    console.log('Round-scoped index migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

run();
