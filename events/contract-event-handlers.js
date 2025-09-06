const { ethers } = require('ethers');
const DatabaseManager = require('../scripts/database-manager.js');
const { Utils, isZeroAddress } = require('../utils/web3-utils');
const { Web3State, depositState } = require('../models/web3-state');
const { sendSignaledNotification } = require('../notifications/telegram-notifications');
const { scheduleTransactionProcessing } = require('../transactions/transaction-manager');
const { checkSniperOpportunity } = require('../sniper/sniper-service');
const {
  CONTRACT_ADDRESS,
  iface,
  CONNECTION_CONFIG,
  EXPLORER_CONFIG
} = require('../config/web3-config');
// Import provider and contract from config module
const { escrowContract } = require('../config.js');
// Utility function for retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 1.5;
    }
  }
}
// Module-level storage for intent data (reset on restart)
const storedIntents = new Map();



// Main event handler for contract events
const handleContractEvent = async (log) => {
  try {
    console.log('📡 Received contract event:', log);

    const parsed = iface.parseLog({
      topics: log.topics,
      data: log.data
    });

    if (!parsed) {
      console.error('❌ Could not parse event log:', log);
      return;
    }

    const eventName = parsed.name;
    console.log(`🎯 Processing ${eventName} event`);

    // Handle different event types
    switch (eventName) {
      case 'IntentSignaled':
        await handleIntentSignaled(parsed, log);
        break;

      case 'IntentFulfilled':
        await handleIntentFulfilled(parsed, log);
        break;

      case 'IntentPruned': {
        const { intentHash } = parsed.args;
        await handleIntentPruned(parsed, log);
        break;
      }

      case 'DepositReceived':
        await handleDepositReceived(parsed, log);
        break;

      case 'DepositVerifierAdded':
        await handleDepositVerifierAdded(parsed, log);
        break;

      case 'DepositCurrencyAdded':
        await handleDepositCurrencyAdded(parsed, log);
        break;

      case 'DepositConversionRateUpdated':
        await handleDepositConversionRateUpdated(parsed, log);
        break;

      case 'DepositWithdrawn':
        await handleDepositWithdrawn(parsed, log);
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${eventName}`);
    }

  } catch (error) {
    console.error('❌ Error handling contract event:', error);
    console.error('Error details:', error.stack);
  }
};

async function handleDepositCurrencyAdded(parsed, log) {
  // Handle BigInt values properly from parsed event
  const depositId = BigInt(parsed.args[0]).toString();
  const verifier = parsed.args[1];
  const currency = parsed.args[2];
  const conversionRate = BigInt(parsed.args[3]).toString();

  // Validate parsed event arguments
  if (!verifier || typeof verifier !== 'string') {
    console.error(`❌ Invalid verifier in DepositCurrencyAdded event:`, verifier);
    return;
  }

  console.log(`📊 DepositCurrencyAdded: ID=${depositId}, Currency=${currency}, Verifier=${verifier}, Rate=${conversionRate}`);

  // ✅ RETRIEVE STORED DEPOSIT DATA FROM GLOBAL STATE FIRST
  let web3StateData = Web3State.getDepositStateById(depositId.toString());
  let depositAmount = web3StateData?.depositAmount || null;

  // If no Web3State data, try contract and database fallback
  if (!web3StateData || !depositAmount) {
    let fallbackAmount = null;

    // Try to get deposit amount from database first
    try {
      const dbManager = new DatabaseManager();
      const dbAmount = await dbManager.getDepositAmount(depositId);
      if (dbAmount && dbAmount > 0) {
        fallbackAmount = dbAmount.toString();
        console.log(`📊 Using database amount: ${Utils.convertFromMicrounits(fallbackAmount)} USDC`);
      }
    } catch (dbError) {
      console.error(`❌ Database error:`, dbError.message);
    }

    // Try to get deposit amount from contract using the correct method from search-deposit.js
    try {
      if (escrowContract) {
        // Method 1: Use the bytes32 format for deposits mapping (primary method)
        try {
          const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(depositId)), 32);
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
              // Validate verifier before caching
              const verifierLower = typeof verifier === 'string' ? verifier.toLowerCase() : '0x0000000000000000000000000000000000000000';
              Web3State.setDepositState(depositId.toString(), {
                depositAmount: contractAmount,
                verifierAddress: verifierLower
              });
            } catch (cacheError) {
              console.error(`❌ Caching error:`, cacheError.message);
            }
          }
        } catch (getDepositError) {
          console.warn(`⚠️ getDeposit failed: ${getDepositError.message}`);
        }
      }
    } catch (contractError) {
      console.error(`❌ Contract error:`, contractError.message);
    }

    // If still no amount, use default fallback
    if (!fallbackAmount) {
      fallbackAmount = '1000000'; // Default fallback: 1 USDC
      console.log(`⚠️ Using default fallback: 1.00 USDC`);
    }

    depositAmount = fallbackAmount;
  }

  // Only check sniper opportunities for non-zero currencies
  if (!isZeroAddress(currency)) {
    console.log(`📊 Processing sniper opportunity for deposit ${depositId}`);

    await checkSniperOpportunity(
      depositId,
      depositAmount,    // ✅ REAL deposit amount from Web3State/contract/database
      currency,         // ✅ Currency hash
      conversionRate,   // ✅ Updated conversion rate
      verifier          // ✅ Verifier address
    );
  }
}

async function handleDepositConversionRateUpdated(parsed, log) {
  // Handle BigInt values properly from parsed event
  const depositId = BigInt(parsed.args[0]).toString();
  const verifier = parsed.args[1];
  const currency = parsed.args[2];
  const conversionRate = BigInt(parsed.args[3]).toString();

  // Validate parsed event arguments
  if (!verifier || typeof verifier !== 'string') {
    console.error(`❌ Invalid verifier in DepositConversionRateUpdated event:`, verifier);
    return;
  }

  console.log(`📊 DepositConversionRateUpdated: ID=${depositId}, Rate=${conversionRate}, Currency=${currency}, Verifier=${verifier}`);

  // ✅ RETRIEVE STORED DEPOSIT DATA FROM GLOBAL STATE FIRST
  let web3StateData = Web3State.getDepositStateById(depositId.toString());
  let depositAmount = web3StateData?.depositAmount || null;

  // If no Web3State data, try contract and database fallback
  if (!web3StateData || !depositAmount) {
    let fallbackAmount = null;

    // Try to get deposit amount from database first
    try {
      const dbManager = new DatabaseManager();
      const dbAmount = await dbManager.getDepositAmount(depositId);
      if (dbAmount && dbAmount > 0) {
        fallbackAmount = dbAmount.toString();
        console.log(`📊 Using database amount: ${Utils.convertFromMicrounits(fallbackAmount)} USDC`);
      }
    } catch (dbError) {
      console.error(`❌ Database error:`, dbError.message);
    }

    // Try to get deposit amount from contract using the correct method from search-deposit.js
    try {
      if (escrowContract) {
        // Method 1: Use the bytes32 format for deposits mapping (primary method)
        try {
          const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(depositId)), 32);
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
              // Validate verifier before caching
              const verifierLower = typeof verifier === 'string' ? verifier.toLowerCase() : '0x0000000000000000000000000000000000000000';
              Web3State.setDepositState(depositId.toString(), {
                depositAmount: contractAmount,
                verifierAddress: verifierLower
              });
            } catch (cacheError) {
              console.error(`❌ Caching error:`, cacheError.message);
            }
          }
        } catch (getDepositError) {
          console.warn(`⚠️ getDeposit failed: ${getDepositError.message}`);
        }
      }
    } catch (contractError) {
      console.error(`❌ Contract error:`, contractError.message);
    }

    // If still no amount, use default fallback
    if (!fallbackAmount) {
      fallbackAmount = '1000000'; // Default fallback: 1 USDC
      console.log(`⚠️ Using default fallback: 1.00 USDC`);
    }

    depositAmount = fallbackAmount;
  }

  // Only check sniper opportunities for non-zero currencies
  if (!isZeroAddress(currency)) {
    console.log(`📊 Processing sniper opportunity for deposit ${depositId}`);

    await checkSniperOpportunity(
      depositId,
      depositAmount,    // ✅ REAL deposit amount from Web3State/contract/database
      currency,         // ✅ Currency hash
      conversionRate,   // ✅ Updated conversion rate
      verifier          // ✅ Verifier address
    );
  }
}

async function handleDepositReceived(parsed, log) {
  const { depositId, depositor, verifier, amount } = parsed.args;

  // Validate parsed event arguments
  if (!verifier || typeof verifier !== 'string') {
    console.error(`❌ Invalid verifier in DepositReceived event:`, verifier);
    return;
  }

  console.log(`💰 Deposit received: ${depositId} (${Utils.convertFromMicrounits(amount.toString())} USDC)`);

  // Save deposit data to global state for sniper processing
  Web3State.setDepositState(depositId.toString(), {
    depositAmount: amount.toString(),
    verifierAddress: verifier.toLowerCase()
  });
}

async function handleDepositVerifierAdded(parsed, log) {
  const { depositId, verifier } = parsed.args;

  console.log(`👤 Deposit verifier added: ${depositId} | Verifier: ${verifier}`);

  // Get existing deposit data and update verifier
  const existingData = Web3State.getDepositStateById(depositId.toString());
  if (existingData) {
    existingData.verifierAddress = verifier.toLowerCase();
    console.log(`🔄 Updated verifier for deposit ${depositId}`);
  }
}

async function handleIntentSignaled(parsed, log) {
  const {
    intentHash,
    depositId,
    verifier,
    owner,
    to,
    amount,
    fiatCurrency,
    conversionRate,
    timestamp
  } = parsed.args;

  console.log(`📝 INTENT_SIGNALED EVENT RECEIVED:`);
  console.log(`   - Intent Hash: ${intentHash}`);
  console.log(`   - Deposit ID: ${depositId}`);
  console.log(`   - Verifier: ${verifier}`);
  console.log(`   - Owner: ${owner}`);
  console.log(`   - To: ${to}`);
  console.log(`   - Amount: ${amount}`);
  console.log(`   - Fiat Currency: ${fiatCurrency}`);
  console.log(`   - Conversion Rate: ${conversionRate}`);
  console.log(`   - Timestamp: ${timestamp}`);

  // Store intent data for later processing
  const rawIntent = {
    eventType: 'IntentSignaled',
    intentHash: intentHash.toLowerCase(),
    depositId: Number(depositId),
    verifier: verifier.toLowerCase(),
    owner: owner.toLowerCase(),
    to: to.toLowerCase(),
    amount: amount.toString(),
    fiatCurrency: fiatCurrency.toLowerCase(),
    conversionRate: conversionRate.toString(),
    timestamp: Number(timestamp)
  };

  // Get transaction hash
  const txHash = log.transactionHash.toLowerCase();
  console.log(`📝 Processing in transaction ${txHash}`);

  // Add to pending transactions for processing
  Web3State.addTransactionIntent(txHash, intentHash, rawIntent);
  scheduleTransactionProcessing(txHash);

  console.log(`✅ IntentSignaled collected for batching`);
  console.log(`   - Transaction has ${Web3State.getAllIntentsForTransaction(txHash).size} intents`);

  // Send immediate notification for signaled intent
  const notificationTxHash = log.transactionHash;
  await sendSignaledNotification(rawIntent, notificationTxHash);
  // Store intent data for potential pruned events
  storedIntents.set(intentHash.toLowerCase(), rawIntent);
}

async function handleIntentFulfilled(parsed, log) {
  const { intentHash, depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee } = parsed.args;

  console.log(`✅ Intent fulfilled: ${intentHash} for deposit ${depositId}`);

  // Construct notification data from parsed event (not from contract fetch)
  const intentForNotification = {
    intentHash: intentHash.toLowerCase(),
    depositId: Number(depositId),
    paymentVerifier: verifier.toLowerCase(),
    owner: owner.toLowerCase(),
    to: to.toLowerCase(),
    amount: amount.toString(),
    fiatCurrency: '0x0000000000000000000000000000000000000000000000000000000000000000', // Default USD
    conversionRate: '1000000000000000000', // 1:1 for now
    sustainabilityFee: sustainabilityFee.toString(),
    verifierFee: verifierFee.toString(),
    timestamp: Math.floor(Date.now() / 1000)
  };


  try {
    // Fetch complete intent data from contract to get conversionRate and fiatCurrency
    const escrowContract = new ethers.Contract(CONTRACT_ADDRESS, require('../config/web3-config').contractABI, global.provider || require('./scripts/web3-service.js'));
    const intentData = await escrowContract.getIntent(intentHash);

    // Store intent data for processing
    const rawIntent = {
      eventType: 'IntentFulfilled',
      intentHash: intentHash.toLowerCase(),
      depositId: Number(depositId),
      verifier: verifier.toLowerCase(),
      owner: owner.toLowerCase(),
      to: to.toLowerCase(),
      amount: amount.toString(),
      conversionRate: intentData.intent.conversionRate.toString(), // Get from contract
      fiatCurrency: intentData.intent.fiatCurrency, // Get from contract
      sustainabilityFee: sustainabilityFee.toString(),
      verifierFee: verifierFee.toString()
    };

    // Get transaction hash
    const txHash = log.transactionHash.toLowerCase();

    // Add to pending transactions for processing
    Web3State.setTransactionState(txHash, {
      txHash,
      fulfilled: new Set([intentHash.toLowerCase()]),
      pruned: new Set(),
      rawIntents: new Map([[intentHash.toLowerCase(), rawIntent]]),
      processed: false
    });

    // Schedule processing
    scheduleTransactionProcessing(txHash);
  } catch (error) {
    console.error(`❌ Error fetching intent data for ${intentHash}:`, error);
    // Fallback to original behavior if contract call fails
    const rawIntent = {
      eventType: 'IntentFulfilled',
      intentHash: intentHash.toLowerCase(),
      depositId: Number(depositId),
      verifier: verifier.toLowerCase(),
      owner: owner.toLowerCase(),
      to: to.toLowerCase(),
      amount: amount.toString(),
      conversionRate: '0', // Fallback value
      fiatCurrency: '0x0000000000000000000000000000000000000000000000000000000000000000', // Fallback value
      sustainabilityFee: sustainabilityFee.toString(),
      verifierFee: verifierFee.toString()
    };

    const txHash = log.transactionHash.toLowerCase();

    Web3State.setTransactionState(txHash, {
      txHash,
      fulfilled: new Set([intentHash.toLowerCase()]),
      pruned: new Set(),
      rawIntents: new Map([[intentHash.toLowerCase(), rawIntent]]),
      processed: false
    });

    scheduleTransactionProcessing(txHash);

    console.log(`📝 IntentFulfilled collected for batching (fallback mode) - depositId: ${depositId}`);
  }
}

async function handleIntentPruned(parsed, log) {
  const { intentHash, depositId } = parsed.args;

  console.log(`🚨 INTENT_PRUNED EVENT RECEIVED:`);
  console.log(`   - Deposit ID: ${depositId}`);
  console.log(`   - Intent Hash: ${intentHash}`);
  console.log(`   - Transaction Hash: ${log.transactionHash}`);

  const txHash = log.transactionHash.toLowerCase();
  const notificationTxHash = log.transactionHash;
  const intentHashLower = intentHash.toLowerCase();

  // ✅ DELAY PRUNED NOTIFICATION TO ALLOW FULFILLED TO BE PROCESSED FIRST
  const eventKey = `${txHash}-${intentHashLower}`;

  const notificationData = {
    intentHash: intentHashLower,
    txHash: notificationTxHash,
    intentData: null // Will be populated from stored intent data
  };

  // Try to get stored intent data from previous signaled event (module-level Map first, then Web3State)
  let storedRawIntent = null;
  storedRawIntent = storedIntents.get(intentHashLower);
  if (!storedRawIntent) {
    for (const [hash, txData] of Web3State.getPendingTransactions()) {
      if (txData.rawIntents.has(intentHashLower)) {
        storedRawIntent = txData.rawIntents.get(intentHashLower);
        break;
      }
    }
  }

  // Use the stored intent data for notification
  if (storedRawIntent) {
    notificationData.intentData = {
      eventType: 'IntentPruned',
      intentHash: intentHashLower,
      depositId: storedRawIntent.depositId,
      paymentVerifier: storedRawIntent.verifier,
      owner: storedRawIntent.owner,
      to: storedRawIntent.to,
      amount: storedRawIntent.amount,
      fiatCurrency: storedRawIntent.editorial,
      conversionRate: storedRawIntent.conversionRate,
      timestamp: Math.floor(Date.now() / 1000)
    };
  } else {
    // Fallback notification data if no stored intent
    notificationData.intentData = {
      eventType: 'IntentPruned',
      intentHash: intentHashLower,
      depositId: Number(depositId),
      paymentVerifier: 'unknown',
      owner: 'unknown',
      to: 'unknown',
      amount: '0',
      fiatCurrency: '0x0000000000000000000000000000000000000000000000000000000000000000',
      conversionRate: '0',
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  try {
    // Import globally available escrowContract - should be set up by main application

    // Fetch the full intent data from the contract since IntentPruned event only has intentHash and depositId
    const intentData = await retryWithBackoff(() => escrowContract.getIntent(intentHash), 5, 1000);

    console.log(`📊 Retrieved intent data for pruned intent ${intentHash}:`, {
      owner: intentData.intent.owner,
      to: intentData.intent.to,
      amount: intentData.intent.amount.toString(),
      paymentVerifier: intentData.intent.paymentVerifier,
      fiatCurrency: intentData.intent.fiatCurrency,
      conversionRate: intentData.intent.conversionRate.toString()
    });

    // Use stored data if contract returns zeros
    const useData = intentData.intent.amount !== 0 ? intentData.intent : (storedRawIntent ? {
      owner: storedRawIntent.owner,
      to: storedRawIntent.to,
      amount: storedRawIntent.amount,
      paymentVerifier: storedRawIntent.verifier,
      fiatCurrency: storedRawIntent.fiatCurrency,
      conversionRate: storedRawIntent.conversionRate
    } : intentData.intent);

    let rawIntent = {
      eventType: 'IntentPruned',
      intentHash: intentHash.toLowerCase(),
      depositId: Number(depositId),
      owner: useData.owner,
      to: useData.to,
      amount: useData.amount.toString(),
      verifier: useData.paymentVerifier,
      fiatCurrency: useData.fiatCurrency,
      conversionRate: useData.conversionRate.toString()
    };

    // Get existing transaction state or create new
    let txData = Web3State.getTransactionState(txHash);
    if (!txData) {
      txData = {
        txHash,
        fulfilled: new Set(),
        pruned: new Set(),
        rawIntents: new Map(),
        processed: false
      };
      Web3State.setTransactionState(txHash, txData);
    }

    console.log(`🔧 Before adding pruned intent: txData has ${txData.pruned.size} pruned, ${txData.fulfilled.size} fulfilled`);
    Web3State.markIntentPruned(txHash, intentHash);
    Web3State.addTransactionIntent(txHash, intentHash, rawIntent);
    console.log(`✅ After adding pruned intent: txData has ${Web3State.getPrunedIntents(txHash).size} pruned, ${Web3State.getFulfilledIntents(txHash).size} fulfilled`);

    // Schedule processing
    scheduleTransactionProcessing(txHash);

  } catch (error) {
    console.error(`❌ Error fetching intent data for pruned intent ${intentHash}:`, error);
    // Fallback: create raw intent with minimal data
    const rawIntent = {
      eventType: 'IntentPruned',
      intentHash: intentHash.toLowerCase(),
      depositId: Number(depositId)
    };

    Web3State.addTransactionIntent(txHash, intentHash, rawIntent);
    Web3State.markIntentPruned(txHash, intentHash);

    // Schedule processing with minimal data
    scheduleTransactionProcessing(txHash);
  }
}

async function handleDepositWithdrawn(parsed, log) {
  try {
    const { depositId, depositor, amount } = parsed.args;

    console.log(`💸 Deposit withdrawn: ${depositId} by ${depositor}`);

    const dbManager = new DatabaseManager();

    // Get users listening to this deposit
    const interestedUsers = await dbManager.getUsersInterestedInDeposit(depositId);

    if (interestedUsers.length > 0) {
      const formattedAmount = Utils.convertFromMicrounits(amount).toFixed(2);
      const shortAddress = `${depositor.slice(0, 6)}...${depositor.slice(-4)}`;

      const message = `💸 *Deposit Withdrawn*

🎯 **Deposit ID:** ${depositId}
👤 **Depositor:** ${shortAddress}
💰 **Amount:** ${formattedAmount} USDC

*Deposit has been withdrawn from ZKP2P*`;

      const sendOptions = Utils.createSendOptions('Markdown', true);

      for (const chatId of interestedUsers) {
        try {
          await global.bot.sendMessage(chatId, message, sendOptions);
          console.log(`✅ Sent withdrawal notification to user ${chatId}`);
        } catch (error) {
          console.error(`❌ Failed to send withdrawal notification to ${chatId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error handling DepositWithdrawn event:', error);
  }
}

module.exports = {
  handleContractEvent,
  handleDepositCurrencyAdded,
  handleDepositConversionRateUpdated,
  handleDepositReceived,
  handleDepositVerifierAdded,
  handleIntentSignaled,
  handleIntentFulfilled,
  handleIntentPruned,
  handleDepositWithdrawn
};