/**
 * Refactored Web3Service - Main orchestrator for blockchain interactions
 */

require('dotenv').config({ path: __dirname + '../.env' });

// Import all the modular components
const ResilientWebSocketProvider = require('../websocket/resilient-websocket-provider');
const { Web3State } = require('../models/web3-state');
const { Utils } = require('../utils/web3-utils');
const {
  CONTRACT_ADDRESS,
  currencyHashToCode,
  verifierMapping,
  platformNameMapping,
  currencyNameMapping,
  getPlatformName,
  formatConversionRate,
  contractABI,
  iface,
  CONNECTION_CONFIG,
  EXPLORER_CONFIG,
  CONVERSION_FACTORS,
  normalizedPlatformMapping
} = require('../config/web3-config');

// Import orchestrator contract address from config
const { orchestratorContract } = require('../config.js');
const orchestratorContractAddress = orchestratorContract.target;

const {
  sendFulfilledNotification,
  sendPrunedNotification,
  sendSignaledNotification
} = require('../notifications/telegram-notifications');

const {
  handleContractEvent
} = require('../events/contract-event-handlers');

const {
  checkSniperOpportunity
} = require('../sniper/sniper-service');

const {
  scheduleTransactionProcessing,
  processCompletedTransaction,
  sendTransactionNotifications
} = require('../transactions/transaction-manager');

// Global state management for sniper processing
global.depositState = Web3State.getDepositState();
global.pendingTransactions = Web3State.getPendingTransactions();

// Import orchestrator event handler
const { handleOrchestratorEvent } = require('../events/contract-event-handlers');

// Web3Service class to manage all blockchain interactions
class Web3Service {
  constructor(wsUrl, eventHandler, orchestratorWsUrl, orchestratorEventHandler) {
    this.wsUrl = wsUrl || process.env.BASE_WS_URL;
    this.eventHandler = eventHandler || handleContractEvent;
    this.orchestratorWsUrl = orchestratorWsUrl || process.env.BASE_WS_URL; // Use same WS URL for now
    this.orchestratorEventHandler = orchestratorEventHandler || handleOrchestratorEvent;
    this.provider = null;
    this.orchestratorProvider = null;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;

    console.log('🔄 Initializing Web3Service...');

    try {
      console.log(`📡 Creating escrow provider for contract: ${CONTRACT_ADDRESS}`);
      // Initialize escrow provider (legacy)
      this.provider = new ResilientWebSocketProvider(
        this.wsUrl,
        this.eventHandler,
        CONTRACT_ADDRESS
      );

      console.log(`📡 Creating orchestrator provider for contract: ${orchestratorContractAddress}`);
      // Initialize orchestrator provider (new)
      this.orchestratorProvider = new ResilientWebSocketProvider(
        this.orchestratorWsUrl,
        this.orchestratorEventHandler,
        orchestratorContractAddress
      );

      this.isInitialized = true;

      // Attach providers to global for cross-module access
      if (!global.provider) {
        global.provider = this.provider.currentProvider;
      }
      if (!global.orchestratorProvider) {
        global.orchestratorProvider = this.orchestratorProvider.currentProvider;
      }

      console.log('✅ Web3Service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Web3Service:', error);
      throw error;
    }
  }

  async destroy() {
    if (this.provider) {
      await this.provider.destroy();
      this.provider = null;
    }
    if (this.orchestratorProvider) {
      await this.orchestratorProvider.destroy();
      this.orchestratorProvider = null;
    }
    this.isInitialized = false;

    // Clean up global references
    if (global.provider === this.provider?.currentProvider) {
      global.provider = null;
    }
    if (global.orchestratorProvider === this.orchestratorProvider?.currentProvider) {
      global.orchestratorProvider = null;
    }
  }

  get isConnected() {
    return this.provider && this.provider.isConnected;
  }

  get isOrchestratorConnected() {
    return this.orchestratorProvider && this.orchestratorProvider.isConnected;
  }

  async restart() {
    if (this.provider) {
      await this.provider.restart();
    }
    if (this.orchestratorProvider) {
      await this.orchestratorProvider.restart();
    }
  }

  // Accessor methods for backward compatibility
  getContractAddress() {
    return CONTRACT_ADDRESS;
  }

  getAbi() {
    return contractABI;
  }

  getCurrencyHashToCode() {
    return currencyHashToCode;
  }

  getVerifierMapping() {
    return verifierMapping;
  }

  getPlatformName(verifierAddress) {
    return getPlatformName(verifierAddress);
  }

  formatConversionRate(conversionRate, fiatCode) {
    return formatConversionRate(conversionRate, fiatCode);
  }

  // Delegate sniper opportunity checking to the specialized module
  checkSniperOpportunity(depositId, depositAmount, currencyHash, conversionRate, verifierAddress) {
    return checkSniperOpportunity(depositId, depositAmount, currencyHash, conversionRate, verifierAddress);
  }
}

// Export singleton instance
let web3ServiceInstance = null;

function getWeb3Service(wsUrl, eventHandler) {
  if (!web3ServiceInstance) {
    web3ServiceInstance = new Web3Service(wsUrl, eventHandler);
  }
  return web3ServiceInstance;
}

// Export both class and factory function
module.exports = {
  Web3Service,
  getWeb3Service,

  // Export individual components for backward compatibility
  ResilientWebSocketProvider,
  CONTRACT_ADDRESS,
  contractABI,
  iface,
  currencyHashToCode,
  verifierMapping,
  getPlatformName,
  formatConversionRate,
  checkSniperOpportunity,
  handleContractEvent,
  scheduleTransactionProcessing,
  processCompletedTransaction,
  sendFulfilledNotification,
  sendPrunedNotification,
  sendSignaledNotification,
  sendTransactionNotifications,
  Utils,
  Web3State
};