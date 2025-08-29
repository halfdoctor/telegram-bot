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
    const response = await fetch(EXCHANGE_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.result === 'error') {
      throw new Error(`Exchange API error: ${data['error-type']}`);
    }

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
    if (fromCurrency === toCurrency) {
      return 1;
    }

    const rates = await getExchangeRates();

    if (fromCurrency === 'USD') {
      return rates.conversion_rates[toCurrency] || null;
    }

    if (toCurrency === 'USD') {
      return 1 / rates.conversion_rates[fromCurrency] || null;
    }

    // Cross rate: from -> USD -> to
    const fromRate = rates.conversion_rates[fromCurrency];
    const toRate = rates.conversion_rates[toCurrency];

    if (!fromRate || !toRate) {
      return null;
    }

    return toRate / fromRate;
  } catch (error) {
    console.error(`Error getting rate from ${fromCurrency} to ${toCurrency}:`, error);
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