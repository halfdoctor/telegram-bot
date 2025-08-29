const DatabaseManager = require('../scripts/database-manager');
const { Utils } = require('../utils/web3-utils');
const { EXPLORER_CONFIG, formatConversionRate } = require('../config/web3-config');

// Notification functions to send messages to Telegram

async function sendFulfilledNotification(rawIntent, txHash) {
  try {
    console.log(`✅ Processing fulfilled intent: ${rawIntent.intentHash}`);

    const dbManager = new DatabaseManager();
    const interestedUsers = await dbManager.getUsersInterestedInDeposit(rawIntent.depositId);

    if (interestedUsers.length === 0) {
      console.log(`📭 No users interested in deposit ${rawIntent.depositId}`);
      return;
    }

    const platformName = Utils.resolvePlatformName(rawIntent.paymentVerifier, rawIntent.owner, rawIntent.to);
    const { currencyCode, currencyName } = Utils.getCurrencyInfo(rawIntent.fiatCurrency);
    const usdcAmount = Utils.convertFromMicrounits(rawIntent.amount);
    const conversionRate = Utils.convertFromWei(rawIntent.conversionRate);
    const fiatAmount = Utils.calculateFiatAmount(usdcAmount, conversionRate);
    const timeString = Utils.formatTimestamp(rawIntent.timestamp);

    // Format message for fulfilled intents
    const message = `✅ *Intent Fulfilled!*

💰 **Amount:** ${Utils.formatFiatAmount(fiatAmount, currencyName)}
💵 **USDC:** ${usdcAmount.toFixed(2)} USDC
🏦 **Platform:** ${platformName}
🔢 **Deposit ID:** ${rawIntent.depositId}
⏰ **Time:** ${timeString}
🔗 **Transaction:** ${Utils.formatTxHash(txHash)}

*Funds are now available for withdrawal!*`;

    // Send to interested users
    for (const chatId of interestedUsers) {
      try {
        await global.bot.sendMessage(chatId, message, Utils.createSendOptions('Markdown'));
        console.log(`✅ Sent fulfilled notification to ${chatId}`);
      } catch (error) {
        console.error(`❌ Failed to send fulfilled notification to ${chatId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error sending fulfilled notification:', error);
  }
}

async function sendPrunedNotification(rawIntent, txHash) {
  try {
    console.log(`🟠 Processing pruned intent: ${rawIntent.intentHash}`);

    const dbManager = new DatabaseManager();
    const interestedUsers = await dbManager.getUsersInterestedInDeposit(rawIntent.depositId);

    if (interestedUsers.length === 0) {
      console.log(`📭 No users interested in deposit ${rawIntent.depositId}`);
      return;
    }

    const platformName = Utils.resolvePlatformName(rawIntent.paymentVerifier, rawIntent.owner, rawIntent.to);
    const { currencyCode, currencyName } = Utils.getCurrencyInfo(rawIntent.fiatCurrency);

    // Format message for pruned intents
    const message = `🟠 *Intent Pruned*

❌ **Intent has been cancelled**
💵 **Platform:** ${platformName}
🔢 **Deposit ID:** ${rawIntent.depositId}
🔗 **Transaction:** ${Utils.formatTxHash(txHash)}

*The intent was pruned and no longer active.*`;

    // Send to interested users
    for (const chatId of interestedUsers) {
      try {
        await global.bot.sendMessage(chatId, message, Utils.createSendOptions('Markdown'));
        console.log(`✅ Sent pruned notification to ${chatId}`);
      } catch (error) {
        console.error(`❌ Failed to send pruned notification to ${chatId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error sending pruned notification:', error);
  }
}

async function sendSignaledNotification(rawIntent, txHash) {
  const platformName = Utils.resolvePlatformName(rawIntent.verifier, rawIntent.owner, rawIntent.to);
  console.log(`🔍 Platform mapping debug:`, {
    verifier: rawIntent.verifier,
    owner: rawIntent.owner,
    to: rawIntent.to,
    resolvedPlatform: platformName,
    mappingWorks: platformName !== 'Unknown Platform'
  });

  return await sendNotification(rawIntent, txHash, 'signaled', {
    title: '🆕 *Intent Signaled!*',
    footer: '*New intent signaled on ZKP2P - waiting for fulfillment!*',
    includeTimestamp: true,
    includeOwner: true
  });
}

// Base notification function to reduce duplication
async function sendNotification(rawIntent, txHash, status, options) {
  try {
    const dbManager = new DatabaseManager();

    // Get all users who are listening to this deposit or all deposits
    const interestedUsers = await dbManager.getUsersInterestedInDeposit(rawIntent.depositId);

    if (interestedUsers.length === 0) {
      console.log(`📭 No users interested in deposit ${rawIntent.depositId}`);
      return;
    }

    // Use utility functions for common operations
    const platformName = Utils.resolvePlatformName(rawIntent.verifier, rawIntent.owner, rawIntent.to);
    const { currencyCode, currencyName } = Utils.getCurrencyInfo(rawIntent.fiatCurrency);

    // Calculate amounts using utilities
    const usdcAmount = Utils.convertFromMicrounits(rawIntent.amount);
    const conversionRate = Utils.convertFromWei(rawIntent.conversionRate);
    const fiatAmount = Utils.calculateFiatAmount(usdcAmount, conversionRate);

    // Build message parts
    let message = `${options.title}

🎯 **Deposit ID:** ${rawIntent.depositId}
💰 **Amount:** ${usdcAmount.toFixed(2)} USDC
**Fiat Amount:** ${Utils.formatFiatAmount(fiatAmount.toLocaleString(), currencyName)} (${formatConversionRate(conversionRate.toString(), currencyCode)} ${currencyName} / USDC)
🏦 **Platform:** ${platformName}`;

    // Add owner field for signaled notifications
    if (options.includeOwner && rawIntent.owner) {
      message += `\n👤 **Owner:** ${rawIntent.owner}`;
    }

    message += `\n👤 **Recipient:** ${rawIntent.to}
🔗 **Transaction:** ${Utils.formatTxHash(txHash)}`;

    // Add timestamp for signaled notifications
    if (options.includeTimestamp && rawIntent.timestamp) {
      message += `\n🕒 **Time:** ${Utils.formatTimestamp(rawIntent.timestamp)}`;
    }

    message += `\n\n${options.footer}`;

    const sendOptions = Utils.createSendOptions();

    // Send to all interested users
    for (const chatId of interestedUsers) {
      try {
        // Update user state for this deposit
        await dbManager.updateDepositStatus(chatId, rawIntent.depositId, status);

        // Send the notification
        if (global.bot) {
          await global.bot.sendMessage(chatId, message, sendOptions);
          console.log(`✅ Sent ${status} notification to user ${chatId}`);
        } else {
          console.log(`⚠️ Bot not available, skipping notification to ${chatId}`);
        }
      } catch (error) {
        console.error(`❌ Failed to send ${status} notification to ${chatId}:`, error);
      }
    }

  } catch (error) {
    console.error(`❌ Error sending ${status} notification:`, error);
  }
}

module.exports = {
  sendFulfilledNotification,
  sendPrunedNotification,
  sendSignaledNotification,
  sendNotification
};