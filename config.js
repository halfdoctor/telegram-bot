require('dotenv').config({ path: __dirname + '/.env' });
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const fs = require('fs');

// Supabase setup - Using service role key to bypass RLS for backend operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize ethers provider
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC);

// Load Escrow contract ABI (V3)
const ESCROW_ABI = JSON.parse(fs.readFileSync(__dirname + '/Escrow.json', 'utf8')).abi;

// Load Orchestrator contract ABI (V3 - different ABI structure)
const ORCHESTRATOR_ABI = JSON.parse(fs.readFileSync(__dirname + '/abi.js', 'utf8'));

// Load ProtocolViewer contract ABI (V3 - for deposit/intent queries)
const PROTOCOL_VIEWER_ABI = JSON.parse(fs.readFileSync(__dirname + '/ProtocolViewer.json', 'utf8')).abi;

// Initialize escrow contract (V3)
const escrowContract = new ethers.Contract('0x2f121CDDCA6d652f35e8B3E560f9760898888888', ESCROW_ABI, provider);

// Initialize orchestrator contract (V3)
const orchestratorContract = new ethers.Contract('0x88888883Ed048FF0a415271B28b2F52d431810D0', ORCHESTRATOR_ABI, provider);

// Initialize protocol viewer contract (V3 - for proper deposit/intent queries)
const protocolViewerContract = new ethers.Contract('0x30B03De22328074Fbe8447C425ae988797146606', PROTOCOL_VIEWER_ABI, provider);

// Exchange rate API configuration
const EXCHANGE_API_URL = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_API_KEY}/latest/USD`;
const FALLBACK_EXCHANGE_API_URL = 'https://api.frankfurter.app/latest?from=USD';

// Global storage
const depositAmounts = new Map(); // Store deposit amounts temporarily
const intentDetails = new Map();

// Unified platform mapping for V3 (payment method hashes from idea.txt)
// All payment methods resolve to UnifiedPaymentVerifier at 0x16b3e4a3CA36D3A4bCA281767f15C7ADeF4ab163
const platformMapping = {
  // Payment method hashes (Orchestrator V3) - 66 chars
  '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268': { platform: 'venmo', isUsdOnly: true },
  '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d': { platform: 'revolut', isUsdOnly: false },
  '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d': { platform: 'cashapp', isUsdOnly: true },
  '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5': { platform: 'wise', isUsdOnly: false },
  '0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483': { platform: 'mercado pago', isUsdOnly: false },
  '0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d': { platform: 'zelle', isUsdOnly: true },
  '0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e': { platform: 'zelle', isUsdOnly: true },
  '0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5': { platform: 'zelle', isUsdOnly: true },
  '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f': { platform: 'paypal', isUsdOnly: false },
  '0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c': { platform: 'monzo', isUsdOnly: false }
};

// Enhanced platform mapping for user-friendly names (V3 payment method hashes)
const platformNameMapping = {
  '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268': '💳 Venmo',
  '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d': '🇪🇺 Revolut',
  '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d': '💵 Cash-App',
  '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5': '🌍 Wise',
  '0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483': '🇦🇷 Mercado-Pago',
  '0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d': '🏦 Zelle-(Citi)',
  '0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e': '🏦 Zelle-(Chase)',
  '0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5': '🏦 Zelle-(BofA)',
  '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f': '💰 PayPal',
  '0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c': '🇬🇧 Monzo',
  // Additional mappings can be added here
};

const currencyNameMapping = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '💰 USDC',
  '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907': '🇪🇺 € EUR',
  '0x90832e2dc3221e4d56977c1aa8f6a6706b9ad6542fbbdaac13097d0fa5e42e67': '🇬🇧 £ GBP',
  '0xfe13aafd831cb225dfce3f6431b34b5b17426b6bff4fccabe4bbe0fe4adc0452': '🇯🇵 ¥ JPY',
  '0xcb83cbb58eaa5007af6cad99939e4581c1e1b50d65609c30f303983301524ef3': '🇦🇺 A$ AUD',
  '0x221012e06ebf59a20b82e3003cf5d6ee973d9008bdb6e2f604faa89a27235522': '🇨🇦 C$ CAD',
  '0xc9d84274fd58aa177cabff54611546051b74ad658b939babaad6282500300d36': '🇨🇭 Fr CHF',
  '0xfaaa9c7b2f09d6a1b0971574d43ca62c3e40723167c09830ec33f06cec921381': '🇨🇳 ¥ CNY',
  '0xaad766fbc07fb357bed9fd8b03b935f2f71fe29fc48f08274bc2a01d7f642afc': '🇮🇳 ₹ INR',
  '0x128d6c262d1afe2351c6e93ceea68e00992708cfcbc0688408b9a23c0c543db2': '🇹🇷 ₺ TRY',
  '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e': '🇺🇸 $ USD',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': '🇻🇳 ₫ VND',
  '0x589be49821419c9c2fbb26087748bf3420a5c13b45349828f5cac24c58bbaa7b': '🇰🇪 KSh KES',
  '0xa94b0702860cb929d0ee0c60504dd565775a058bf1d2a2df074c1db0a66ad582': '🇲🇽 $ MXN',
  '0xf20379023279e1d79243d2c491be8632c07cfb116be9d8194013fb4739461b84': '🇲🇾 RM MYR',
  '0x8fb505ed75d9d38475c70bac2c3ea62d45335173a71b2e4936bd9f05bf0ddfea': '🇳🇴 kr NOK',
  '0xdbd9d34f382e9f6ae078447a655e0816927c7c3edec70bd107de1d34cb15172e': '🇳🇿 NZ$ NZD',
  '0xe6c11ead4ee5ff5174861adb55f3e8fb2841cca69bf2612a222d3e8317b6ae06': '🇵🇭 ₱ PHP',
  '0x9a788fb083188ba1dfb938605bc4ce3579d2e085989490aca8f73b23214b7c1d': '🇵🇱 zł PLN',
  '0x2dd272ddce846149d92496b4c3e677504aec8d5e6aab5908b25c9fe0a797e25f': '🇷🇴 lei RON',
  '0xf998cbeba8b7a7e91d4c469e5fb370cdfa16bd50aea760435dc346008d78ed1f': '🇸🇦 ﷼ SAR',
  '0x8895743a31faedaa74150e89d06d281990a1909688b82906f0eb858b37f82190': '🇸🇪 kr SEK',
  '0xc241cc1f9752d2d53d1ab67189223a3f330e48b75f73ebf86f50b2c78fe8df88': '🇸🇬 S$ SGD',
  '0x326a6608c2a353275bd8d64db53a9d772c1d9a5bc8bfd19dfc8242274d1e9dd4': '🇹🇭 ฿ THB',
  '0x7766ee347dd7c4a6d5a55342d89e8848774567bcf7a5f59c3e82025dbde3babb': '🇭🇺 Ft HUF',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': '🇮🇱 ₪ ILS',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': '🇮🇩 Rp IDR',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': '🇻🇳 ₫ VND',
  '0x4dab77a640748de8588de6834d814a344372b205265984b969f3e97060955bfa': '🇦🇪 د.إ AED',
  '0x8fd50654b7dd2dc839f7cab32800ba0c6f7f66e1ccf89b21c09405469c2175ec': '🇦🇷 $ ARS',
  '0xd783b199124f01e5d0dde2b7fc01b925e699caea84eae3ca92ed17377f498e97': '🇨🇿 Kč CZK',
  '0x5ce3aa5f4510edaea40373cbe83c091980b5c92179243fe926cb280ff07d403e': '🇩🇰 kr DKK',
  '0xa156dad863111eeb529c4b3a2a30ad40e6dcff3b27d8f282f82996e58eee7e7d': '🇭🇰 HK$ HKD',
  '0x7766ee347dd7c4a6d5a55342d89e8848774567bcf7a5f59c3e82025dbde3babb': '🇭🇺 Ft HUF',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': '🇮🇩 Rp IDR',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': '🇮🇱 ₪ ILS',
  '0xaad766fbc07fb357bed9fd8b03b935f2f71fe29fc48f08274bc2a01d7f642afc': '🇮🇳 ₹ INR',
  '0xfe13aafd831cb225dfce3f6431b34b5b17426b6bff4fccabe4bbe0fe4adc0452': '🇯🇵 ¥ JPY',
  '0x589be49821419c9c2fbb26087748bf3420a5c13b45349828f5cac24c58bbaa7b': '🇰🇪 KSh KES',
  '0xa94b0702860cb929d0ee0c60504dd565775a058bf1d2a2df074c1db0a66ad582': '🇲🇽 $ MXN',
  '0xf20379023279e1d79243d2c491be8632c07cfb116be9d8194013fb4739461b84': '🇲🇾 RM MYR',
  '0x8fb505ed75d9d38475c70bac2c3ea62d45335173a71b2e4936bd9f05bf0ddfea': '🇳🇴 kr NOK',
  '0xdbd9d34f382e9f6ae078447a655e0816927c7c3edec70bd107de1d34cb15172e': '🇳🇿 NZ$ NZD',
  '0xe6c11ead4ee5ff5174861adb55f3e8fb2841cca69bf2612a222d3e8317b6ae06': '🇵🇭 ₱ PHP',
  '0x9a788fb083188ba1dfb938605bc4ce3579d2e085989490aca8f73b23214b7c1d': '🇵🇱 zł PLN',
  '0x2dd272ddce846149d92496b4c3e677504aec8d5e6aab5908b25c9fe0a797e25f': '🇷🇴 lei RON',
  '0xf998cbeba8b7a7e91d4c469e5fb370cdfa16bd50aea760435dc346008d78ed1f': '🇸🇦 ﷼ SAR',
  '0x8895743a31faedaa74150e89d06d281990a1909688b82906f0eb858b37f82190': '🇸🇪 kr SEK',
  '0xc241cc1f9752d2d53d1ab67189223a3f330e48b75f73ebf86f50b2c78fe8df88': '🇸🇬 S$ SGD',
  '0x326a6608c2a353275bd8d64db53a9d772c1d9a5bc8bfd19dfc8242274d1e9dd4': '🇹🇭 ฿ THB',
  '0x7766ee347dd7c4a6d5a55342d89e8848774567bcf7a5f59c3e82025dbde3babb': '🇭🇺 Ft HUF',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': '🇮🇱 ₪ ILS',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': '🇮🇩 Rp IDR',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': '🇻🇳 ₫ VND',
  // Additional mappings can be added here
};

// Unified platform name lookup - works with both verifier addresses and payment method hashes
const getPlatformName = (identifier) => {
  const mapping = platformMapping[identifier.toLowerCase()];
  if (mapping) {
    // Normalize zelle variants to just "zelle" for display
    return mapping.platform.startsWith('zelle') ? 'zelle' : mapping.platform;
  }
  // Show truncated identifier for unknown platforms
  const identifierStr = identifier.toLowerCase();
  if (identifierStr.length === 42) {
    // Address format (40 chars + 0x)
    return `Unknown (${identifierStr.slice(0, 6)}...${identifierStr.slice(-4)})`;
  } else {
    // Hash format (64 chars + 0x)
    return `Unknown (${identifierStr.slice(0, 8)}...${identifierStr.slice(-6)})`;
  }
};

const currencyHashToCode = {
  '0x4555520000000000000000000000000000000000000000000000000000000000': 'EUR',
  '0x4742500000000000000000000000000000000000000000000000000000000000': 'GBP',
  '0x4a50590000000000000000000000000000000000000000000000000000000000': 'JPY',
  '0x4155440000000000000000000000000000000000000000000000000000000000': 'AUD',
  '0x4341440000000000000000000000000000000000000000000000000000000000': 'CAD',
  '0x4348460000000000000000000000000000000000000000000000000000000000': 'CHF',
  '0x434e590000000000000000000000000000000000000000000000000000000000': 'CNY',
  '0x494e520000000000000000000000000000000000000000000000000000000000': 'INR',
  '0x4b52570000000000000000000000000000000000000000000000000000000000': 'KRW',
  '0x42524c0000000000000000000000000000000000000000000000000000000000': 'BRL',
  '0x4d584e0000000000000000000000000000000000000000000000000000000000': 'MXN',
  '0x5347440000000000000000000000000000000000000000000000000000000000': 'SGD',
  '0x4e5a440000000000000000000000000000000000000000000000000000000000': 'NZD',
  '0x5a41520000000000000000000000000000000000000000000000000000000000': 'ZAR',
  '0x4855460000000000000000000000000000000000000000000000000000000000': 'HUF',
  '0x504c4e0000000000000000000000000000000000000000000000000000000000': 'PLN',
  '0x435a4b0000000000000000000000000000000000000000000000000000000000': 'CZK',
  '0x444b4b0000000000000000000000000000000000000000000000000000000000': 'DKK',
  '0x4e4f4b0000000000000000000000000000000000000000000000000000000000': 'NOK',
  '0x53454b0000000000000000000000000000000000000000000000000000000000': 'SEK',
  '0x494c530000000000000000000000000000000000000000000000000000000000': 'ILS',
  '0x5448440000000000000000000000000000000000000000000000000000000000': 'THB',
  '0x4944520000000000000000000000000000000000000000000000000000000000': 'IDR',
  '0x4d594d0000000000000000000000000000000000000000000000000000000000': 'MYR',
  '0x5048500000000000000000000000000000000000000000000000000000000000': 'PHP',
  '0x564e440000000000000000000000000000000000000000000000000000000000': 'VND',
  '0x4547590000000000000000000000000000000000000000000000000000000000': 'EGY',
  '0x4b45530000000000000000000000000000000000000000000000000000000000': 'KES',
  '0x4e474e0000000000000000000000000000000000000000000000000000000000': 'NGN',
  '0x4748530000000000000000000000000000000000000000000000000000000000': 'GHS',
  '0x54415a0000000000000000000000000000000000000000000000000000000000': 'TZS',
  '0x5547580000000000000000000000000000000000000000000000000000000000': 'UGX',
};

const formatConversionRate = (conversionRate, fiatCode) => {
  if (!conversionRate || !fiatCode) return 'N/A';

  const rate = parseFloat(conversionRate);
  if (isNaN(rate)) return 'N/A';

  // Format based on currency
  const decimalCurrencies = ['JPY', 'KRW', 'VND', 'IDR'];
  if (decimalCurrencies.includes(fiatCode)) {
    return Math.round(rate).toLocaleString();
  } else {
    return rate.toFixed(2);
  }
};

module.exports = {
  supabase,
  provider,
  escrowContract,
  orchestratorContract,
  protocolViewerContract,
  EXCHANGE_API_URL,
  FALLBACK_EXCHANGE_API_URL,
  depositAmounts,
  intentDetails,
  platformMapping,
  platformNameMapping,
  currencyNameMapping,
  getPlatformName,
  currencyHashToCode,
  formatConversionRate,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS
};