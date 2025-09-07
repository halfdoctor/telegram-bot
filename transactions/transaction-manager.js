const { CONNECTION_CONFIG } = require('../config/web3-config');
const { pendingTransactions, Web3State } = require('../models/web3-state');

/**
 * Transaction Management Module
 * Handles scheduling and processing of blockchain transactions
 */

// Transaction processing functions
function scheduleTransactionProcessing(txHash) {
  console.log(`🚀 scheduleTransactionProcessing called for tx ${txHash}`);

  if (Web3State.hasTransaction(txHash)) {
    console.log(`📝 Transaction ${txHash} already scheduled for processing`);
    return;
  }

  // Schedule processing with a delay to allow for confirmations
  console.log(`⏱️ Setting timeout for ${CONNECTION_CONFIG.EVENT_PROCESSING_DELAY_MS / 1000}s delay`);
  setTimeout(() => {
    console.log(`⏰ Timeout fired for tx ${txHash}`);
    if (Web3State.hasTransaction(txHash)) {
      console.log(`✅ Processing transaction ${txHash}`);
      processCompletedTransaction(txHash);
    } else {
      console.log(`⚠️ Transaction ${txHash} already processed or removed`);
    }
  }, CONNECTION_CONFIG.EVENT_PROCESSING_DELAY_MS);

  console.log(`📝 Scheduled transaction processing for ${txHash} in ${CONNECTION_CONFIG.EVENT_PROCESSING_DELAY_MS / 1000} seconds`);
}

async function processCompletedTransaction(txHash) {
  console.log(`🚀 processCompletedTransaction called with txHash: ${txHash}`);

  const txData = Web3State.getTransactionState(txHash);
  if (!txData) {
    console.log(`⚠️ No transaction data found for ${txHash}. Available transactions:`, Array.from(pendingTransactions.keys()));
    return;
  }

  console.log(`📊 Transaction data for ${txHash}:`, {
    prunedCount: txData.pruned ? txData.pruned.size : 0,
    fulfilledCount: txData.fulfilled ? txData.fulfilled.size : 0,
    rawIntentCount: txData.rawIntents ? txData.rawIntents.size : 0,
    processed: txData.processed
  });

  console.log(`🎯 Processing completed transaction ${txHash}`);

  // 🚨 SEND NOTIFICATIONS FOR PROCESSED INTENTS 🚨
  await sendTransactionNotifications(txHash);
  console.log(`✅ Notifications sent for transaction ${txHash}`);

  console.log(`🧹 Cleaning up transaction data for ${txHash}`);
  Web3State.removeTransaction(txHash);
}

// Import notification functions
const {
  sendFulfilledNotification,
  sendPrunedNotification,
  sendSignaledNotification
} = require('../notifications/telegram-notifications');

// Notification helper function for processed transaction events
async function sendTransactionNotifications(txHash) {
  const txData = Web3State.getTransactionState(txHash);
  if (!txData) return;

  console.log(`📢 Processing notifications for ${txData.fulfilled?.size || 0} fulfilled and ${txData.pruned?.size || 0} pruned intents`);

  // Get all unique intent hashes from both fulfilled and pruned sets
  const allIntentHashes = new Set([...(txData.fulfilled || new Set()), ...(txData.pruned || new Set())]);

  for (const intentHash of allIntentHashes) {
    const rawIntent = txData.rawIntents?.get(intentHash);
    if (!rawIntent) continue;

    console.log(`🔍 Processing intent ${intentHash} with status: ${
      txData.fulfilled?.has(intentHash) ? 'FULFILLED' :
      txData.pruned?.has(intentHash) ? 'PRUNED' : 'UNKNOWN'
    }`);

    if (txData.fulfilled?.has(intentHash)) {
      console.log(`✅ Sending fulfilled notification for ${intentHash}`);
      await sendFulfilledNotification(rawIntent, txHash);
    } else if (txData.pruned?.has(intentHash)) {
      console.log(`🟠 Sending pruned notification for ${intentHash}`);
      await sendPrunedNotification(rawIntent, txHash);
    }
  }

  console.log(`✅ All notifications sent for transaction ${txHash}`);
}

module.exports = {
  scheduleTransactionProcessing,
  processCompletedTransaction,
  sendTransactionNotifications
};