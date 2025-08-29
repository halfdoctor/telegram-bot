require('dotenv').config({ path: __dirname + '/../.env' });
const { ethers } = require('ethers');
const fs = require('fs');

// Load Escrow contract ABI
const ESCROW_ABI = JSON.parse(fs.readFileSync(__dirname + '/../abi.js', 'utf8'));

// Import provider and contract from config module
const { provider, escrowContract, currencyHashToCode, verifierMapping, getPlatformName, platformNameMapping, currencyNameMapping } = require('../config.js');

// Import exchange service for market rate comparisons
const { getCurrencyRate } = require('./exchange-service.js');

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
        
        // Helper function to fetch detailed intent data
        const getIntentDetails = async (intentHash) => {
          try {
            const intentView = await escrowContract.getIntent(intentHash);

            return {
              intentHash: intentHash, // Use the original hash parameter
              amount: formatAmount(intentView.intent.amount, 6), // USDC has 6 decimals
              verifier: getEnhancedPlatformName(intentView.intent.paymentVerifier),
              currencyCode: getCurrencyCode(intentView.intent.fiatCurrency),
              exchangeRate: formatAmount(intentView.intent.conversionRate, 18),
              timestamp: intentView.intent.timestamp,
              timeSinceOrder: calculateTimeSince(intentView.intent.timestamp)
            };
          } catch (error) {
            console.error('Error fetching intent details:', error);
            return null;
          }
        };
        
        // Helper function to calculate time since order
        const calculateTimeSince = (timestamp) => {
          if (!timestamp || timestamp === 0) return 'N/A';
        
          const now = Math.floor(Date.now() / 1000); // Current time in seconds
          const secondsSince = now - Number(timestamp);
        
          if (secondsSince < 60) return `${secondsSince}s ago`;
          if (secondsSince < 3600) return `${Math.floor(secondsSince / 60)}m ago`;
          if (secondsSince < 86400) return `${Math.floor(secondsSince / 3600)}h ago`;
          return `${Math.floor(secondsSince / 86400)}d ago`;
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
        const intentHashes = depositData.deposit.intentHashes || [];

        // Fetch detailed intent data for each intent hash
        const detailedIntents = [];
        for (const intentHash of intentHashes) {
            try {
                const intentDetails = await getIntentDetails(intentHash);
                if (intentDetails) {
                    detailedIntents.push(intentDetails);
                } else {
                    console.log(`Could not fetch details for intent: ${intentHash}`);
                }
            } catch (error) {
                console.error(`Error fetching intent details for ${intentHash}:`, error.message);
            }
        }

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
            remainingAmount: formatAmount(depositData.deposit.remainingDeposits, 6),
            status: depositData.deposit.acceptingIntents ? '✅ Active' : '❌ Inactive',
            intents: detailedIntents, // Use detailed intents instead of just hashes
            verificationData: verificationData
        };

        return result;
    } catch (error) {
        console.error('Error searching deposit:', error);
        throw error; // Re-throw to handle externally if needed
    }
}

// Format the search result for Telegram message
async function formatTelegramMessage(result) {
  if (result.error) {
    return `❌ ${result.error}`;
  }

  // Format the response
  let message = `🔍 <b>Deposit Search Results</b>\n\n`;
  message += `📋 <b>Basic Information:</b>\n`;
  message += `• Deposit ID: ${result.depositId}\n`;
  message += `• Depositor: ${result.depositor}\n`;
  message += `• Token: ${result.token}\n`;
  message += `• Amount: ${formatUSDC(result.amount)} USDC\n`;
  message += `• Remaining Amount: ${formatUSDC(result.remainingAmount)} USDC\n`;
  message += `• Status: ${result.status}\n\n`;

  if (result.intents && result.intents.length > 0) {
    message += `📝 <b>Associated Intents:</b>\n`;
    result.intents.forEach((intent, index) => {
      // Handle both detailed intent objects and simple hash strings
      if (typeof intent === 'string') {
        // Legacy format - just the hash
        message += `• Intent ${index + 1}: ${intent}\n`;
      } else if (intent && typeof intent === 'object') {
        // New detailed format - check if we have intentHash or use index
        const hash = intent.intentHash || `intent-${index + 1}`;
        message += `• Intent ${index + 1}: ${hash}\n`;
        if (intent.amount !== undefined) {
          message += `       💰 Amount: ${formatUSDC(intent.amount)} USDC\n`;
        }
        if (intent.verifier) {
          message += `       🏦 Verifier: ${intent.verifier}\n`;
        }
        if (intent.currencyCode) {
          message += `       💱 Currency: ${intent.currencyCode}\n`;
        }
        if (intent.exchangeRate) {
          message += `       📊 Rate: ${intent.exchangeRate}\n`;
        }
        if (intent.timeSinceOrder) {
          message += `       ⏰ Time: ${intent.timeSinceOrder}\n`;
        }
      }
    });
    message += `\n`;
  }

  if (result.verificationData && result.verificationData.length > 0) {
    message += `🔐 <b>Supported Platforms & Currencies:</b>\n`;
    for (const data of result.verificationData) {
      message += `• ${data.platform}\n`;
      if (data.currencies && data.currencies.length > 0) {
        for (const currency of data.currencies) {
          const rate = (Number(currency.conversionRate)).toFixed(4);

          // Fetch current market rate for comparison
          let marketRateText = '';
          let markupText = '';

          try {
            // Get USD to fiat rate (e.g., USD to EUR)
            const marketRate = await getCurrencyRate('USD', currency.code);

            if (marketRate && marketRate > 0) {
              // Calculate markup percentage: ((offered_rate - market_rate) / market_rate) * 100
              const markupPercentage = ((Number(currency.conversionRate) - marketRate) / marketRate) * 100;

              // Format market rate in blue
              const marketRateFormatted = marketRate.toFixed(4);
              rateText =`<b>${rate}</b>`;
              marketRateText = `${marketRateFormatted}`;

              // Format markup percentage with color coding
              const absMarkup = Math.abs(markupPercentage);
              const markupFormatted = markupPercentage.toFixed(2);

              if (markupPercentage >= 0) {
                // Positive markup (green)
                markupText = `🟢 <b>+${markupFormatted}%</b>`;
              } else {
                // Negative markup (red)
                markupText = `🔴 <b>${markupFormatted}%</b>`;
              }
            } else {
              marketRateText = 'N/A';
              markupText = 'N/A';
            }
          } catch (error) {
            console.error(`Error fetching market rate for ${currency.code}:`, error);
            marketRateText = 'N/A';
            markupText = 'N/A';
          }

          message += `       ${currency.code} ${rateText} (Mkt: ${marketRateText}) (${markupText})\n`;
        }
      }
    }
    message += `\n`;
  }

  return message;
}

// Helper function to format USDC amounts
function formatUSDC(amount) {
  if (typeof amount === 'string') {
    // If it's already formatted, return as is
    return (Number(amount)).toFixed(2);
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