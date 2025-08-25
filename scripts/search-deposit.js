require('dotenv').config({ path: __dirname + '/../.env' });
const { ethers } = require('ethers');
const fs = require('fs');

// Load Escrow contract ABI
const ESCROW_ABI = JSON.parse(fs.readFileSync(__dirname + '/../abi.js', 'utf8'));

// Import provider and contract from bot.js
const { provider, escrowContract } = require('../bot.js');

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

        // Get associated intents
        const intents = await escrowContract.getIntent(depositIdBytes32);

        // Format the data for return
        const result = {
            depositId: depositId, // Keep original ID for user display
            depositor: depositData.deposit.depositor,
            token: depositData.deposit.token,
            amount: depositData.deposit.amount,
            intentHashes: depositData.deposit.intentHashes,
            status: depositData.deposit.acceptingIntents ? 'Active' : 'Inactive',
            availableLiquidity: ethers.formatEther(depositData.availableLiquidity),
            intents: intents,
            verifiers: depositData.verifiers.map(verifier => ({
                verifier: verifier.verifier,
                verificationData: {
                    intentGatingService: verifier.verificationData.intentGatingService,
                    payeeDetails: verifier.verificationData.payeeDetails
                },
                currencies: verifier.currencies.map(currency => ({
                    code: currency.code,
                    conversionRate: ethers.formatEther(currency.conversionRate)
                }))
            }))
        };

        return result;
    } catch (error) {
        console.error('Error searching deposit:', error);
        throw error; // Re-throw to handle externally if needed
    }
}

// Usage example
// searchDeposit(123); // Replace with actual deposit ID

// Export the function for use in other modules
module.exports = { searchDeposit };