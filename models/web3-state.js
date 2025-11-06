/**
 * Web3 State Management Module
 * Manages global state for blockchain operations including deposits and transactions
 */

// Global deposit state tracking for sniper processing
// depositId -> {depositAmount, depositorAddress, tokenAddress, intentAmountRange, delegateAddress, intentGuardianAddress}
const depositState = new Map();

// Transaction processing state
// txHash -> {fulfilled: Set, pruned: Set, blockNumber: number, rawIntents: Map}
const pendingTransactions = new Map();

// Notification suppression state for preventing duplicate notifications
// intentHash -> timestamp (when suppression was set)
const notificationSuppression = new Map();

class Web3State {
  /**
   * Deposit State Management
   */
  static getDepositState() {
    return depositState;
  }

  static setDepositState(depositId, state) {
    depositState.set(depositId.toString(), state);
  }

  static getDepositStateById(depositId) {
    return depositState.get(depositId.toString());
  }

  static removeDepositState(depositId) {
    depositState.delete(depositId.toString());
  }

  static clearDepositState() {
    depositState.clear();
  }

  /**
   * Pending Transactions Management
   */
  static getPendingTransactions() {
    return pendingTransactions;
  }

  static getTransactionState(txHash) {
    return pendingTransactions.get(txHash.toLowerCase());
  }

  static setTransactionState(txHash, state) {
    pendingTransactions.set(txHash.toLowerCase(), state);
  }

  static hasTransaction(txHash) {
    return pendingTransactions.has(txHash.toLowerCase());
  }

  static removeTransaction(txHash) {
    pendingTransactions.delete(txHash.toLowerCase());
  }

  static clearTransactions() {
    pendingTransactions.clear();
  }

  /**
   * Transaction Intents Management
   */
  static addTransactionIntent(txHash, intentHash, intentData) {
    const txHashLower = txHash.toLowerCase();
    const intentHashLower = intentHash.toLowerCase();

    if (!pendingTransactions.has(txHashLower)) {
      pendingTransactions.set(txHashLower, {
        txHash: txHashLower,
        fulfilled: new Set(),
        pruned: new Set(),
        rawIntents: new Map(),
        processed: false
      });
    }

    const txData = pendingTransactions.get(txHashLower);
    txData.rawIntents.set(intentHashLower, intentData);
  }

  static getTransactionIntent(txHash, intentHash) {
    const txData = this.getTransactionState(txHash);
    return txData?.rawIntents?.get(intentHash.toLowerCase());
  }

  static getAllIntentsForTransaction(txHash) {
    const txData = this.getTransactionState(txHash);
    return txData?.rawIntents || new Map();
  }

  static markIntentFulfilled(txHash, intentHash) {
    const txData = this.getTransactionState(txHash);
    if (txData) {
      txData.fulfilled.add(intentHash.toLowerCase());
    }
  }

  static markIntentPruned(txHash, intentHash) {
    const txData = this.getTransactionState(txHash);
    if (txData) {
      txData.pruned.add(intentHash.toLowerCase());
    }
  }

  static getFulfilledIntents(txHash) {
    const txData = this.getTransactionState(txHash);
    return txData?.fulfilled || new Set();
  }

  static getPrunedIntents(txHash) {
    const txData = this.getTransactionState(txHash);
    return txData?.pruned || new Set();
  }

  /**
   * State Cleanup
   */
  static cleanupCompletedTransactions() {
    for (const [txHash, txData] of pendingTransactions.entries()) {
      if (txData.processed && (txData.fulfilled.size > 0 || txData.pruned.size > 0)) {
        pendingTransactions.delete(txHash);
      }
    }
  }

  /**
   * State Statistics
   */
  static getStateStats() {
    let totalIntents = 0;
    let totalFulfilled = 0;
    let totalPruned = 0;

    for (const txData of pendingTransactions.values()) {
      totalIntents += txData.rawIntents.size;
      totalFulfilled += txData.fulfilled.size;
      totalPruned += txData.pruned.size;
    }

    return {
      totalTransactions: pendingTransactions.size,
      totalDeposits: depositState.size,
      totalIntents,
      totalFulfilled,
      totalPruned
    };
  }

  /**
   * Notification Suppression Management
   */
  static suppressPrunedNotification(intentHash) {
    const key = intentHash.toLowerCase();
    const timestamp = Date.now();
    notificationSuppression.set(key, timestamp);
    console.log(`🔇 Suppressed pruned notification for intent ${key}`);
  }

  static isPrunedNotificationSuppressed(intentHash) {
    const key = intentHash.toLowerCase();
    const suppressed = notificationSuppression.has(key);
    if (suppressed) {
      console.log(`⚠️ Pruned notification already suppressed for intent ${key}`);
    }
    return suppressed;
  }

  static clearNotificationSuppression(intentHash) {
    const key = intentHash.toLowerCase();
    notificationSuppression.delete(key);
  }

  static cleanupNotificationSuppression(maxAgeSeconds = 300) { // Default 5 minutes
    const now = Date.now();
    const maxAge = maxAgeSeconds * 1000;

    for (const [key, timestamp] of notificationSuppression.entries()) {
      if (now - timestamp > maxAge) {
        notificationSuppression.delete(key);
      }
    }
  }
}

module.exports = {
  depositState,
  pendingTransactions,
  notificationSuppression,
  Web3State
};