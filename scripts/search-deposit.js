require('dotenv').config({ path: __dirname + '/../.env' });
const { ethers } = require('ethers');
const fs = require('fs');

// Load Escrow contract ABI
const ESCROW_ABI = JSON.parse(fs.readFileSync(__dirname + '/../abi.js', 'utf8'));

// Import provider and contract from config module
const { provider, escrowContract, currencyHashToCode, verifierMapping, getPlatformName, platformNameMapping, currencyNameMapping } = require('../config.js');

// Enhanced platform name resolver
const getEnhancedPlatformName = (verifierAddress) => {
  if (!verifierAddress) return 'Unknown Platform';

  // First try the enhanced mapping
  if (platformNameMapping[verifierAddress]) {
    return platformNameMapping[verifierAddress];
  }

  // Fall back to original mapping
  return verifierMapping[verifierAddress] || 'Unknown Platform';
};

// Token name resolver
const getTokenName = (tokenAddress) => {
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return 'N/A';

  // Convert to lowercase for case-insensitive comparison
  const normalizedAddress = tokenAddress.toLowerCase();

  // Check the currency name mapping
  for (const [address, name] of Object.entries(currencyNameMapping)) {
    if (address.toLowerCase() === normalizedAddress) {
      return name;
    }
  }

  // If not found, return formatted address
  return formatAddress(tokenAddress);
};

async function searchDeposit(depositId) {

    try {
        // Convert deposit ID to bytes32 format
        const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(depositId), 32);

        // Get deposit details
        const deposit = await escrowContract.deposits(depositIdBytes32);

        if (!deposit.depositor || deposit.depositor === ethers.ZeroAddress) {
            return { error: `No deposit found with ID: ${depositId}` };
        }

        // Get deposit with all related data using getDeposit method
        const depositData = await escrowContract.getDeposit(depositId);

        // Helper function to convert currency hash to code
        const getCurrencyCode = (hash) => {
            // First try the standard mapping
            if (currencyNameMapping[hash]) {
                return currencyNameMapping[hash];
            }

            // If not found, format the hash in a readable way
            // Remove 0x prefix and show first 8 chars + last 4 chars
            const cleanHash = hash.startsWith('0x') ? hash.slice(2) : hash;
            return `${cleanHash.substring(0, 8)}...${cleanHash.substring(cleanHash.length - 4)}`;
        };

        // Helper function to format amount
        const formatAmount = (amount, decimals = 18) => {
            if (typeof amount === 'bigint') {
                return ethers.formatUnits(amount, decimals);
            }
            return amount;
        };

        // Helper function to format address
        const formatAddress = (address) => {
            if (address === ethers.ZeroAddress) return 'N/A';
            return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
        };

        // Format verifiers with platform names and currency codes
        const formattedVerifiers = depositData.verifiers.map(verifier => ({
            platform: getEnhancedPlatformName(verifier.verifier),
            address: formatAddress(verifier.verifier),
            verificationData: {
                intentGatingService: formatAddress(verifier.verificationData.intentGatingService),
                payeeDetails: verifier.verificationData.payeeDetails || 'N/A'
            },
            currencies: verifier.currencies.map(currency => ({
                code: getCurrencyCode(currency.code),
                conversionRate: formatAmount(currency.conversionRate, 18)
            }))
        }));

        // Get associated intents
        const intents = depositData.deposit.intentHashes || [];

        // Get verification data with platform names and their currencies
        const verificationData = formattedVerifiers.map(verifier => ({
            platform: verifier.platform,
            currencies: verifier.currencies
        }));

        // Format the data for return
        const result = {
            depositId: depositId,
            depositor: depositData.deposit.depositor,
            token: getTokenName(depositData.deposit.token),
            amount: formatAmount(depositData.deposit.amount, 6), // USDC has 6 decimals
            status: depositData.deposit.acceptingIntents ? '✅ Active' : '❌ Inactive',
            intents: intents,
            verificationData: verificationData
        };

        return result;
    } catch (error) {
        console.error('Error searching deposit:', error);
        throw error; // Re-throw to handle externally if needed
    }
}

// Format the search result for Telegram message
function formatTelegramMessage(result) {
  if (result.error) {
    return `❌ ${result.error}`;
  }

  // Format the response
  let message = `🔍 **Deposit Search Results**\n\n`;
  message += `📋 **Basic Information:**\n`;
  message += `• Deposit ID: \`${result.depositId}\`\n`;
  message += `• Depositor: \`${result.depositor}\`\n`;
  message += `• Token: \`${result.token}\`\n`;
  message += `• Amount: \`${formatUSDC(result.amount)}\` USDC\n`;
  message += `• Status: ${result.status}\n\n`;

  if (result.intents && result.intents.length > 0) {
    message += `📝 **Associated Intents:**\n`;
    result.intents.forEach((intent, index) => {
      message += `• Intent ${index + 1}: \`${intent}\`\n`;
    });
    message += `\n`;
  }

  if (result.verificationData && result.verificationData.length > 0) {
    message += `🔐 **Supported Platforms & Currencies:**\n`;
    result.verificationData.forEach((data, index) => {
      message += `• ${data.platform}\n`;
      if (data.currencies && data.currencies.length > 0) {
        data.currencies.forEach(currency => {
          const rate = (Number(currency.conversionRate)).toFixed(6);
          message += `  └ ${currency.code} ${rate}\n`;
        });
      }
    });
    message += `\n`;
  }

  return message;
}

// Helper function to format USDC amounts
function formatUSDC(amount) {
  if (typeof amount === 'string') {
    // If it's already formatted, return as is
    return amount;
  }

  if (typeof amount === 'bigint' || typeof amount === 'number') {
    // Convert from wei (6 decimals for USDC)
    return (Number(amount) / 1e6).toFixed(2);
  }

  return amount;
}

// Usage example
// searchDeposit(123); // Replace with actual deposit ID

// Export the functions for use in other modules
module.exports = { searchDeposit, formatTelegramMessage };