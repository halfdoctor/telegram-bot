const DatabaseManager = require('../scripts/database-manager');
const {
  normalizedPlatformMapping,
  EXPLORER_CONFIG,
  currencyHashToCode,
  currencyNameMapping,
  getPlatformName,
  CONVERSION_FACTORS
} = require('../config/web3-config');

// Helper function to check for zero addresses
function isZeroAddress(address) {
  return !address ||
          address === '0x0000000000000000000000000000000000000000000000000000000000000000' ||
          address === '0x0000000000000000000000000000000000000000';
}

// Utility functions class
class Utils {
  /**
   * Safely converts amount from microunits to decimal
   */
  static convertFromMicrounits(amount, decimals = CONVERSION_FACTORS.USDC_DECIMALS) {
    return Number(amount) / decimals;
  }

  /**
   * Safely converts conversion rate from wei to decimal
   */
  static convertFromWei(amount) {
    return Number(amount) / CONVERSION_FACTORS.WEI_DECIMALS;
  }

  /**
   * Formats fiat amount with currency symbol
   */
  static formatFiatAmount(amount, currencyName) {
    return `${currencyName} ${amount.toLocaleString()}`;
  }

  /**
   * Gets platform name with fallback logic
   */
  static resolvePlatformName(verifier, owner, recipient) {
    return normalizedPlatformMapping[verifier?.toLowerCase()] ||
            normalizedPlatformMapping[owner?.toLowerCase()] ||
            normalizedPlatformMapping[recipient?.toLowerCase()] ||
            getPlatformName(verifier) ||
            'Unknown Platform';
  }

  /**
   * Creates standardized send options for Telegram messages
   */
  static createSendOptions(parseMode = 'Markdown', disablePreview = true, threadId = null) {
    const options = {
      parse_mode: parseMode,
      disable_web_page_preview: disablePreview
    };

    if (threadId) {
      options.message_thread_id = threadId;
    }

    return options;
  }

  /**
   * Formats transaction hash for display
   */
  static formatTxHash(txHash) {
    if (!txHash) return '';
    return `[${txHash.slice(0, 8)}...${txHash.slice(-6)}](${EXPLORER_CONFIG.BASESCAN_URL}${txHash})`;
  }

  /**
   * Formats timestamp to readable string
   */
  static formatTimestamp(timestamp) {
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
  }

  /**
   * Safely gets currency information
   */
  static getCurrencyInfo(fiatCurrency) {
    const currencyCode = currencyHashToCode[fiatCurrency] || 'USD';
    const currencyName = currencyNameMapping[fiatCurrency] || '🇺🇸 $ USD';
    return { currencyCode, currencyName };
  }

  /**
   * Calculates fiat amount from USDC amount and conversion rate
   */
  static calculateFiatAmount(usdcAmount, conversionRate) {
    return usdcAmount * conversionRate;
  }

  /**
   * Handles async operations safely
   */
  static async safeExecute(operation, errorMessage = 'Operation failed') {
    try {
      return await operation();
    } catch (error) {
      console.error(`❌ ${errorMessage}:`, error);
      throw error;
    }
  }
}

module.exports = {
  Utils,
  isZeroAddress
};