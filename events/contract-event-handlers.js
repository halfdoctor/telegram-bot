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
const { escrowContract, protocolViewerContract, ORCHESTRATOR_ABI } = require('../config.js');

// Direct ABI loading to ensure we have the correct one
const fs = require('fs');
const path = require('path');

// Try to load the corrected ABI first, then fall back to the original
let ORCHESTRATOR_ABI_FALLBACK;
try {
  ORCHESTRATOR_ABI_FALLBACK = JSON.parse(fs.readFileSync(path.join(__dirname, '../deployments/Orchestrator-corrected.json'), 'utf8')).abi;
  console.log('✅ Using corrected Orchestrator ABI');
} catch (error) {
  console.log('⚠️ Corrected ABI not found, using original ABI');
  ORCHESTRATOR_ABI_FALLBACK = JSON.parse(fs.readFileSync(path.join(__dirname, '../deployments/Orchestrator.json'), 'utf8')).abi;
}

const ORCHESTRATOR_ABI_FINAL = ORCHESTRATOR_ABI || ORCHESTRATOR_ABI_FALLBACK;

// Main event handler for contract events
const handleContractEvent = async (log) => {
  try {
    console.log('📡 Received contract event:', log);

    // Determine which contract interface to use based on contract address
    const contractAddress = log.address.toLowerCase();
    let contractIface;
    let isEscrowContract = false;
    let isOrchestratorContract = false;

    console.log(`🔍 Contract address: ${contractAddress} (original: ${log.address})`);

    // Known contract addresses (normalize to lowercase for comparison)
    const ESCROW_ADDRESS = '0x2f121cddca6d652f35e8b3e560f9760898888888';
    const ORCHESTRATOR_ADDRESS = '0x88888883ed048ff0a415271b28b2f52d431810d0';

    // Check if this is the escrow contract (case-insensitive comparison)
    if (contractAddress === ESCROW_ADDRESS) {
      contractIface = iface;
      isEscrowContract = true;
      console.log('🏦 Processing escrow contract event');
    } else if (contractAddress === ORCHESTRATOR_ADDRESS) {
      // Orchestrator contract address (case-insensitive)
      contractIface = new ethers.Interface(ORCHESTRATOR_ABI_FINAL);
      isOrchestratorContract = true;
      console.log('🏗️ Processing orchestrator contract event');
    } else {
      console.log(`🏗️ Processing unknown contract event at ${contractAddress}`);
      // Try to parse with orchestrator interface first since we have more orchestrator events
      try {
        const orchestratorParsed = new ethers.Interface(ORCHESTRATOR_ABI_FINAL).parseLog({
          topics: log.topics,
          data: log.data
        });
        if (orchestratorParsed) {
          contractIface = new ethers.Interface(ORCHESTRATOR_ABI_FINAL);
          isOrchestratorContract = true;
          console.log('✅ Parsed with orchestrator interface');
        }
      } catch (e) {
        try {
          const escrowParsed = iface.parseLog({
            topics: log.topics,
            data: log.data
          });
          if (escrowParsed) {
            contractIface = iface;
            isEscrowContract = true;
            console.log('✅ Parsed with escrow interface');
          }
        } catch (e2) {
          console.error('❌ Could not parse event with any interface:', log);
          console.error('Attempted interfaces: Orchestrator, Escrow');
          console.error('Error details:', e2.message);
          return;
        }
      }
    }

    if (!contractIface) {
      console.error('❌ No contract interface found for address:', log.address);
      return;
    }

    let parsed;
    try {
      parsed = contractIface.parseLog({
        topics: log.topics,
        data: log.data
      });
      console.log(`✅ Successfully parsed event: ${parsed.name}`);
    } catch (parseError) {
      console.error('❌ Failed to parse event:', parseError.message, 'Interface:', contractIface ? 'exists' : 'missing');
      console.error('Full log data:', JSON.stringify({
        address: log.address,
        topics: log.topics,
        data: log.data
      }, null, 2));
      return;
    }

    // Moved eventName extraction here to fix the ReferenceError
    if (!parsed) {
      console.error('❌ Could not parse event log:', log);
      return;
    }

    const eventName = parsed.name;
    if (!eventName) {
      console.error('❌ Event name is undefined in parsed log:', parsed, log);
      return;
    }

    console.log(`🎯 Processing ${eventName} event`);

    // Route events to appropriate handlers based on contract type
    if (isOrchestratorContract) {
      // Route to orchestrator handlers
      switch (eventName) {
        case 'IntentSignaled':
          await handleOrchestratorIntentSignaled(parsed, log);
          break;

        case 'IntentFulfilled':
          await handleOrchestratorIntentFulfilled(parsed, log);
          break;

        case 'IntentPruned':
          await handleOrchestratorIntentPruned(parsed, log);
          break;

        default:
          console.log(`ℹ️ Unhandled orchestrator event type: ${eventName}`);
      }
      return; // Exit after handling orchestrator events
    }

    // Handle escrow contract events
    switch (eventName) {
      case 'IntentSignaled':
        await handleIntentSignaled(parsed, log);
        break;

      case 'IntentFulfilled':
        await handleIntentFulfilled(parsed, log);
        break;

      case 'IntentPruned':
        await handleIntentPruned(parsed, log);
        break;

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

      case 'FundsLocked':
        await handleFundsLocked(parsed, log);
        break;

      case 'FundsUnlockedAndTransferred':
        await handleFundsUnlockedAndTransferred(parsed, log);
        break;

      case 'DepositMinConversionRateUpdated':
        await handleDepositMinConversionRateUpdated(parsed, log);
        break;

      case 'DepositFundsAdded':
        await handleDepositFundsAdded(parsed, log);
        break;

      case 'DepositDelegateSet':
        await handleDepositDelegateSet(parsed, log);
        break;

      case 'DepositDelegateRemoved':
        await handleDepositDelegateRemoved(parsed, log);
        break;

      case 'DepositIntentAmountRangeUpdated':
        await handleDepositIntentAmountRangeUpdated(parsed, log);
        break;

      case 'DepositPaymentMethodActiveUpdated':
        await handleDepositPaymentMethodActiveUpdated(parsed, log);
        break;

      case 'DepositAcceptingIntentsUpdated':
        await handleDepositAcceptingIntentsUpdated(parsed, log);
        break;

      case 'DepositRetainOnEmptyUpdated':
        await handleDepositRetainOnEmptyUpdated(parsed, log);
        break;

      case 'FundsUnlocked':
        await handleFundsUnlocked(parsed, log);
        break;

      case 'IntentExpiryExtended':
        await handleIntentExpiryExtended(parsed, log);
        break;

      case 'DustCollected':
        await handleDustCollected(parsed, log);
        break;

      case 'DepositClosed':
        await handleDepositClosed(parsed, log);
        break;

      case 'DepositPaymentMethodAdded':
        await handleDepositPaymentMethodAdded(parsed, log);
        break;

      case 'OrchestratorUpdated':
        await handleOrchestratorUpdated(parsed, log);
        break;

      case 'PaymentVerifierRegistryUpdated':
        await handlePaymentVerifierRegistryUpdated(parsed, log);
        break;

      case 'DustRecipientUpdated':
        await handleDustRecipientUpdated(parsed, log);
        break;

      case 'DustThresholdUpdated':
        await handleDustThresholdUpdated(parsed, log);
        break;

      case 'MaxIntentsPerDepositUpdated':
        await handleMaxIntentsPerDepositUpdated(parsed, log);
        break;

      case 'IntentExpirationPeriodUpdated':
        await handleIntentExpirationPeriodUpdated(parsed, log);
        break;

      // Orchestrator-specific events
      case 'AllowMultipleIntentsUpdated':
        await handleAllowMultipleIntentsUpdated(parsed, log);
        break;

      case 'PostIntentHookRegistryUpdated':
        await handlePostIntentHookRegistryUpdated(parsed, log);
        break;

      case 'RelayerRegistryUpdated':
        await handleRelayerRegistryUpdated(parsed, log);
        break;

      case 'EscrowRegistryUpdated':
        await handleEscrowRegistryUpdated(parsed, log);
        break;

      case 'ProtocolFeeUpdated':
        await handleProtocolFeeUpdated(parsed, log);
        break;

      case 'ProtocolFeeRecipientUpdated':
        await handleProtocolFeeRecipientUpdated(parsed, log);
        break;

      case 'MinDepositAmountSet':
        await handleMinDepositAmountSet(parsed, log);
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
          // const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(depositId)), 32);
          // const deposit = await escrowContract.deposits(depositIdBytes32);
          const deposit = await protocolViewerContract.getDeposit(depositId);
          if (deposit && deposit.depositor && deposit.depositor !== ethers.ZeroAddress) {
            // Found deposit in mapping, now get detailed data
          }
        } catch (depositsError) {
          console.warn(`⚠️ Mapping check failed: ${depositsError.message}`);
        }

        // Method 2: Use getDeposit method for full data (secondary method) - EXACTLY like search-deposit.js
        try {
          const depositData = await protocolViewerContract.getDeposit(depositId);

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
          // const depositIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(depositId)), 32);
          // const deposit = await escrowContract.deposits(depositIdBytes32);
          const deposit = await protocolViewerContract.getDeposit(depositId);
          if (deposit && deposit.depositor && deposit.depositor !== ethers.ZeroAddress) {
            // Found deposit in mapping, now get detailed data
          }
        } catch (depositsError) {
          console.warn(`⚠️ Mapping check failed: ${depositsError.message}`);
        }

        // Method 2: Use getDeposit method for full data (secondary method) - EXACTLY like search-deposit.js
        try {
          const depositData = await protocolViewerContract.getDeposit(depositId);

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
  const { depositId, depositor, token, amount, intentAmountRange, delegate, intentGuardian } = parsed.args;

  // Validate parsed event arguments
  if (!depositor || typeof depositor !== 'string') {
    console.error(`❌ Invalid depositor in DepositReceived event:`, depositor);
    return;
  }

  console.log(`💰 Deposit received: ${depositId} (${Utils.convertFromMicrounits(amount.toString())} ${token})`);

  // Save deposit data to global state for sniper processing
  Web3State.setDepositState(depositId.toString(), {
    depositAmount: amount.toString(),
    depositorAddress: depositor.toLowerCase(),
    tokenAddress: token.toLowerCase(),
    intentAmountRange: intentAmountRange.toString(),
    delegateAddress: delegate.toLowerCase(),
    intentGuardianAddress: intentGuardian.toLowerCase(),
    verifierAddress: delegate.toLowerCase() // For platform name mapping in sniper service
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

  // Store intent data in database for persistence
  const dbManager = new DatabaseManager();
  await dbManager.storeIntentData(rawIntent);

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

  // Send immediate notification using event data
  const notificationTxHash = log.transactionHash.toLowerCase();
  const txHash = log.transactionHash.toLowerCase();

  // Check if there's already a pruned event for this intent in the same transaction
  const existingTxData = Web3State.getTransactionState(txHash);
  const hasPrunedEvent = existingTxData?.pruned?.has(intentHash.toLowerCase());

  // Also check if there's a pending pruned event for this intent in the current transaction
  const allIntentsInTx = Web3State.getAllIntentsForTransaction(txHash);
  const hasPendingPrunedEvent = Array.from(allIntentsInTx.values()).some(
    intent => intent.intentHash.toLowerCase() === intentHash.toLowerCase() &&
    intent.eventType === 'IntentPruned'
  );

  if (!hasPrunedEvent && !hasPendingPrunedEvent) {
    const { sendFulfilledNotification } = require('../notifications/telegram-notifications');
    await sendFulfilledNotification(intentForNotification, notificationTxHash);
    console.log(`✅ Sent immediate fulfilled notification for ${intentHash}`);
  } else {
    console.log(`⚠️ Skipping immediate fulfilled notification for ${intentHash} - pruned event already exists in transaction ${txHash}`);
  }

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
// Handle Orchestrator v2/v3 events (same structure as escrow events but different contract)
const handleOrchestratorEvent = async (log) => {
  try {
    console.log('📡 Received orchestrator event:', log);

    const parsed = iface.parseLog({
      topics: log.topics,
      data: log.data
    });

    if (!parsed) {
      console.error('❌ Could not parse orchestrator event log:', log);
      return;
    }

    const eventName = parsed.name;
    console.log(`🎯 Processing orchestrator ${eventName} event`);

    // Handle different event types - same as escrow but for orchestrator contract
    switch (eventName) {
      case 'IntentSignaled':
        await handleIntentSignaled(parsed, log);
        break;

      case 'IntentFulfilled':
        await handleIntentFulfilled(parsed, log);
        break;

      case 'IntentPruned':
        await handleIntentPruned(parsed, log);
        break;

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
        console.log(`ℹ️ Unhandled orchestrator event type: ${eventName}`);
    }
    switch (eventName) {
      case 'IntentSignaled':
        await handleIntentSignaled(parsed, log);
        break;

      case 'IntentFulfilled':
        await handleIntentFulfilled(parsed, log);
        break;

      case 'IntentPruned':
        await handleIntentPruned(parsed, log);
        break;

      default:
        console.log(`ℹ️ Unhandled orchestrator event type: ${eventName}`);
    }

  } catch (error) {
    console.error('❌ Error handling orchestrator event:', error);
    console.error('Error details:', error.stack);
  }
};

async function handleIntentPruned(parsed, log) {
  const { intentHash, depositId } = parsed.args;

  console.log(`🚨 INTENT_PRUNED EVENT RECEIVED:`);
  console.log(`   - Deposit ID: ${depositId}`);
  console.log(`   - Intent Hash: ${intentHash}`);
  console.log(`   - Transaction Hash: ${log.transactionHash}`);

  const txHash = log.transactionHash.toLowerCase();

  let rawIntent;

  try {
    // First, try to get intent data from database (persistent storage)
    const dbManager = new DatabaseManager();
    const dbIntentData = await dbManager.getIntentData(intentHash);

    if (dbIntentData && dbIntentData.amount && dbIntentData.amount !== '0') {
      console.log(`📊 Retrieved intent data from database for pruned intent ${intentHash}`);
      rawIntent = {
        eventType: 'IntentPruned',
        intentHash: intentHash.toLowerCase(),
        depositId: Number(depositId),
        owner: dbIntentData.owner,
        to: dbIntentData.to,
        amount: dbIntentData.amount,
        verifier: dbIntentData.verifier,
        fiatCurrency: dbIntentData.fiat_currency,
        conversionRate: dbIntentData.conversion_rate,
        timestamp: dbIntentData.timestamp
      };

      // Send immediate notification for pruned intent if no fulfilled event exists in same transaction
      const notificationTxHash = log.transactionHash;

      // Check if there's a fulfilled event for this intent in the same transaction
      const existingTxData = Web3State.getTransactionState(txHash);
      const hasFulfilledEvent = existingTxData?.fulfilled?.has(intentHash.toLowerCase());

      // Also check if there's a pending fulfilled event for this intent in the current transaction
      const allIntentsInTx = Web3State.getAllIntentsForTransaction(txHash);
      const hasPendingFulfilledEvent = Array.from(allIntentsInTx.values()).some(
        intent => intent.intentHash.toLowerCase() === intentHash.toLowerCase() &&
        intent.eventType === 'IntentFulfilled'
      );

      if (!hasFulfilledEvent && !hasPendingFulfilledEvent) {
        console.log(`🚨 Sending immediate pruned notification for ${intentHash}`);
        const { sendPrunedNotification } = require('../notifications/telegram-notifications');
        await sendPrunedNotification(rawIntent, notificationTxHash);
      } else {
        console.log(`⚠️ Skipping pruned notification for ${intentHash} - fulfilled event already exists or is pending in transaction ${txHash}`);
      }
    } else {
      // Fallback to contract data if not in database
      console.log(`📊 Database data not available, trying contract for pruned intent ${intentHash}`);

      // Import globally available escrowContract - should be set up by main application
      // Fetch the full intent data from the contract since IntentPruned event only has intentHash and depositId
      const intentData = await escrowContract.getIntent(intentHash);

      console.log(`📊 Retrieved intent data from contract for pruned intent ${intentHash}:`, {
        owner: intentData.intent.owner,
        to: intentData.intent.to,
        amount: intentData.intent.amount.toString(),
        paymentVerifier: intentData.intent.paymentVerifier,
        fiatCurrency: intentData.intent.fiatCurrency,
        conversionRate: intentData.intent.conversionRate.toString()
      });

      rawIntent = {
        eventType: 'IntentPruned',
        intentHash: intentHash.toLowerCase(),
        depositId: Number(depositId),
        owner: intentData.intent.owner,
        to: intentData.intent.to,
        amount: intentData.intent.amount.toString(),
        verifier: intentData.intent.paymentVerifier,
        fiatCurrency: intentData.intent.fiatCurrency,
        conversionRate: intentData.intent.conversionRate.toString()
      };
    }

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
  const { depositId, amount } = parsed.args;

  console.log(`💸 Deposit withdrawn: ${depositId} (${Utils.convertFromMicrounits(amount.toString())} USDC)`);
}

async function handleFundsLocked(parsed, log) {
  const { depositId, amount } = parsed.args;

  console.log(`🔒 Funds locked: ${depositId} (${Utils.convertFromMicrounits(amount.toString())} USDC)`);

  // This is equivalent to deposit received - save deposit data for sniper processing
  Web3State.setDepositState(depositId.toString(), {
    depositAmount: amount.toString(),
    verifierAddress: '0x0000000000000000000000000000000000000000' // Default verifier
  });
}

async function handleFundsUnlockedAndTransferred(parsed, log) {
  const { depositId, intentHash, unlockedAmount, transferredAmount, to } = parsed.args;

  console.log(`🔓 Funds unlocked and transferred: ${depositId} (${Utils.convertFromMicrounits(transferredAmount.toString())} USDC) to ${to}`);

  // // This is similar to intent fulfilled - trigger notifications
  // const intentForNotification = {
  //   intentHash: intentHash, // Use actual intentHash from event
  //   depositId: Number(depositId),
  //   paymentVerifier: '0x0000000000000000000000000000000000000000', // Default verifier
  //   owner: to, // The recipient is now the "owner"
  //   to: to,
  //   amount: transferredAmount.toString(),
  //   fiatCurrency: '0x0000000000000000000000000000000000000000000000000000000000000000', // Default USD
  //   conversionRate: '1000000000000000000', // 1:1 for now
  //   sustainabilityFee: '0',
  //   verifierFee: '0',
  //   timestamp: Math.floor(Date.now() / 1000)
  // };

  // // Send fulfilled notification
  // const { sendFulfilledNotification } = require('../notifications/telegram-notifications');
  // await sendFulfilledNotification(intentForNotification, log.transactionHash.toLowerCase());
  // console.log(`✅ Sent transfer notification for deposit ${depositId}`);
}

async function handleDepositMinConversionRateUpdated(parsed, log) {
  // Handle BigInt values properly from parsed event
  const depositId = BigInt(parsed.args[0]).toString();
  const paymentMethod = parsed.args[1];
  const currency = parsed.args[2];
  const minConversionRate = BigInt(parsed.args[3]).toString();

  // Validate parsed event arguments
  if (!paymentMethod || typeof paymentMethod !== 'string') {
    console.error(`❌ Invalid paymentMethod in DepositMinConversionRateUpdated event:`, paymentMethod);
    return;
  }

  console.log(`📊 DepositMinConversionRateUpdated: ID=${depositId}, PaymentMethod=${paymentMethod}, Currency=${currency}, MinRate=${minConversionRate}`);

  // ✅ IMPROVED DEPOSIT AMOUNT RETRIEVAL LOGIC
  let depositAmount = null;
  let amountSource = 'unknown';

  // Step 1: Check Web3State first (most reliable)
  try {
    const web3StateData = Web3State.getDepositStateById(depositId.toString());
    if (web3StateData && web3StateData.depositAmount && parseInt(web3StateData.depositAmount) > 0) {
      depositAmount = web3StateData.depositAmount.toString();
      amountSource = 'Web3State';
      console.log(`📊 Using Web3State amount: ${Utils.convertFromMicrounits(depositAmount)} USDC`);
    }
  } catch (web3Error) {
    console.warn(`⚠️ Web3State error: ${web3Error.message}`);
  }

  // Step 2: Try database if Web3State failed
  if (!depositAmount || parseInt(depositAmount) <= 0) {
    try {
      const dbManager = new DatabaseManager();
      const dbAmount = await dbManager.getDepositAmount(depositId);
      if (dbAmount && parseInt(dbAmount) > 0) {
        depositAmount = dbAmount.toString();
        amountSource = 'Database';
        console.log(`📊 Using database amount: ${Utils.convertFromMicrounits(depositAmount)} USDC`);
        
        // Cache in Web3State for future use
        try {
          const paymentMethodLower = paymentMethod.toLowerCase();
          Web3State.setDepositState(depositId.toString(), {
            depositAmount: depositAmount,
            verifierAddress: paymentMethodLower
          });
          console.log(`✅ Cached deposit amount in Web3State: ${depositId}`);
        } catch (cacheError) {
          console.warn(`⚠️ Web3State caching error:`, cacheError.message);
        }
      }
    } catch (dbError) {
      console.warn(`⚠️ Database error:`, dbError.message);
    }
  }

  // Step 3: Try contract if database failed
  if (!depositAmount || parseInt(depositAmount) <= 0) {
    try {
      // Check if protocolViewerContract is available
      if (typeof protocolViewerContract !== 'undefined' && protocolViewerContract) {
        const depositData = await protocolViewerContract.getDeposit(depositId);
        
        if (depositData && depositData.deposit && depositData.deposit.amount) {
          const contractAmount = BigInt(depositData.deposit.amount).toString();
          if (parseInt(contractAmount) > 0) {
            depositAmount = contractAmount;
            amountSource = 'Contract';
            console.log(`✅ Retrieved from contract: ${Utils.convertFromMicrounits(contractAmount)} USDC`);

            // Cache in Web3State for future use
            try {
              const paymentMethodLower = paymentMethod.toLowerCase();
              Web3State.setDepositState(depositId.toString(), {
                depositAmount: contractAmount,
                verifierAddress: paymentMethodLower
              });
              console.log(`✅ Cached deposit amount in Web3State: ${depositId}`);
            } catch (cacheError) {
              console.warn(`⚠️ Web3State caching error:`, cacheError.message);
            }

            // Also store in database for future use
            try {
              const dbManager = new DatabaseManager();
              await dbManager.storeDepositAmount(depositId, contractAmount);
              console.log(`✅ Stored deposit amount in database: ${depositId}`);
            } catch (storeError) {
              console.warn(`⚠️ Database storage error:`, storeError.message);
            }
          }
        } else {
          console.warn(`⚠️ No valid deposit data found in contract for ${depositId}`);
        }
      } else {
        console.warn(`⚠️ protocolViewerContract not available`);
      }
    } catch (contractError) {
      console.warn(`⚠️ Contract error for deposit ${depositId}:`, contractError.message);
    }
  }

  // Final validation and fallback
  if (!depositAmount || parseInt(depositAmount) <= 0) {
    console.error(`❌ Could not retrieve deposit amount for ${depositId} from any source (Web3State, Database, Contract)`);
    console.error(`❌ Event details: PaymentMethod=${paymentMethod}, Currency=${currency}`);
    return; // Exit early instead of using fallback
  }

  console.log(`✅ Successfully retrieved deposit amount for ${depositId} from ${amountSource}: ${Utils.convertFromMicrounits(depositAmount)} USDC`);

  // Only check sniper opportunities for non-zero currencies
  if (!isZeroAddress(currency)) {
    console.log(`📊 Processing sniper opportunity for deposit ${depositId}`);

    await checkSniperOpportunity(
      depositId,
      depositAmount,       // ✅ REAL deposit amount from verified source
      currency,            // ✅ Currency hash
      minConversionRate,   // ✅ Updated minimum conversion rate
      paymentMethod        // ✅ Payment method
    );
  } else {
    console.log(`⏭️ Skipping sniper check for zero currency address: ${currency}`);
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
};

// Orchestrator-specific event handlers (different from escrow handlers)
async function handleOrchestratorIntentSignaled(parsed, log) {
  const {
    intentHash,
    escrow,
    depositId,
    paymentMethod,
    owner,
    to,
    amount,
    fiatCurrency,
    conversionRate,
    timestamp
  } = parsed.args;

  console.log(`📝 ORCHESTRATOR INTENT_SIGNALED EVENT RECEIVED:`);
  console.log(`   - Intent Hash: ${intentHash}`);
  console.log(`   - Escrow Contract: ${escrow}`);
  console.log(`   - Deposit ID: ${depositId}`);
  console.log(`   - Payment Method: ${paymentMethod}`);
  console.log(`   - Owner: ${owner}`);
  console.log(`   - To: ${to}`);
  console.log(`   - Amount: ${amount}`);
  console.log(`   - Fiat Currency: ${fiatCurrency}`);
  console.log(`   - Conversion Rate: ${conversionRate}`);
  console.log(`   - Timestamp: ${timestamp}`);

  // Store intent data for later processing
  const rawIntent = {
    eventType: 'IntentSignaled',
    source: 'orchestrator',
    intentHash: intentHash?.toLowerCase() || '',
    escrowAddress: escrow?.toLowerCase() || '',
    depositId: Number(depositId) || 0,
    paymentMethod: paymentMethod?.toLowerCase() || '',
    verifier: paymentMethod?.toLowerCase() || '', // Use paymentMethod as verifier for orchestrator events
    owner: owner?.toLowerCase() || '',
    to: to?.toLowerCase() || '',
    amount: amount?.toString() || '0',
    fiatCurrency: fiatCurrency?.toLowerCase() || '',
    conversionRate: conversionRate?.toString() || '0',
    timestamp: Number(timestamp) || 0
  };

  // Store intent data in database for persistence
  const dbManager = new DatabaseManager();
  await dbManager.storeIntentData(rawIntent);

  // Get transaction hash
  const txHash = log.transactionHash.toLowerCase();
  console.log(`📝 Processing in transaction ${txHash}`);

  // Add to pending transactions for processing
  Web3State.addTransactionIntent(txHash, intentHash, rawIntent);
  scheduleTransactionProcessing(txHash);

  console.log(`✅ Orchestrator IntentSignaled collected for batching`);
  console.log(`   - Transaction has ${Web3State.getAllIntentsForTransaction(txHash).size} intents`);

  // Send immediate notification for signaled intent
  const notificationTxHash = log.transactionHash;
  await sendSignaledNotification(rawIntent, notificationTxHash);
}

async function handleOrchestratorIntentFulfilled(parsed, log) {
  const { intentHash, fundsTransferredTo, amount, isManualRelease } = parsed.args;

  console.log(`✅ Orchestrator Intent fulfilled: ${intentHash} (${isManualRelease ? 'manual' : 'auto'} release)`);

  // Construct notification data from parsed event
  const intentForNotification = {
    intentHash: intentHash.toLowerCase(),
    source: 'orchestrator',
    fundsTransferredTo: fundsTransferredTo.toLowerCase(),
    amount: amount.toString(),
    isManualRelease: isManualRelease,
    timestamp: Math.floor(Date.now() / 1000)
  };

  // Store intent data for processing
  const rawIntent = {
    eventType: 'IntentFulfilled',
    source: 'orchestrator',
    intentHash: intentHash.toLowerCase(),
    fundsTransferredTo: fundsTransferredTo.toLowerCase(),
    amount: amount.toString(),
    isManualRelease: isManualRelease
  };

  // Get transaction hash
  const txHash = log.transactionHash.toLowerCase();

  // Add to pending transactions for processing (merge with existing data)
  const currentTxData = Web3State.getTransactionState(txHash);
  if (currentTxData) {
    // Merge with existing transaction data
    currentTxData.fulfilled.add(intentHash.toLowerCase());
    currentTxData.rawIntents.set(intentHash.toLowerCase(), rawIntent);
    Web3State.setTransactionState(txHash, currentTxData);
  } else {
    // Create new transaction data
    Web3State.setTransactionState(txHash, {
      txHash,
      fulfilled: new Set([intentHash.toLowerCase()]),
      pruned: new Set(),
      rawIntents: new Map([[intentHash.toLowerCase(), rawIntent]]),
      processed: false
    });
  }

  // Schedule processing
  scheduleTransactionProcessing(txHash);

  console.log(`📝 Orchestrator IntentFulfilled collected for batching`);
}

async function handleOrchestratorIntentPruned(parsed, log) {
  const { intentHash } = parsed.args;

  console.log(`✂️ Orchestrator Intent pruned: ${intentHash}`);

  // Get transaction hash
  const txHash = log.transactionHash.toLowerCase();

  // Store intent data for processing
  const rawIntent = {
    eventType: 'IntentPruned',
    source: 'orchestrator',
    intentHash: intentHash.toLowerCase(),
    timestamp: Math.floor(Date.now() / 1000)
  };

  // Add to pending transactions for processing (merge with existing data)
  const currentTxData = Web3State.getTransactionState(txHash);
  if (currentTxData) {
    // Merge with existing transaction data
    currentTxData.pruned.add(intentHash.toLowerCase());
    currentTxData.rawIntents.set(intentHash.toLowerCase(), rawIntent);
    Web3State.setTransactionState(txHash, currentTxData);
  } else {
    // Create new transaction data
    Web3State.setTransactionState(txHash, {
      txHash,
      fulfilled: new Set(),
      pruned: new Set([intentHash.toLowerCase()]),
      rawIntents: new Map([[intentHash.toLowerCase(), rawIntent]]),
      processed: false
    });
  }

  // Schedule processing
  scheduleTransactionProcessing(txHash);

  console.log(`📝 Orchestrator IntentPruned collected for batching`);
}

// Additional Event Handlers for V3 Escrow Contract

async function handleDepositFundsAdded(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const depositor = parsed.args[1];
  const amount = BigInt(parsed.args[2]).toString();

  console.log(`💰 Deposit funds added: ${depositId} (${Utils.convertFromMicrounits(amount)} from ${depositor})`);

  // Update deposit state with additional funds
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    const newAmount = BigInt(existingData.depositAmount || '0') + BigInt(amount);
    existingData.depositAmount = newAmount.toString();
    console.log(`🔄 Updated deposit ${depositId} total amount: ${Utils.convertFromMicrounits(newAmount.toString())}`);
  }
}

async function handleDepositDelegateSet(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const depositor = parsed.args[1];
  const delegate = parsed.args[2];

  console.log(`👤 Deposit delegate set: ${depositId} (delegate: ${delegate} by ${depositor})`);

  // Update deposit state
  Web3State.setDepositState(depositId, {
    delegateAddress: delegate.toLowerCase(),
    updatedAt: Date.now()
  });
}

async function handleDepositDelegateRemoved(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const depositor = parsed.args[1];

  console.log(`🚫 Deposit delegate removed: ${depositId} (by ${depositor})`);

  // Update deposit state to remove delegate
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    delete existingData.delegateAddress;
    existingData.updatedAt = Date.now();
    console.log(`🔄 Removed delegate for deposit ${depositId}`);
  }
}

async function handleDepositIntentAmountRangeUpdated(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const intentAmountRange = parsed.args[1];

  console.log(`📊 Deposit intent amount range updated: ${depositId} (range: ${intentAmountRange.toString()})`);

  // Update deposit state with new intent amount range
  Web3State.setDepositState(depositId, {
    intentAmountRange: intentAmountRange.toString(),
    updatedAt: Date.now()
  });
}

async function handleDepositPaymentMethodActiveUpdated(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const paymentMethod = parsed.args[1];
  const isActive = parsed.args[2];

  console.log(`💳 Deposit payment method updated: ${depositId} (${paymentMethod}, active: ${isActive})`);

  // Update deposit state with payment method status
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    if (!existingData.paymentMethods) {
      existingData.paymentMethods = {};
    }
    existingData.paymentMethods[paymentMethod] = {
      active: isActive,
      updatedAt: Date.now()
    };
    existingData.updatedAt = Date.now();
  }
}

async function handleDepositAcceptingIntentsUpdated(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const acceptingIntents = parsed.args[1];

  console.log(`🎯 Deposit accepting intents updated: ${depositId} (accepting: ${acceptingIntents})`);

  // Update deposit state
  Web3State.setDepositState(depositId, {
    acceptingIntents: acceptingIntents,
    updatedAt: Date.now()
  });
}

async function handleDepositRetainOnEmptyUpdated(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const retainOnEmpty = parsed.args[1];

  console.log(`🔒 Deposit retain on empty updated: ${depositId} (retain: ${retainOnEmpty})`);

  // Update deposit state
  Web3State.setDepositState(depositId, {
    retainOnEmpty: retainOnEmpty,
    updatedAt: Date.now()
  });
}

async function handleFundsUnlocked(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const intentHash = parsed.args[1];
  const amount = BigInt(parsed.args[2]).toString();

  console.log(`🔓 Funds unlocked: ${depositId} (${Utils.convertFromMicrounits(amount)} for intent ${intentHash})`);

  // Update deposit state to mark funds as unlocked
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    if (!existingData.unlockedIntents) {
      existingData.unlockedIntents = new Set();
    }
    existingData.unlockedIntents.add(intentHash.toLowerCase());
    existingData.updatedAt = Date.now();
    console.log(`🔓 Marked intent ${intentHash} as unlocked for deposit ${depositId}`);
  }
}

async function handleIntentExpiryExtended(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const intentHash = parsed.args[1];
  const expiryTime = BigInt(parsed.args[2]).toString();

  console.log(`⏰ Intent expiry extended: ${depositId} (intent: ${intentHash}, new expiry: ${expiryTime})`);

  // Update deposit state or intent data
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    if (!existingData.extendedIntents) {
      existingData.extendedIntents = new Map();
    }
    existingData.extendedIntents.set(intentHash.toLowerCase(), {
      originalExpiry: existingData.intentExpiry,
      newExpiry: expiryTime.toString(),
      extendedAt: Date.now()
    });
    existingData.updatedAt = Date.now();
    console.log(`⏰ Extended expiry for intent ${intentHash} in deposit ${depositId}`);
  }
}

async function handleDustCollected(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const totalRemaining = BigInt(parsed.args[1]).toString();
  const dustRecipient = parsed.args[2];

  console.log(`🧹 Dust collected: ${depositId} (${Utils.convertFromMicrounits(totalRemaining)} to ${dustRecipient})`);

  // Update deposit state
  Web3State.setDepositState(depositId, {
    dustCollected: true,
    dustRecipient: dustRecipient.toLowerCase(),
    totalRemaining: totalRemaining.toString(),
    dustCollectedAt: Date.now(),
    updatedAt: Date.now()
  });
}

async function handleDepositClosed(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const depositor = parsed.args[1];

  console.log(`🔒 Deposit closed: ${depositId} (by ${depositor})`);

  // Update deposit state to mark as closed
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    existingData.closed = true;
    existingData.closedAt = Date.now();
    existingData.closedBy = depositor.toLowerCase();
    existingData.updatedAt = Date.now();
    console.log(`🔒 Marked deposit ${depositId} as closed`);
  }
}

async function handleDepositPaymentMethodAdded(parsed, log) {
  const depositId = BigInt(parsed.args[0]).toString();
  const paymentMethod = parsed.args[1];
  const payeeDetails = parsed.args[2];
  const intentGatingService = parsed.args[3];

  console.log(`💳 Deposit payment method added: ${depositId} (${paymentMethod})`);

  // Update deposit state with new payment method
  const existingData = Web3State.getDepositStateById(depositId);
  if (existingData) {
    if (!existingData.paymentMethods) {
      existingData.paymentMethods = {};
    }
    existingData.paymentMethods[paymentMethod] = {
      payeeDetails: payeeDetails.toLowerCase(),
      intentGatingService: intentGatingService.toLowerCase(),
      addedAt: Date.now(),
      active: true
    };
    existingData.updatedAt = Date.now();
    console.log(`💳 Added payment method ${paymentMethod} to deposit ${depositId}`);
  }
}

// Protocol Configuration Event Handlers
async function handleOrchestratorUpdated(parsed, log) {
  const orchestrator = parsed.args[0];

  console.log(`🏗️ Orchestrator updated: ${orchestrator}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New orchestrator: ${orchestrator}`);
}

async function handlePaymentVerifierRegistryUpdated(parsed, log) {
  const paymentVerifierRegistry = parsed.args[0];

  console.log(`📋 Payment verifier registry updated: ${paymentVerifierRegistry}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New payment verifier registry: ${paymentVerifierRegistry}`);
}

async function handleDustRecipientUpdated(parsed, log) {
  const dustRecipient = parsed.args[0];

  console.log(`🧹 Dust recipient updated: ${dustRecipient}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New dust recipient: ${dustRecipient}`);
}

async function handleDustThresholdUpdated(parsed, log) {
  const dustThreshold = BigInt(parsed.args[0]).toString();

  console.log(`💰 Dust threshold updated: ${Utils.convertFromMicrounits(dustThreshold)}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New dust threshold: ${Utils.convertFromMicrounits(dustThreshold)}`);
}

async function handleMaxIntentsPerDepositUpdated(parsed, log) {
  const maxIntentsPerDeposit = BigInt(parsed.args[0]).toString();

  console.log(`🎯 Max intents per deposit updated: ${maxIntentsPerDeposit}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New max intents per deposit: ${maxIntentsPerDeposit}`);
}

async function handleIntentExpirationPeriodUpdated(parsed, log) {
  const intentExpirationPeriod = BigInt(parsed.args[0]).toString();

  console.log(`⏰ Intent expiration period updated: ${intentExpirationPeriod} seconds`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New intent expiration period: ${intentExpirationPeriod} seconds`);
}

// Orchestrator Contract Event Handlers

async function handleAllowMultipleIntentsUpdated(parsed, log) {
  const allowMultiple = parsed.args[0];

  console.log(`🎯 Allow multiple intents updated: ${allowMultiple}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - Allow multiple intents: ${allowMultiple}`);
}

async function handlePostIntentHookRegistryUpdated(parsed, log) {
  const postIntentHookRegistry = parsed.args[0];

  console.log(`🔗 Post-intent hook registry updated: ${postIntentHookRegistry}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New post-intent hook registry: ${postIntentHookRegistry}`);
}

async function handleRelayerRegistryUpdated(parsed, log) {
  const relayerRegistry = parsed.args[0];

  console.log(`🔄 Relayer registry updated: ${relayerRegistry}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New relayer registry: ${relayerRegistry}`);
}

async function handleEscrowRegistryUpdated(parsed, log) {
  const escrowRegistry = parsed.args[0];

  console.log(`🏦 Escrow registry updated: ${escrowRegistry}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New escrow registry: ${escrowRegistry}`);
}

async function handleProtocolFeeUpdated(parsed, log) {
  const protocolFee = BigInt(parsed.args[0]).toString();

  console.log(`💰 Protocol fee updated: ${Utils.convertFromMicrounits(protocolFee)}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New protocol fee: ${Utils.convertFromMicrounits(protocolFee)}`);
}

async function handleProtocolFeeRecipientUpdated(parsed, log) {
  const protocolFeeRecipient = parsed.args[0];

  console.log(`🏦 Protocol fee recipient updated: ${protocolFeeRecipient}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New protocol fee recipient: ${protocolFeeRecipient}`);
}

async function handleMinDepositAmountSet(parsed, log) {
  const minDepositAmount = BigInt(parsed.args[0]).toString();

  console.log(`💸 Minimum deposit amount set: ${Utils.convertFromMicrounits(minDepositAmount)}`);

  // Log protocol configuration change
  console.log(`🔧 Protocol configuration updated - New minimum deposit amount: ${Utils.convertFromMicrounits(minDepositAmount)}`);
}

module.exports = {
  handleDepositCurrencyAdded,
  handleDepositConversionRateUpdated,
  handleDepositReceived,
  handleDepositVerifierAdded,
  handleIntentSignaled,
  handleIntentFulfilled,
  handleIntentPruned,
  handleDepositWithdrawn,
  handleFundsLocked,
  handleFundsUnlockedAndTransferred,
  handleDepositMinConversionRateUpdated,
  // V3 Escrow event handlers
  handleDepositFundsAdded,
  handleDepositDelegateSet,
  handleDepositDelegateRemoved,
  handleDepositIntentAmountRangeUpdated,
  handleDepositPaymentMethodActiveUpdated,
  handleDepositAcceptingIntentsUpdated,
  handleDepositRetainOnEmptyUpdated,
  handleFundsUnlocked,
  handleIntentExpiryExtended,
  handleDustCollected,
  handleDepositClosed,
  handleDepositPaymentMethodAdded,
  // Protocol configuration event handlers
  handleOrchestratorUpdated,
  handlePaymentVerifierRegistryUpdated,
  handleDustRecipientUpdated,
  handleDustThresholdUpdated,
  handleMaxIntentsPerDepositUpdated,
  handleIntentExpirationPeriodUpdated,
  // Orchestrator contract event handlers
  handleAllowMultipleIntentsUpdated,
  handlePostIntentHookRegistryUpdated,
  handleRelayerRegistryUpdated,
  handleEscrowRegistryUpdated,
  handleProtocolFeeUpdated,
  handleProtocolFeeRecipientUpdated,
  handleMinDepositAmountSet,
  // Orchestrator-specific handlers
  handleOrchestratorIntentSignaled,
  handleOrchestratorIntentFulfilled,
  handleOrchestratorIntentPruned,
  // Main orchestrator handler (legacy - should not be used)
  handleOrchestratorEvent,
  // Main unified event handler
  handleContractEvent
};