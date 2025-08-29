const DatabaseManager = require('./database-manager');
const { searchDeposit } = require('./search-deposit');
const { getCurrencyRate } = require('./exchange-service');

const db = new DatabaseManager();

async function monitorDeposits(bot) {
    console.log('Starting deposit monitoring...');

    const users = await db.getAllUsersWithActiveDeposits();
    console.log(`Found ${users.length} users with active deposits.`);

    for (const chatId of users) {
        console.log(`Processing deposits for user: ${chatId}`);
        const userDepositIds = await db.getUserDeposits(chatId); // This returns a Set of deposit_ids
        
        if (userDepositIds.size === 0) {
            console.log(`No active deposits found for user ${chatId}.`);
            continue;
        }

        for (const depositId of userDepositIds) {
            try {
                const depositDetails = await searchDeposit(depositId);
                console.log(`Fetched details for deposit ${depositId}.`);

                if (depositDetails && depositDetails.verificationData && depositDetails.verificationData.length > 0) {
                    for (const verification of depositDetails.verificationData) {
                        for (const currency of verification.currencies) {
                            const depositExchangeRate = parseFloat(currency.conversionRate);
                            const currencyCode = currency.code;

                            if (isNaN(depositExchangeRate) || !currencyCode) {
                                console.warn(`Skipping invalid currency data for deposit ${depositId}:`, currency);
                                continue;
                            }

                            const marketRate = await getCurrencyRate('USD', currencyCode);

                            if (marketRate === null) {
                                console.warn(`Could not fetch market rate for ${currencyCode}. Skipping comparison for deposit ${depositId}.`);
                                continue;
                            }

                            const THRESHOLD_PERCENTAGE = 0.25; // Notify if deposit rate is 0.25% lower than market
                            const lowerBound = marketRate * (1 - THRESHOLD_PERCENTAGE / 100);

                            if (depositExchangeRate < lowerBound) {
                                const percentageDiff = ((marketRate - depositExchangeRate) / marketRate) * 100;
                                const message = `🚨 *Deposit Alert!* 🚨\n\n` +
                                                `Your tracked deposit #${depositId} has an exchange rate significantly lower than the market!\n` +
                                                `\n` +
                                                `*Currency:* ${currencyCode}\n` +
                                                `*Your Rate:* ${depositExchangeRate.toFixed(4)}\n` +
                                                `*Market Rate:* ${marketRate.toFixed(4)}\n` +
                                                `*Difference:* -${percentageDiff.toFixed(2)}%\n\n` +
                                                `Consider checking the deposit and adjusting for better rates.`;
                                
                                console.log(`Sending alert to user ${chatId} for deposit ${depositId}.`);
                                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                                // Log the alert for analytics
                                await db.logSniperAlert(chatId, depositId, currencyCode, depositExchangeRate, marketRate, percentageDiff);
                            } else {
                                console.log(`Deposit ${depositId} (${currencyCode}) rate ${depositExchangeRate.toFixed(4)} is within market range (Market: ${marketRate.toFixed(4)}) for user ${chatId}.`);
                            }
                        }
                    }
                } else {
                    console.log(`No intents found for deposit ${depositId} or deposit not found.`);
                }
            } catch (error) {
                console.error(`Error processing deposit ${depositId} for user ${chatId}:`, error);
            }
        }
    }

    console.log('Deposit monitoring finished.');
}

// Schedule the monitoring to run every 4 hours (4 * 60 * 60 * 1000 milliseconds)
const MONITOR_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
// const MONITOR_INTERVAL = 30 * 1000; // For testing: every 10 seconds

let monitorIntervalId;

function startDepositMonitor(bot) {
    // Run immediately on start
    monitorDeposits(bot);
    // Then run periodically
    monitorIntervalId = setInterval(() => monitorDeposits(bot), MONITOR_INTERVAL);
    console.log(`Deposit monitor started, checking every ${MONITOR_INTERVAL / (1000 * 60 * 60)} hours.`);
}

function stopDepositMonitor() {
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        console.log('Deposit monitor stopped.');
    }
}

module.exports = {
    startDepositMonitor,
    stopDepositMonitor,
    monitorDeposits // Export for manual triggering if needed
};