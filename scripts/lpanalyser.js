const { getDuneData } = require('./dune-service');

class LPProfileAnalyzer {
  constructor() {
    this.duneData = null;
  }

  async fetchEvents(force = false) {
    const result = await getDuneData(force);
    this.duneData = result.result.rows;
  }

  async generateLPProfile(depositorAddress) {
    console.log(`Generating LP profile for ${depositorAddress}...`);

    if (!this.duneData) {
      await this.fetchEvents();
    }

    const profileData = this.duneData.find(
      row => row.depositor.toLowerCase() === depositorAddress.toLowerCase()
    );

    if (!profileData) {
      return { error: `No trading activity found for depositor ${depositorAddress}` };
    }

    // The Dune query provides aggregated data, so we just format it.
    return {
      depositor: depositorAddress,
      currencies_traded: profileData.currencies_traded,
      biggest_single_trade_profit_usd: profileData.biggest_single_trade_profit_usd,
      total_trades: profileData.total_trades,
      total_profit_usd: profileData.total_profit_usd,
      cashapp_trades: profileData.cashapp_trades,
      cashapp_profit: profileData.cashapp_profit,
      venmo_trades: profileData.venmo_trades,
      venmo_profit: profileData.venmo_profit,
      revolut_trades: profileData.revolut_trades,
      revolut_profit: profileData.revolut_profit,
      wise_trades: profileData.wise_trades,
      wise_profit: profileData.wise_profit,
      paypal_trades: profileData.paypal_trades,
      paypal_profit: profileData.paypal_profit,
      monzo_trades: profileData.monzo_trades,
      monzo_profit: profileData.monzo_profit,
      mercadopago_trades: profileData.mercadopago_trades || 0,
      mercadopago_profit: profileData.mercadopago_profit || 0,
      zelle_trades: profileData.zelle_trades || 0,
      zelle_profit: profileData.zelle_profit || 0,
      latest_profit_date: profileData.latest_profit_date,
      running_profit_usd: profileData.running_profit_usd,
      num_vaults: (profileData.num_fully_used || 0) + (profileData.num_fully_withdrawn || 0) + (profileData.num_partial_withdrawn || 0),
      total_deposited: profileData.total_deposited,
      total_withdrawn: profileData.total_withdrawn,
      total_used: profileData.total_used,
      avg_used_pct: profileData.avg_used_pct,
      num_fully_used: profileData.num_fully_used,
      num_fully_withdrawn: profileData.num_fully_withdrawn,
      num_partial_withdrawn: profileData.num_partial_withdrawn,
      avg_duration_days: profileData.avg_duration_days,
      apr_pct: profileData.apr_pct,
      avg_deposit_size_usd: profileData.avg_deposit_size_usd,
      days_since_first_deposit: profileData.days_since_first_deposit,
      raw_data: {
        profit_trades: [], // Dune query does not provide raw trade data
        vault_data: []     // Dune query does not provide raw vault data
      }
    };
  }
}

async function initializeLPAnalyzer() {
  return new LPProfileAnalyzer();
}

async function analyzeLiquidityProvider(depositorAddress, force = false) {
  try {
    console.log('Initializing LP analyzer...');
    const analyzer = await initializeLPAnalyzer();
    
    console.log('Fetching events from Dune...');
    await analyzer.fetchEvents(force);
    
    console.log('Generating LP profile...');
    const profile = await analyzer.generateLPProfile(depositorAddress);
    
    if (profile.error) {
      console.error(profile.error);
      return null;
    }
    
    console.log('LP Profile:', JSON.stringify(profile, null, 2));
    return profile;
  } catch (error) {
    console.error('Error analyzing liquidity provider:', error);
    return null;
  }
}

function formatLPProfileForTelegram(profile) {
  if (!profile || profile.error) {
    return `*LP Profile Analysis*\n\nNo data found for address.`;
  }

  const header = `*📊 LP Profile for* \n${profile.depositor}`;

    const vault = `
*Vaults* - ${profile.num_vaults}
- *Total Deposited:* $${profile.total_deposited.toFixed(2)}
- *Total Sold:* $${profile.total_used.toFixed(2)}
- *Avg. Deposit Size:* $${profile.avg_deposit_size_usd.toFixed(2)}
- *Avg. Duration:* ${profile.avg_duration_days.toFixed(2)} days
- *Avg. Utilization:* ${profile.avg_used_pct.toFixed(2)}%
  `;

  const performance = `
*Performance*
- *Trades:* ${profile.total_trades} in ${profile.currencies_traded} currencies 
- *Total Profit:* $${profile.total_profit_usd.toFixed(2)}
- *APR:* ${profile.apr_pct.toFixed(2)}%
- *Biggest Trade Profit:* $${profile.biggest_single_trade_profit_usd.toFixed(2)}
- *Last Trade Date:* ${profile.latest_profit_date ? new Date(profile.latest_profit_date).toDateString() : 'N/A'}
  `;

  const platforms = `
*Platforms*
- *Revolut:* ${profile.revolut_trades} trades, $${profile.revolut_profit.toFixed(2)} profit
- *Wise:* ${profile.wise_trades} trades, $${profile.wise_profit.toFixed(2)} profit
- *PayPal:* ${profile.paypal_trades} trades, $${profile.paypal_profit.toFixed(2)} profit
  `;

  return `${header}\n${vault}${performance}${platforms}\n`;
}

module.exports = {
  LPProfileAnalyzer,
  initializeLPAnalyzer,
  analyzeLiquidityProvider,
  formatLPProfileForTelegram
};