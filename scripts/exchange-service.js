const https = require('https');
const { EXCHANGE_API_URL } = require('../config');

// Cache for exchange rates
let exchangeRateCache = {
  data: null,
  timestamp: null,
  cacheDuration: 2 * 60 * 1000 // 5 minutes
};

async function getExchangeRates() {
  // Check cache first
  const now = Date.now();
  if (exchangeRateCache.data && exchangeRateCache.timestamp &&
      (now - exchangeRateCache.timestamp) < exchangeRateCache.cacheDuration) {
    return exchangeRateCache.data;
  }

  try {
    const data = await new Promise((resolve, reject) => {
      const url = new URL(EXCHANGE_API_URL);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Node.js-Telegram-Bot'
        }
      };

      const req = https.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP error! status: ${res.statusCode}`));
              return;
            }

            const jsonData = JSON.parse(body);

            if (jsonData.result === 'error') {
              reject(new Error(`Exchange API error: ${jsonData['error-type']}`));
              return;
            }

            resolve(jsonData);
          } catch (error) {
            reject(new Error(`JSON parsing error: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request error: ${error.message}`));
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });

    // Cache the result
    exchangeRateCache = {
      data: data,
      timestamp: now
    };

    return data;
  } catch (error) {
    console.error('Error fetching exchange rates:', error);

    // Return cached data if available, even if expired
    if (exchangeRateCache.data) {
      console.log('Using expired cached exchange rates due to API error');
      return exchangeRateCache.data;
    }

    // Return mock data as last resort
    return {
      result: 'success',
      conversion_rates: {
        EUR: 0.92,
        GBP: 0.79,
        JPY: 150.0,
        AUD: 1.52,
        CAD: 1.35,
        CHF: 0.91,
        CNY: 7.2,
        INR: 83.0,
        KRW: 1330.0,
        BRL: 5.2,
        MXN: 18.5
      }
    };
  }
}

async function convertToUSD(amount, fromCurrency) {
  try {
    const rates = await getExchangeRates();

    if (fromCurrency === 'USD') {
      return amount;
    }

    const rate = rates.conversion_rates[fromCurrency];
    if (!rate) {
      throw new Error(`Currency ${fromCurrency} not supported`);
    }

    return amount / rate;
  } catch (error) {
    console.error(`Error converting ${amount} ${fromCurrency} to USD:`, error);
    return null;
  }
}

async function convertFromUSD(amount, toCurrency) {
  try {
    const rates = await getExchangeRates();

    if (toCurrency === 'USD') {
      return amount;
    }

    const rate = rates.conversion_rates[toCurrency];
    if (!rate) {
      throw new Error(`Currency ${toCurrency} not supported`);
    }

    return amount * rate;
  } catch (error) {
    console.error(`Error converting ${amount} USD to ${toCurrency}:`, error);
    return null;
  }
}

async function convertCurrency(amount, fromCurrency, toCurrency) {
  try {
    if (fromCurrency === toCurrency) {
      return amount;
    }

    // Convert to USD first, then to target currency
    const usdAmount = await convertToUSD(amount, fromCurrency);
    if (usdAmount === null) {
      return null;
    }

    return await convertFromUSD(usdAmount, toCurrency);
  } catch (error) {
    console.error(`Error converting ${amount} ${fromCurrency} to ${toCurrency}:`, error);
    return null;
  }
}

async function getCurrencyRate(fromCurrency, toCurrency) {
  try {
    console.log(`getCurrencyRate: ${fromCurrency} -> ${toCurrency}`);
    if (fromCurrency === toCurrency) {
      return 1;
    }

    // Helper function to extract ISO currency code from emoji-formatted names
    const extractISOCurrencyCode = (currencyString) => {
      // Handle emoji-formatted currency names like "🇺🇸 $ USD"
      const match = currencyString.match(/([A-Z]{3})\s*$/);
      return match ? match[1] : currencyString;
    };

    const cleanFromCurrency = extractISOCurrencyCode(fromCurrency);
    const cleanToCurrency = extractISOCurrencyCode(toCurrency);

    console.log(`Cleaned currencies: ${cleanFromCurrency} -> ${cleanToCurrency}`);

    const rates = await getExchangeRates();
    console.log(`Rates available for: ${cleanToCurrency}:`, rates.conversion_rates?.[cleanToCurrency] || 'MISSING');

    if (cleanFromCurrency === 'USD') {
      return rates.conversion_rates[cleanToCurrency] || null;
    }

    if (cleanToCurrency === 'USD') {
      return 1 / rates.conversion_rates[cleanFromCurrency] || null;
    }

    // Cross rate: from -> USD -> to
    const fromRate = rates.conversion_rates[cleanFromCurrency];
    const toRate = rates.conversion_rates[cleanToCurrency];

    if (!fromRate || !toRate) {
      return null;
    }

    return toRate / fromRate;
  } catch (error) {
    console.error(`Error getting rate from ${cleanFromCurrency} to ${cleanToCurrency}:`, error.message);
    return null;
  }
}

function clearCache() {
  exchangeRateCache = {
    data: null,
    timestamp: null
  };
}

module.exports = {
  getExchangeRates,
  convertToUSD,
  convertFromUSD,
  convertCurrency,
  getCurrencyRate,
  clearCache
};