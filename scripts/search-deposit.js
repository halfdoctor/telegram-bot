require('dotenv').config({ path: __dirname + '/../.env' });
const { Web3 } = require('web3');
const fs = require('fs');

// Load Escrow contract ABI
const ESCROW_ABI = JSON.parse(fs.readFileSync(__dirname + '/../abi.js', 'utf8'));

// Create web3 instance with provider
const web3 = new Web3(process.env.BASE_RPC);

// Initialize escrow contract
const escrowContract = new web3.eth.Contract(ESCROW_ABI, '0xca38607d85e8f6294dc10728669605e6664c2d70');

async function searchDeposit(depositId) {

    try {
        // Convert deposit ID to bytes32 format
        const depositIdBytes32 = web3.utils.padLeft(web3.utils.toHex(depositId), 64);

        // Get deposit details
        const deposit = await escrowContract.methods.deposits(depositIdBytes32).call();

        if (!deposit.depositor) {
            return { error: `No deposit found with ID: ${depositId}` };
        }

        // Get deposit with all related data using getDeposit method
        const depositData = await escrowContract.methods.getDeposit(depositId).call();

        // Get associated intents
        const intents = await escrowContract.methods.getIntent(depositIdBytes32).call();

        // Format the data for return
        const result = {
            depositId: depositId, // Keep original ID for user display
            depositor: depositData.deposit.depositor,
            token: depositData.deposit.token,
            amount: depositData.deposit.amount,
            intentHashes: depositData.deposit.intentHashes,
            status: depositData.deposit.acceptingIntents ? 'Active' : 'Inactive',
            availableLiquidity: web3.utils.fromWei(depositData.availableLiquidity, 'ether'),
            intents: intents,
            verifiers: depositData.verifiers.map(verifier => ({
                verifier: verifier.verifier,
                verificationData: {
                    intentGatingService: verifier.verificationData.intentGatingService,
                    payeeDetails: verifier.verificationData.payeeDetails
                },
                currencies: verifier.currencies.map(currency => ({
                    code: currency.code,
                    conversionRate: web3.utils.fromWei(currency.conversionRate, 'ether')
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