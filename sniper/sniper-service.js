const DatabaseManager = require('../scripts/database-manager');
const { getExchangeRates } = require('../scripts/exchange-service');
const { Utils, isZeroAddress } = require('../utils/web3-utils');
const { escrowContract } = require('../config');
const {
  currencyHashToCode,
  EXPLORER_CONFIG,
  getPlatformName,
  currencyNameMapping, 
  platformNameMapping
} = require('../config/web3-config');

/**
 * Sniper Service Module
 * Handles sniper opportunity detection and alert functionality
 */

async function checkSniperOpportunity(depositId, depositAmount, currencyHash, conversionRate, verifierAddress) {
  // Validate input parameters
  if (!depositId) {
    console.error(`❌ Invalid depositId provided to sniper service`);
    return;
  }

  // If depositAmount is not provided or is zero, try multiple sources
  if (!depositAmount || depositAmount <= 0) {
    const dbManager = new DatabaseManager();
    let fallbackAmount = null;

    // Try to get deposit amount from database first
    try {
      depositAmount = await dbManager.getDepositAmount(depositId);
      if (depositAmount && depositAmount > 0) {
        console.log(`📊 Using database amount: ${Utils.convertFromMicrounits(depositAmount)} USDC`);
      }
    } catch (dbError) {
      console.error(`❌ Database error:`, dbError.message);
    }

    // If still no amount from database, try contract
    if (!depositAmount || depositAmount <= 0) {
      try {
        if (escrowContract) {
          // Method 1: Use the bytes32 format for deposits mapping (primary method) - EXACTLY like search-deposit.js
          try {
            const { ethers } = require('ethers');
            const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(depositId)), 32);

            // First check if deposit exists in the deposits mapping
            const deposit = await escrowContract.deposits(depositIdBytes32);
            if (deposit && deposit.depositor && deposit.depositor !== ethers.ZeroAddress) {
              // Found deposit in mapping, now get detailed data
            }
          } catch (depositsError) {
            console.warn(`⚠️ Mapping check failed: ${depositsError.message}`);
          }

          // Method 2: Use getDeposit method for full data (secondary method) - EXACTLY like search-deposit.js
          try {
            const depositData = await escrowContract.getDeposit(depositId);

            // Check for deposit data structure exactly like in search-deposit.js
            if (depositData && depositData.deposit && depositData.deposit.amount) {
              const contractAmount = BigInt(depositData.deposit.amount).toString();
              fallbackAmount = contractAmount;
              console.log(`✅ Retrieved from contract: ${Utils.convertFromMicrounits(contractAmount)} USDC`);

              // Cache in Web3State for future use
              try {
                const { Web3State } = require('../models/web3-state');
                Web3State.setDepositState(depositId.toString(), {
                  depositAmount: contractAmount,
                  verifierAddress: verifierAddress || '0x0000000000000000000000000000000000000000'
                });
                console.log(`✅ Cached deposit data in Web3State: ${depositId}`);

                // Also store in database for future use
                try {
                  await dbManager.storeDepositAmount(depositId, contractAmount);
                } catch (storeError) {
                  console.error(`❌ Error storing deposit amount in database:`, storeError);
                }
              } catch (cacheError) {
                console.error(`❌ Error caching deposit data:`, cacheError);
              }
            } else {
              console.log(`⚠️ No deposit found in contract for ${depositId}`);
            }
          } catch (getDepositError) {
            console.log(`⚠️ getDeposit method failed: ${getDepositError.message}`);
          }
        } else {
          console.warn(`⚠️ No contract access available`);
        }
      } catch (contractError) {
        console.error(`❌ Error fetching deposit from contract for ${depositId}:`, contractError);
      }
    }

    // Use fallback amount if we successfully retrieved one, otherwise use default
    if (fallbackAmount) {
      depositAmount = fallbackAmount;
    } else if (!depositAmount || depositAmount <= 0) {
      console.log(`⚠️ Using default fallback amount`);
      depositAmount = 1e6; // Default fallback: 1 USDC (6 decimals)
    }
  }

  // Ensure depositAmount is a string and valid
  if (typeof depositAmount === 'number') {
    depositAmount = depositAmount.toString();
  }

  // Validate depositAmount is a valid positive number
  try {
    const amountValue = parseInt(depositAmount);
    if (amountValue <= 0) {
      console.error(`❌ Invalid deposit amount: ${depositAmount}, using fallback`);
      depositAmount = '1000000';
    }
  } catch (parseError) {
    console.error(`❌ Error parsing deposit amount: ${depositAmount}, using fallback`);
    depositAmount = '1000000';
  }
  // Extract currency code from currencyNameMapping by parsing the display name
  let currencyCode = null;
  const currencyName = currencyNameMapping[currencyHash.toLowerCase()];
  if (currencyName) {
    // Extract currency code from format like "🇯🇵 ¥ JPY" -> "JPY"
    const currencyCodeMatch = currencyName.match(/\b([A-Z]{3})\b$/);
    currencyCode = currencyCodeMatch ? currencyCodeMatch[1] : null;
  }

  // Fallback to currencyHashToCode if not found in currencyNameMapping
  if (!currencyCode) {
    currencyCode = currencyHashToCode[currencyHash.toLowerCase()];
  }

  // Extract platform name from platformNameMapping, similar to currency extraction
  let platformName = 'unknown platform'; // Default fallback
  const platformDisplayName = platformNameMapping[verifierAddress];
  if (platformDisplayName) {
    // Extract platform name from format like "🌍 Wise" -> "wise"
    const platformNameMatch = platformDisplayName.match(/([^ ]+)$/);
    platformName = platformNameMatch ? platformNameMatch[1].toLowerCase() : 'unknown platform';
  }

  // Fallback to getPlatformName if not found in platformNameMapping
  if (platformName === 'unknown platform') {
    platformName = getPlatformName(verifierAddress).toLowerCase();
  }

  if (!currencyCode) return; // Only skip unknown currencies

  // Get current exchange rates
  const exchangeRates = await getExchangeRates();
  if (!exchangeRates) {
    console.warn('⚠️ No exchange rates available');
    return;
  }

  // For USD, market rate is always 1.0
  const marketRate = currencyCode === 'USD' ? 1.0 : exchangeRates.conversion_rates[currencyCode];
  if (!marketRate) {
    console.warn(`⚠️ No market rate for ${currencyCode}`);
    return;
  }

  // Calculate rates
  const depositRate = Number(conversionRate) / 1e18; // Convert from wei
  const percentageDiff = ((marketRate - depositRate) / marketRate) * 100;

  console.log(`🎯 Checking sniper: ${depositId} (${percentageDiff.toFixed(1)}% vs market)`);

  // Get users with their custom thresholds
  const dbManager = new DatabaseManager();
  const interestedUsers = await dbManager.getUsersWithSniper(currencyCode, platformName);

  // Add default group if not already included
  const groupId = EXPLORER_CONFIG.ZKP2P_GROUP_ID;
  if (!interestedUsers.some(user => user.chat_id === groupId)) {
    interestedUsers.push({
      chat_id: groupId,
      currency: currencyCode,
      platform: platformName,
      created_at: new Date().toISOString()
    });
  }

  if (interestedUsers.length > 0) {
    for (const user of interestedUsers) {
      // Validate user object structure
      if (!user || typeof user !== 'object' || !user.chat_id) {
        console.error(`❌ Invalid user:`, user);
        continue;
      }

      const chatId = user.chat_id;

      // Get user threshold with error handling
      let userThreshold;
      try {
        userThreshold = await dbManager.getUserThreshold(chatId);
        if (userThreshold === null || userThreshold === undefined) {
          console.warn(`⚠️ Using default threshold 0.5% for ${chatId}`);
          userThreshold = 0.5;
        }
      } catch (error) {
        console.error(`❌ Threshold error for ${chatId}:`, error.message);
        continue;
      }

      if (percentageDiff >= userThreshold) {
        console.log(`🎯 SNIPER! ${chatId} (${percentageDiff.toFixed(1)}% >= ${userThreshold}%)`);

        const formattedAmount = Utils.convertFromMicrounits(depositAmount).toFixed(2);
        const depositCost = (Number(depositAmount) / 1e6 * depositRate).toFixed(2);
        const marketCost = (Number(depositAmount) / 1e6 * marketRate).toFixed(2);
        const savings = (Number(depositAmount) / 1e6 * (marketRate - depositRate)).toFixed(2);

        const message = `🎯 *SNIPER ALERT - ${currencyCode}*
🏦 *Platform:* ${platformName}
📊 New Deposit #${depositId}: ${formattedAmount} USDC
💰 Deposit Rate: ${depositRate.toFixed(4)} ${currencyCode}/USD
📈 Market Rate: ${marketRate.toFixed(4)} ${currencyCode}/USD
🔥 ${percentageDiff.toFixed(1)}% BETTER than market!

💵 *If you filled this entire order:*
- You'd pay: ${depositCost} ${currencyCode}
- Market cost: ${marketCost} ${currencyCode}
- **You save: ${savings} ${currencyCode}**

*You get ${currencyCode} at ${percentageDiff.toFixed(1)}% discount on ${platformName}!*`.trim();

        // Log sniper alert with error handling
        try {
          await dbManager.logSniperAlert(chatId, depositId, currencyCode, depositRate, marketRate, percentageDiff);
        } catch (error) {
          console.error(`❌ Log error for ${chatId}:`, error.message);
        }

        const sendOptions = {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: `🔗 Snipe Deposit ${depositId}`,
                url: `https://zkp2p.xyz/deposit/${depositId}`
              }
            ]]
          }
        };

        // Send sniper messages to the sniper topic
        if (chatId === EXPLORER_CONFIG.ZKP2P_GROUP_ID) {
          sendOptions.message_thread_id = EXPLORER_CONFIG.ZKP2P_SNIPER_TOPIC_ID;
        }

        if (global.bot) {
          try {
            await global.bot.sendMessage(chatId, message, sendOptions);
          } catch (error) {
            console.error(`❌ Telegram error ${chatId}:`, error.message);
          }
        }
      }
    }
  }
}

module.exports = {
  checkSniperOpportunity
};