require('dotenv').config({ path: __dirname + '/../.env' });
const { Interface } = require('ethers');
const fs = require('fs');
const path = require('path');

// Import from existing config and ABI files
const {
  CONTRACT_ADDRESS,
  currencyHashToCode,
  verifierMapping,
  platformNameMapping,
  currencyNameMapping,
  getPlatformName,
  formatConversionRate
} = require('../config');

// WebSocket connection configuration
const CONNECTION_CONFIG = {
  RECONNECT_DELAY_MS: 1000,
  MAX_RECONNECT_DELAY_MS: 30000,
  MAX_RECONNECT_ATTEMPTS: 50,
  CONNECTION_TIMEOUT_MS: 15000,
  KEEP_ALIVE_INTERVAL_MS: 30000,
  ACTIVITY_TIMEOUT_MS: 120000,
  INACTIVITY_THRESHOLD_MS: 90000,
  RECONNECT_BACKOFF_MULTIPLIER: 1.5,
  MANUAL_RESTART_DELAY_MS: 3000,
  EVENT_PROCESSING_DELAY_MS: 2000,
  RAPID_RECONNECT_DELAY_MS: 2000
};

// Explorer and external service configuration
const EXPLORER_CONFIG = {
  BASESCAN_URL: 'https://basescan.org/tx/',
  ZKP2P_GROUP_ID: -1001928949520,
  ZKP2P_SNIPER_TOPIC_ID: 5671
};

// Conversion factors and constants
const CONVERSION_FACTORS = {
  USDC_DECIMALS: 1e6,
  WEI_DECIMALS: 1e18
};

// WebSocket state constants
const WEBSOCKET_STATES = {
  OPEN: 1
};

// Create normalized platform mapping with lowercase keys for case-insensitive lookups
const normalizedPlatformMapping = {};
for (const [address, platform] of Object.entries(platformNameMapping)) {
  normalizedPlatformMapping[address.toLowerCase()] = platform;
}

// Load contract ABI from deployments/Escrow.json for escrow contract events
const contractABI = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'Escrow.json'), 'utf8')).abi;

// Create interface for parsing logs
const iface = new Interface(contractABI);

module.exports = {
  CONTRACT_ADDRESS,
  currencyHashToCode,
  verifierMapping,
  platformNameMapping,
  currencyNameMapping,
  getPlatformName,
  formatConversionRate,
  CONNECTION_CONFIG,
  EXPLORER_CONFIG,
  CONVERSION_FACTORS,
  WEBSOCKET_STATES,
  normalizedPlatformMapping,
  contractABI,
  iface
};