require('dotenv').config({ path: __dirname + '/.env' });
const TelegramBot = require('node-telegram-bot-api');
const { searchDeposit, formatTelegramMessage } = require('./scripts/search-deposit.js');
const DatabaseManager = require('./scripts/database-manager.js');
const { supabase } = require('./config.js');
const { getExchangeRates } = require('./scripts/exchange-service.js');
const express = require('express');
const { getWeb3Service } = require('./scripts/web3-service.js')
const { startDepositMonitor } = require('./scripts/deposit-monitor.js');

// Add HTTP server for Render health checks
const app = express();
app.get('/', (req, res) => {
  res.json({
    status: 'Bot is running!',
    uptime: process.uptime(),
    websocket: web3Service?.isConnected || false
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    websocket: web3Service?.isConnected ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// Import provider and contract from config module
const { provider, escrowContract } = require('./config.js');

const depositAmounts = new Map(); // Store deposit amounts temporarily
const intentDetails = new Map();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize web3 service for blockchain interactions
let web3Service;
const initializeWeb3Service = async () => {
  try {
    web3Service = getWeb3Service(process.env.BASE_WS_URL || 'wss://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY');
    await web3Service.initialize();
    console.log('✅ Web3Service initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Web3Service:', error);
  }
};

// Initialize web3 service asynchronously
initializeWeb3Service();

// Make bot and provider available globally for web3-service notifications
global.bot = bot;
global.provider = provider;

const db = new DatabaseManager();

// Helper functions for group chat restrictions
function isGroupChat(chatType) {
  return chatType === 'group' || chatType === 'supergroup';
}

async function isUserAdmin(bot, chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

function getRestrictedMessage() {
  return '❌ This command is restricted in group chats. You can get a personal bot by searching for @zkp2p_bot .';
}

const ZKP2P_GROUP_ID = -1001928949520;
const ZKP2P_TOPIC_ID = 5385;
const ZKP2P_SNIPER_TOPIC_ID = 5671;

const initializeBot = async () => {
  try {
    console.log('🔄 Bot initialization starting...');
    
    // Test Telegram bot connection first
    try {
      const botInfo = await bot.getMe();
      console.log(`🤖 Bot connected: @${botInfo.username} (${botInfo.first_name})`);
    } catch (error) {
      console.error('❌ Failed to connect to Telegram bot:', error.message);
      throw error;
    }
    
    // Test database connection
    try {
      const { data, error } = await supabase.from('users').select('chat_id').limit(1);
      if (error) throw error;
      console.log('✅ Database connection successful');
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
    
    // Wait for all systems to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('📝 Initializing user in database...');
    await db.initUser(ZKP2P_GROUP_ID, 'zkp2p_channel');
    
    console.log('📝 Setting listen all to true...');
    await db.setUserListenAll(ZKP2P_GROUP_ID, true);
    await db.setUserThreshold(ZKP2P_GROUP_ID, 0.1);

    console.log(`📤 Attempting to send message to topic ${ZKP2P_TOPIC_ID} in group ${ZKP2P_GROUP_ID}`);

    // Test message sending with better error handling (optional)
    try {
      const result = await bot.sendMessage(ZKP2P_GROUP_ID, '🔄 Bot restarted and ready!', {
        parse_mode: 'Markdown',
        message_thread_id: ZKP2P_TOPIC_ID,
      });

      console.log('✅ Initialization message sent successfully!');
      console.log('📋 Message details:', {
        message_id: result.message_id,
        chat_id: result.chat.id,
        thread_id: result.message_thread_id,
        is_topic_message: result.is_topic_message
      });
    } catch (telegramError) {
      console.log('⚠️ Could not send initialization message to group (this is optional):', telegramError.message);
      console.log('✅ Bot is still fully functional for individual users!');
    }
  // Start the deposit monitor
  startDepositMonitor(bot);
    
  } catch (err) {
    console.error('❌ Bot initialization failed:', err);
    console.error('❌ Error code:', err.code);
    console.error('❌ Error message:', err.message);
    
    if (err.response?.body) {
      console.error('❌ Telegram API response:', JSON.stringify(err.response.body, null, 2));
    }
    
    // Schedule retry
    console.log('🔄 Retrying initialization in 30 seconds...');
    setTimeout(initializeBot, 30000);
  }
};

// Start initialization after a delay
setTimeout(initializeBot, 3000);

  

// Telegram commands - now using database
bot.onText(/\/deposit (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  // Initialize user
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  if (input === 'all') {
    await db.setUserListenAll(chatId, true);
    bot.sendMessage(chatId, `🌍 *Now listening to ALL deposits!*\n\nYou will receive notifications for every event on every deposit.\n\nUse \`/deposit stop\` to stop listening to all deposits.`, { parse_mode: 'Markdown' });
    return;
  }

  if (input === 'stop') {
    await db.setUserListenAll(chatId, false);
    bot.sendMessage(chatId, `🛑 *Stopped listening to all deposits.*\n\nYou will now only receive notifications for specifically tracked deposits.`, { parse_mode: 'Markdown' });
    return;
  }
  
  const newIds = input.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (newIds.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use:\n• \`/deposit all\` - Listen to all deposits\n• \`/deposit 123\` - Track specific deposit\n• \`/deposit 123,456,789\` - Track multiple deposits`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Check if this is a group chat and user is not admin
  if (isGroupChat(msg.chat.type) && !(await isUserAdmin(bot, chatId, msg.from.id))) {
    bot.sendMessage(chatId, getRestrictedMessage());
    return;
  }

  for (const id of newIds) {
    await db.addUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  bot.sendMessage(chatId, `✅ Now tracking deposit IDs: \`${idsArray.join(', ')}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const idsString = match[1];
  const idsToRemove = idsString.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (idsToRemove.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use: /remove 123 or /remove 123,456,789`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Check if this is a group chat and user is not admin
  if (isGroupChat(msg.chat.type) && !(await isUserAdmin(bot, chatId, msg.from.id))) {
    bot.sendMessage(chatId, getRestrictedMessage());
    return;
  }

  for (const id of idsToRemove) {
    await db.removeUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const remainingIds = Array.from(userDeposits).sort((a, b) => a - b);
  
  if (remainingIds.length > 0) {
    bot.sendMessage(chatId, `✅ Removed specified IDs. Still tracking: \`${remainingIds.join(', ')}\``, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `✅ Removed specified IDs. No deposits being tracked.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const userDeposits = await db.getUserDeposits(chatId);
  const userStates = await db.getUserDepositStates(chatId);
  const listeningAll = await db.getUserListenAll(chatId);
  const snipers = await db.getUserSnipers(chatId);
  
  let message = '';
    
  // Check if this is a group chat and user is not admin
  if (isGroupChat(msg.chat.type) && !(await isUserAdmin(bot, chatId, msg.from.id))) {
    bot.sendMessage(chatId, getRestrictedMessage());
    return;
  }

  
  if (listeningAll) {
    message += `🌍 *Listening to ALL deposits*\n\n`;
  }
  
  if (snipers.length > 0) {
    message += `🎯 *Active Snipers:*\n`;
    snipers.forEach(sniper => {
      const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
      message += `• ${sniper.currency}${platformText}\n`;
    });
    message += `\n`;
  }
  
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  if (idsArray.length === 0 && !listeningAll && snipers.length === 0) {
    bot.sendMessage(chatId, `📋 No deposits currently being tracked and no snipers set.`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (idsArray.length > 0) {
    message += `📋 *Specifically tracking ${idsArray.length} deposits:*\n\n`;
    idsArray.forEach(id => {
      const state = userStates.get(id);
      const status = state ? state.status : 'tracking';
      const emoji = status === 'fulfilled' ? '✅' : 
                    status === 'pruned' ? '🟠' : '👀';
      message += `${emoji} \`${id}\` - ${status}\n`;
    });
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/clearall/, async (msg) => {
  const chatId = msg.chat.id;

  // Check if this is a group chat and user is not admin
  if (isGroupChat(msg.chat.type) && !(await isUserAdmin(bot, chatId, msg.from.id))) {
    bot.sendMessage(chatId, getRestrictedMessage());
    return;
  }

  await db.clearUserData(chatId);
  bot.sendMessage(chatId, `🗑️ Cleared all tracked deposit IDs, stopped listening to all deposits, and cleared all sniper settings.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const wsConnected = web3Service?.isConnected || false;
    const wsStatus = wsConnected ? '🟢 Connected' : '🔴 Disconnected';

    // Test database connection
    let dbStatus = '🔴 Disconnected';
    try {
      const { data, error } = await supabase.from('users').select('chat_id').limit(1);
      if (!error) dbStatus = '🟢 Connected';
    } catch (error) {
      console.error('Database test failed:', error);
    }

    // Test Telegram connection
    let botStatus = '🔴 Disconnected';
    try {
      await bot.getMe();
      botStatus = '🟢 Connected';
    } catch (error) {
      console.error('Bot test failed:', error);
    }

    const listeningAll = await db.getUserListenAll(chatId);
    const trackedCount = (await db.getUserDeposits(chatId)).size;
    const snipers = await db.getUserSnipers(chatId);

    let message = `🔧 *System Status:*\n\n`;
    message += `• *WebSocket:* ${wsStatus}\n`;
    message += `• *Database:* ${dbStatus}\n`;
    message += `• *Telegram:* ${botStatus}\n\n`;
    message += `📊 *Your Settings:*\n`;

    if (listeningAll) {
      message += `• *Listening to:* ALL deposits\n`;
    } else {
      message += `• *Tracking:* ${trackedCount} specific deposits\n`;
    }

    if (snipers.length > 0) {
      message += `• *Sniping:* `;
      const sniperTexts = snipers.map(sniper => {
        const platformText = sniper.platform ? ` on ${sniper.platform}` : '';
        return `${sniper.currency}${platformText}`;
      });
      message += `${sniperTexts.join(', ')}\n`;
    }

    // Add reconnection info if disconnected
    if (!wsConnected && web3Service) {
      // Note: We don't expose reconnectAttempts in the current web3Service API
      message += `\n⚠️ *WebSocket:* Disconnected`;
    }

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Status command failed:', error);
    bot.sendMessage(chatId, '❌ Failed to get status', { parse_mode: 'Markdown' });
  }
});

// Sniper commands

bot.onText(/\/sniper threshold (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  const threshold = parseFloat(input);
  
  if (isNaN(threshold)) {
    bot.sendMessage(chatId, `❌ Invalid threshold. Please provide a number (e.g., 0.5 for 0.5%)`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Check if this is a group chat and user is not admin
  if (isGroupChat(msg.chat.type) && !(await isUserAdmin(bot, chatId, msg.from.id))) {
    bot.sendMessage(chatId, getRestrictedMessage());
    return;
  }

  await db.setUserThreshold(chatId, threshold);
  
  bot.sendMessage(chatId, `🎯 *Sniper threshold set to ${threshold}%*\n\nYou'll now be alerted when deposits offer rates ${threshold}% or better than market rates.`, { parse_mode: 'Markdown' });
});


bot.onText(/\/sniper (?!threshold)(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  if (input === 'list') {
    const snipers = await db.getUserSnipers(chatId);
    if (snipers.length === 0) {
      bot.sendMessage(chatId, `🎯 No sniper currencies set.`, { parse_mode: 'Markdown' });
    } else {
      let message = `🎯 *Active Snipers:*\n\n`;
      snipers.forEach(sniper => {
        const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
        message += `• ${sniper.currency}${platformText}\n`;
      });
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    return;
  }
    
  
  if (input === 'clear') {
    await db.removeUserSniper(chatId);
    bot.sendMessage(chatId, `🎯 Cleared all sniper settings.`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Parse input: "eur" or "eur revolut"
  const parts = input.split(' ');
  const currency = parts[0].toUpperCase();
  const platform = parts[1] ? parts[1].toLowerCase() : null;
  
  const supportedCurrencies = Object.values(currencyHashToCode);
  const supportedPlatforms = ['revolut', 'wise', 'cashapp', 'venmo', 'zelle', 'mercadopago', 'monzo','paypal'];
  
  if (!supportedCurrencies.includes(currency)) {
    bot.sendMessage(chatId, `❌ Currency '${currency}' not supported.\n\n*Supported currencies:*\n${supportedCurrencies.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (platform && !supportedPlatforms.includes(platform)) {
    bot.sendMessage(chatId, `❌ Platform '${platform}' not supported.\n\n*Supported platforms:*\n${supportedPlatforms.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }
  
  // Check if this is a group chat and user is not admin
  if (isGroupChat(callbackQuery.message.chat.type) && !(await isUserAdmin(bot, chatId, callbackQuery.from.id))) {
    bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This command is restricted in group chats. Only group administrators can perform database write operations.' });
    return;
  }

  await db.setUserSniper(chatId, currency, platform);
  
  const platformText = platform ? ` on ${platform}` : ' (all platforms)';
  bot.sendMessage(chatId, `🎯 *Sniper activated for ${currency}${platformText}!*\n\nYou'll be alerted when new deposits offer better rates than market.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/unsnipe (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  // Parse input: "eur" or "eur revolut"
  const parts = input.split(' ');
  const currency = parts[0].toUpperCase();
  const platform = parts[1] ? parts[1].toLowerCase() : null;
  
  // Check if this is a group chat and user is not admin
  if (isGroupChat(callbackQuery.message.chat.type) && !(await isUserAdmin(bot, chatId, callbackQuery.from.id))) {
    bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This command is restricted in group chats. Only group administrators can perform database write operations.' });
    return;
  }

  await db.removeUserSniper(chatId, currency, platform);
  
  const platformText = platform ? ` on ${platform}` : ' (all platforms)';
  bot.sendMessage(chatId, `🎯 Stopped sniping ${currency}${platformText}.`, { parse_mode: 'Markdown' });
});

// Menu creation functions
const createMainMenu = () => {
  return {
    inline_keyboard: [
      [
        { text: '📊 Deposit Tracking', callback_data: 'menu_deposits' },
        { text: '🎯 Sniper Setup', callback_data: 'menu_snipers' }
      ],
      [
        { text: '📋 My Status', callback_data: 'action_list' },
        { text: '🔧 Settings', callback_data: 'menu_settings' }
      ],
      [
        { text: '❓ Help', callback_data: 'action_help' },
        { text: '📈 System Status', callback_data: 'action_status' }
      ]
    ]
  };
};

const createDepositMenu = () => {
  return {
    inline_keyboard: [
      [
        { text: '🌐 Listen to ALL Deposits', callback_data: 'action_deposit_all' }
      ],
      [
        { text: '🛑 Stop Listening to All', callback_data: 'action_deposit_stop' }
      ],
      [
        { text: '🔍 Search Specific Deposit', callback_data: 'prompt_deposit_search' }
      ],
      [
        { text: '➕ Track Specific Deposit', callback_data: 'prompt_deposit_add' }
      ],
      [
        { text: '➖ Remove Specific Deposit', callback_data: 'prompt_deposit_remove' }
      ],
      [
        { text: '🏠 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
};

const createSniperMenu = () => {
  return {
    inline_keyboard: [
      [
        { text: '🎯 Add Currency Sniper', callback_data: 'prompt_sniper_add' }
      ],
      [
        { text: '📊 Set Alert Threshold', callback_data: 'prompt_threshold' }
      ],
      [
        { text: '📋 View My Snipers', callback_data: 'action_sniper_list' }
      ],
      [
        { text: '🗑️ Remove Sniper', callback_data: 'prompt_sniper_remove' }
      ],
      [
        { text: '🧹 Clear All Snipers', callback_data: 'action_sniper_clear' }
      ],
      [
        { text: '🏠 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
};

const createSettingsMenu = () => {
  return {
    inline_keyboard: [
      [
        { text: '🗑️ Clear All Data', callback_data: 'confirm_clearall' }
      ],
      [
        { text: '🔄 Refresh Status', callback_data: 'action_status' }
      ],
      [
        { text: '🏠 Back to Main Menu', callback_data: 'menu_main' }
      ]
    ]
  };
};

const createCurrencyKeyboard = () => {
  const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'ARS', 'NOK', 'DKK', 'PLN', 'CZK', 'NZD', 'RON'];
  const keyboard = [];
  
  // Create rows of 3 currencies each
  for (let i = 0; i < currencies.length; i += 3) {
    const row = currencies.slice(i, i + 3).map(curr => ({
      text: curr,
      callback_data: `select_currency_${curr.toLowerCase()}`
    }));
    keyboard.push(row);
  }
  
  // Add more currencies and cancel buttons
  keyboard.push([
    { text: '🌍 More Currencies', callback_data: 'show_more_currencies' },
    { text: '❌ Cancel', callback_data: 'menu_snipers' }
  ]);
  
  return { inline_keyboard: keyboard };
};

const createPlatformKeyboard = (currency) => {
  return {
    inline_keyboard: [
      [
        { text: '🌐 All Platforms', callback_data: `sniper_${currency}_all` }
      ],
      [
        { text: '💳 Revolut', callback_data: `sniper_${currency}_revolut` },
        { text: '🏦 Wise', callback_data: `sniper_${currency}_wise` }
      ],
      [
        { text: '💰 PayPal', callback_data: `sniper_${currency}_paypal` },
        { text: '🏪 Zelle', callback_data: `sniper_${currency}_zelle` }
      ],
      [
        { text: '📱 CashApp', callback_data: `sniper_${currency}_cashapp` },
        { text: '💸 Venmo', callback_data: `sniper_${currency}_venmo` }
      ],
      [
        { text: '🏦 Mercado Pago', callback_data: `sniper_${currency}_mercadopago` },
        { text: '💸 Monzo', callback_data: `sniper_${currency}_monzo` }
      ],
      [
      { text: '💸 PayPal', callback_data: `sniper_${currency}_paypal` }
      ],
      [
        { text: '🔙 Back to Currencies', callback_data: 'prompt_sniper_add' }
      ]
    ]
  };
};

const createConfirmKeyboard = (action) => {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, Confirm', callback_data: `confirm_${action}` },
        { text: '❌ Cancel', callback_data: 'menu_main' }
      ]
    ]
  };
};

// Store user states for multi-step interactions
const userStates = new Map();

// Update the /start command to show the main menu
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  const welcomeMessage = `
🤖 **Welcome to ZKP2P Tracker!**

Track ZKP2P deposits and get arbitrage alerts in real-time. Use the menu below to get started:

• **Deposit Tracking** - Monitor specific deposits or all activity
• **Sniper Setup** - Get alerts for profitable arbitrage opportunities  
• **My Status** - View your current tracking settings
• **Settings** - Configure thresholds and manage your data

Choose an option below to begin:
`.trim();

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

// Add /menu command for easy access
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, '📋 **ZKP2P Monitoring Bot**\n\nHow may I assist you?', {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

// Handle callback queries (button presses)
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  
  // Initialize user
  await db.initUser(chatId, callbackQuery.from.username, callbackQuery.from.first_name, callbackQuery.from.last_name);

  try {
    // Handle menu navigation
    if (data === 'menu_main') {
      await bot.editMessageText('📋 **Main Menu**\n\nChoose what you\'d like to do:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createMainMenu()
      });
    }
    
    else if (data === 'menu_deposits') {
      await bot.editMessageText('📊 **Deposit Tracking**\n\nManage your deposit notifications:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });
    }
    
    else if (data === 'menu_snipers') {
      await bot.editMessageText('🎯 **Sniper Setup**\n\nConfigure arbitrage alerts for better exchange rates:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSniperMenu()
      });
    }
    
    else if (data === 'menu_settings') {
      await bot.editMessageText('🔧 **Settings**\n\nManage your bot configuration:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSettingsMenu()
      });
    }

    // Handle deposit actions
    else if (data === 'action_deposit_all') {
      await db.setUserListenAll(chatId, true);
      await bot.editMessageText('🌐 **Now listening to ALL deposits!**\n\nYou will receive notifications for every event on every deposit.\n\nUse the menu to manage other settings.', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });
    }
    
    else if (data === 'action_deposit_stop') {
      await db.setUserListenAll(chatId, false);
      await bot.editMessageText('🛑 **Stopped listening to all deposits.**\n\nYou will now only receive notifications for specifically tracked deposits.', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });
    }

    else if (data === 'prompt_deposit_search') {
      userStates.set(chatId, { action: 'waiting_search_add', messageId });
      await bot.editMessageText('🔍 **Search info about a Deposit**\n\n**Please send the deposit ID below.**\n\nYou can also use the command `/searchdeposit <id>` to search information about a specific deposit:\n\nExamples:\n`123` - search for deposit 123\nOr\n/searchdeposit 123\n', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancel', callback_data: 'menu_deposits' }
          ]]
        }
      });
    }

    // Handle prompts for user input
    else if (data === 'prompt_deposit_add') {
      userStates.set(chatId, { action: 'waiting_deposit_add', messageId });
      await bot.editMessageText('➕ **Add Specific Deposit**\n\nPlease send the deposit ID(s) you want to track.\n\nExamples:\n• `123` - track single deposit\n• `123,456,789` - track multiple deposits\n\nSend your message now:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancel', callback_data: 'menu_deposits' }
          ]]
        }
      });
    }
    
    else if (data === 'prompt_deposit_remove') {
      userStates.set(chatId, { action: 'waiting_deposit_remove', messageId });
      await bot.editMessageText('➖ **Remove Tracking**\n\nPlease send the deposit ID(s) you want to stop tracking.\n\nExamples:\n• `123` - remove single deposit\n• `123,456,789` - remove multiple deposits\n\nSend your message now:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancel', callback_data: 'menu_deposits' }
          ]]
        }
      });
    }

    // Handle sniper actions
    else if (data === 'prompt_sniper_add') {
      await bot.editMessageText('🎯 **Add Currency Sniper**\n\nSelect a currency to snipe for arbitrage opportunities:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createCurrencyKeyboard()
      });
    }

    else if (data === 'show_more_currencies') {
      const moreCurrencies = ['AED', 'CNY', 'SEK', 'ILS', 'INR', 'KES', 'MXN', 'HKD', 'MYR', 'PHP', 'SAR', 'SGD', 'HUF', 'THB', 'TRY', 'VND', 'IDR', 'ZAR'];
      const keyboard = [];
      
      for (let i = 0; i < moreCurrencies.length; i += 3) {
        const row = moreCurrencies.slice(i, i + 3).map(curr => ({
          text: curr,
          callback_data: `select_currency_${curr.toLowerCase()}`
        }));
        keyboard.push(row);
      }
      
      keyboard.push([
        { text: '🔙 Back', callback_data: 'prompt_sniper_add' },
        { text: '❌ Cancel', callback_data: 'menu_snipers' }
      ]);

      await bot.editMessageText('🌍 **More Currencies**\n\nSelect a currency:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    // Handle currency selection
    else if (data.startsWith('select_currency_')) {
      const currency = data.replace('select_currency_', '').toUpperCase();
      await bot.editMessageText(`🎯 **Snipe ${currency}**\n\nChoose which platform(s) to monitor for ${currency} arbitrage opportunities:`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createPlatformKeyboard(currency.toLowerCase())
      });
    }

    // Handle sniper setup
    else if (data.startsWith('sniper_')) {
      const parts = data.split('_');
      const currency = parts[1].toUpperCase();
      const platform = parts[2] === 'all' ? null : parts[2];
      
      await db.setUserSniper(chatId, currency, platform);
      
      const platformText = platform ? ` on ${platform}` : ' (all platforms)';
      await bot.editMessageText(`🎯 **Sniper activated for ${currency}${platformText}!**\n\nYou'll be alerted when new deposits offer better rates than market.\n\nConfigure more settings below:`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSniperMenu()
      });
    }

    else if (data === 'prompt_threshold') {
      userStates.set(chatId, { action: 'waiting_threshold', messageId });
      const currentThreshold = await db.getUserThreshold(chatId);
      await bot.editMessageText(`📊 **Set Alert Threshold**\n\nCurrent threshold: **${currentThreshold}%**\n\nEnter your new threshold percentage (e.g., 0.5 for 0.5%):\n\n*You'll be alerted when deposits offer rates this much better than market rates.*\n\nSend your message now:`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancel', callback_data: 'menu_snipers' }
          ]]
        }
      });
    }

    else if (data === 'action_sniper_list') {
      const snipers = await db.getUserSnipers(chatId);
      if (snipers.length === 0) {
        await bot.editMessageText('🎯 **No Sniper Currencies Set**\n\nYou haven\'t configured any currency snipers yet.', {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: createSniperMenu()
        });
      } else {
        let message = `🎯 **Active Snipers:**\n\n`;
        snipers.forEach(sniper => {
          const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
          message += `• ${sniper.currency}${platformText}\n`;
        });
        
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: createSniperMenu()
        });
      }
    }

    else if (data === 'prompt_sniper_remove') {
      userStates.set(chatId, { action: 'waiting_sniper_remove', messageId });
      await bot.editMessageText('🗑️ **Remove Sniper**\n\nEnter the currency (and optionally platform) to remove:\n\nExamples:\n• `EUR` - remove EUR from all platforms\n• `EUR revolut` - remove EUR only from Revolut\n\nSend your message now:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancel', callback_data: 'menu_snipers' }
          ]]
        }
      });
    }

    else if (data === 'action_sniper_clear') {
      await bot.editMessageText('🧹 **Clear All Snipers**\n\nAre you sure you want to remove ALL sniper configurations?', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createConfirmKeyboard('sniper_clear_confirmed')
      });
    }

    // Handle list action
    else if (data === 'action_list') {
      const userDeposits = await db.getUserDeposits(chatId);
      const userStates = await db.getUserDepositStates(chatId);
      const listeningAll = await db.getUserListenAll(chatId);
      const snipers = await db.getUserSnipers(chatId);
      const threshold = await db.getUserThreshold(chatId);
      
      let message = '📋 **Your Current Status:**\n\n';
      
      if (listeningAll) {
        message += `🌐 **Listening to ALL deposits**\n\n`;
      }
      
      if (snipers.length > 0) {
        message += `🎯 **Active Snipers:** (${threshold}% threshold)\n`;
        snipers.forEach(sniper => {
          const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
          message += `• ${sniper.currency}${platformText}\n`;
        });
        message += `\n`;
      }
      
      const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
      if (idsArray.length > 0) {
        message += `📊 **Tracking ${idsArray.length} specific deposits:**\n\n`;
        idsArray.slice(0, 10).forEach(id => { // Show max 10
          const state = userStates.get(id);
          const status = state ? state.status : 'tracking';
          const emoji = status === 'fulfilled' ? '✅' : 
                        status === 'pruned' ? '🟡' : '👀';
          message += `${emoji} \`${id}\` - ${status}\n`;
        });
        
        if (idsArray.length > 10) {
          message += `\n... and ${idsArray.length - 10} more\n`;
        }
      }
      
      if (idsArray.length === 0 && !listeningAll && snipers.length === 0) {
        message += `No active tracking or snipers configured.`;
      }

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createMainMenu()
      });
    }

    // Handle help action
    else if (data === 'action_help') {
      const helpMessage = `
🤖 **ZKP2P Tracker Help**

**🔹 Deposit Tracking:**
• Track specific deposit IDs for targeted notifications
• Listen to ALL deposits for complete market monitoring
• Get real-time alerts for order creation, fulfillment, and cancellation

**🔹 Sniper Alerts:**
• Monitor specific currencies for arbitrage opportunities
• Set custom profit thresholds (default 0.2%)
• Choose specific platforms or monitor all
• Get instant alerts when profitable rates appear

**🔹 Example Scenarios:**
• Track deposit #123 to see when orders are filled
• Snipe EUR on Revolut for arbitrage opportunities
• Listen to all deposits to monitor market activity
• Set 0.5% threshold to only see highly profitable opportunities

**🔹 Commands Available:**
You can still use text commands if preferred:
• \`/deposit 123\` - Track specific deposit
• \`/sniper eur revolut\` - Snipe EUR on Revolut
• \`/list\` - Show current status
• \`/menu\` - Show this menu anytime

Questions? The menu system makes everything easier! 🚀
`.trim();

      await bot.editMessageText(helpMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createMainMenu()
      });
    }

    // Handle status action  
    else if (data === 'action_status') {
      const wsConnected = web3Service?.isConnected || false;
      const wsStatus = wsConnected ? '🟢 Connected' : '🔴 Disconnected';
      
      let dbStatus = '🔴 Disconnected';
      try {
        const { data, error } = await supabase.from('users').select('chat_id').limit(1);
        if (!error) dbStatus = '🟢 Connected';
      } catch (error) {
        console.error('Database test failed:', error);
      }
      
      let botStatus = '🔴 Disconnected';
      try {
        await bot.getMe();
        botStatus = '🟢 Connected';
      } catch (error) {
        console.error('Bot test failed:', error);
      }
      
      let message = `🔧 **System Status:**\n\n`;
      message += `• **WebSocket:** ${wsStatus}\n`;
      message += `• **Database:** ${dbStatus}\n`;
      message += `• **Telegram:** ${botStatus}\n\n`;
      
      if (!wsConnected && web3Service) {
        message += `⚠️ **WebSocket reconnection attempts:** ${web3Service.reconnectAttempts}/${web3Service.maxReconnectAttempts}\n\n`;
      }
      
      message += `All systems operational! 🚀`;

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createMainMenu()
      });
    }

    // Handle confirmation actions
    else if (data === 'confirm_clearall') {
      await bot.editMessageText('🗑️ **Clear All Data**\n\n⚠️ This will remove:\n• All tracked deposits\n• All sniper configurations\n• All your settings\n\nAre you absolutely sure?', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createConfirmKeyboard('clearall_confirmed')
      });
    }

    else if (data === 'confirm_clearall_confirmed') {
      // Check if this is a group chat and user is not admin
      if (isGroupChat(callbackQuery.message.chat.type) && !(await isUserAdmin(bot, chatId, callbackQuery.from.id))) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This command is restricted in group chats. Only group administrators can perform database write operations.' });
        return;
      }
  
      await db.clearUserData(chatId);
      await bot.editMessageText('🗑️ **All Data Cleared**\n\nCleared all tracked deposit IDs, stopped listening to all deposits, and cleared all sniper settings.\n\nYou can start fresh now!', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createMainMenu()
      });
    }

    else if (data === 'confirm_sniper_clear_confirmed') {
      await db.removeUserSniper(chatId);
      await bot.editMessageText('🧹 **All Snipers Cleared**\n\nRemoved all sniper configurations. You can set up new ones anytime.', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSniperMenu()
      });
    }

    // Answer the callback query to remove loading state
    await bot.answerCallbackQuery(callbackQuery.id);

  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ An error occurred. Please try again.' });
  }
});

// Handle text messages based on user state
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Skip if it's a command (already handled)
  if (text?.startsWith('/')) return;
  
  const userState = userStates.get(chatId);
  if (!userState) return;
  
  const { action, messageId } = userState;
  
  try {
    if (action === 'waiting_deposit_add') {
      const newIds = text.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      
      if (newIds.length === 0) {
        bot.sendMessage(chatId, '❌ No valid deposit IDs provided. Please try again with numbers only.', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔙 Back to Menu', callback_data: 'menu_deposits' }
            ]]
          }
        });
        return;
      }
      
      for (const id of newIds) {
        await db.addUserDeposit(chatId, id);
      }
      
      const userDeposits = await db.getUserDeposits(chatId);
      const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
      
      // Update the original menu message
      await bot.editMessageText(`✅ **Successfully Added!**\n\nNow tracking deposit IDs: \`${idsArray.join(', ')}\`\n\nYou'll receive notifications for all events on these deposits.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });
      
      // Delete user's input message
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }
    }

    else if (action === 'waiting_search_add') {
      const newIds = text.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));

      if (newIds.length === 0) {
        bot.sendMessage(chatId, '❌ No valid deposit IDs provided. Please try again with numbers only.', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔙 Back to Menu', callback_data: 'menu_deposits' }
            ]]
          }
        });
        return;
      }

      // Update the original menu message to show searching
      await bot.editMessageText('🔍 **Searching Deposits...**\n\nPlease wait while I search for the deposit information.', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });

      // Show typing indicator while processing
      await bot.sendChatAction(chatId, 'typing');

      for (const id of newIds) {
        try {
          const result = await searchDeposit(id);
          const message = await formatTelegramMessage(result);
          await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
          console.error('Error searching deposit:', error);
          await bot.sendMessage(chatId, `❌ Error searching deposit ${id}: ${error.message}`, { parse_mode: 'Markdown' });
        }
      }

      // Show completed search message
      await bot.sendMessage(chatId, '🔍 **Search Complete**\n\nAll deposit information has been retrieved.', {
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });

      // Delete user's input message
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }
    }
    
    else if (action === 'waiting_deposit_remove') {
      const idsToRemove = text.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      
      if (idsToRemove.length === 0) {
        bot.sendMessage(chatId, '❌ No valid deposit IDs provided. Please try again with numbers only.', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔙 Back to Menu', callback_data: 'menu_deposits' }
            ]]
          }
        });
        return;
      }
      
      for (const id of idsToRemove) {
        await db.removeUserDeposit(chatId, id);
      }
      
      const userDeposits = await db.getUserDeposits(chatId);
      const remainingIds = Array.from(userDeposits).sort((a, b) => a - b);
      
      let message = '✅ **Successfully Removed!**\n\n';
      if (remainingIds.length > 0) {
        message += `Still tracking: \`${remainingIds.join(', ')}\``;
      } else {
        message += `No deposits currently being tracked.`;
      }
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createDepositMenu()
      });
      
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }
    }
    
    else if (action === 'waiting_threshold') {
      const threshold = parseFloat(text.trim());
      
      if (isNaN(threshold)) {
        bot.sendMessage(chatId, '❌ Invalid threshold. Please provide a number (e.g., 0.5 for 0.5%)', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔙 Back to Menu', callback_data: 'menu_snipers' }
            ]]
          }
        });
        return;
      }
      
      await db.setUserThreshold(chatId, threshold);
      
      await bot.editMessageText(`📊 **Threshold Updated!**\n\nSniper threshold set to **${threshold}%**\n\nYou'll now be alerted when deposits offer rates ${threshold}% or better than market rates.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSniperMenu()
      });
      
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }
    }
    
    else if (action === 'waiting_sniper_remove') {
      const parts = text.trim().toLowerCase().split(' ');
      const currency = parts[0].toUpperCase();
      const platform = parts[1] ? parts[1].toLowerCase() : null;
      
      await db.removeUserSniper(chatId, currency, platform);
      
      const platformText = platform ? ` on ${platform}` : ' (all platforms)';
      
      await bot.editMessageText(`✅ **Sniper Removed!**\n\nStopped sniping ${currency}${platformText}.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: createSniperMenu()
      });
      
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        // Ignore if can't delete
      }
    }
    
    // Clear user state after handling
    userStates.delete(chatId);
    
      } catch (error) {
    console.error('Error handling user input:', error);
    bot.sendMessage(chatId, '❌ An error occurred. Please try again.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Back to Menu', callback_data: 'menu_main' }
        ]]
      }
    });
    userStates.delete(chatId);
  }
});

// Enhanced notification messages to include menu options
const createDepositKeyboard = (depositId) => {
  return {
    inline_keyboard: [
      [
        {
          text: `🔗 View Deposit ${depositId}`,
          url: depositLink(depositId)
        }
      ],
      [
        {
          text: '⚙️ Manage Tracking',
          callback_data: 'menu_deposits'
        }
      ]
    ]
  };
};

// Update the existing help command to redirect to menu
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, '❓ **Need Help?**\n\nUse the interactive menu below for easy navigation, or type `/menu` anytime to access it.', {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

// Add persistent menu command
bot.onText(/\/quickmenu/, (msg) => {
  const chatId = msg.chat.id;
  
  const quickMenuKeyboard = {
    keyboard: [
      ['📊 Deposits', '🎯 Snipers'],
      ['📋 Status', '⚙️ Settings'],
      ['🔧 System', '❓ Help']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
  
  bot.sendMessage(chatId, '🎛️ **Quick Access Menu**\n\nUse these buttons for quick access to main functions:', {
    parse_mode: 'Markdown',
    reply_markup: quickMenuKeyboard
  });
});

// Handle persistent menu button presses
bot.onText(/^📊 Deposits$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📊 **Deposit Tracking**\n\nManage your deposit notifications:', {
    parse_mode: 'Markdown',
    reply_markup: createDepositMenu()
  });
});

bot.onText(/^🎯 Snipers$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🎯 **Sniper Setup**\n\nConfigure arbitrage alerts:', {
    parse_mode: 'Markdown',
    reply_markup: createSniperMenu()
  });
});

bot.onText(/^📋 Status$/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Reuse the existing /list functionality
  const userDeposits = await db.getUserDeposits(chatId);
  const userStatesMap = await db.getUserDepositStates(chatId);
  const listeningAll = await db.getUserListenAll(chatId);
  const snipers = await db.getUserSnipers(chatId);
  const threshold = await db.getUserThreshold(chatId);
  
  let message = '📋 **Your Current Status:**\n\n';
  
  if (listeningAll) {
    message += `🌐 **Listening to ALL deposits**\n\n`;
  }
  
  if (snipers.length > 0) {
    message += `🎯 **Active Snipers:** (${threshold}% threshold)\n`;
    snipers.forEach(sniper => {
      const platformText = sniper.platform ? ` on ${sniper.platform}` : ' (all platforms)';
      message += `• ${sniper.currency}${platformText}\n`;
    });
    message += `\n`;
  }
  
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  if (idsArray.length > 0) {
    message += `📊 **Tracking ${idsArray.length} specific deposits:**\n\n`;
    idsArray.slice(0, 10).forEach(id => {
      const state = userStatesMap.get(id);
      const status = state ? state.status : 'tracking';
      const emoji = status === 'fulfilled' ? '✅' : 
                    status === 'pruned' ? '🟡' : '👀';
      message += `${emoji} \`${id}\` - ${status}\n`;
    });
    
    if (idsArray.length > 10) {
      message += `\n... and ${idsArray.length - 10} more\n`;
    }
  }
  
  if (idsArray.length === 0 && !listeningAll && snipers.length === 0) {
    message += `No active tracking or snipers configured.\n\nUse the menu below to get started!`;
  }

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

bot.onText(/^⚙️ Settings$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '⚙️ **Settings**\n\nManage your bot configuration:', {
    parse_mode: 'Markdown',
    reply_markup: createSettingsMenu()
  });
});

bot.onText(/^🔧 System$/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Reuse the existing /status functionality
  const wsConnected = web3Service?.isConnected || false;
  const wsStatus = wsConnected ? '🟢 Connected' : '🔴 Disconnected';
  
  let dbStatus = '🔴 Disconnected';
  try {
    const { data, error } = await supabase.from('users').select('chat_id').limit(1);
    if (!error) dbStatus = '🟢 Connected';
  } catch (error) {
    console.error('Database test failed:', error);
  }
  
  let botStatus = '🔴 Disconnected';
  try {
    await bot.getMe();
    botStatus = '🟢 Connected';
  } catch (error) {
    console.error('Bot test failed:', error);
  }
  
  let message = `🔧 **System Status:**\n\n`;
  message += `• **WebSocket:** ${wsStatus}\n`;
  message += `• **Database:** ${dbStatus}\n`;
  message += `• **Telegram:** ${botStatus}\n\n`;
  
  if (!wsConnected && web3Service) {
    message += `⚠️ **WebSocket reconnection attempts:** ${web3Service.reconnectAttempts}/${web3Service.maxReconnectAttempts}\n\n`;
  }
  
  message += `All systems operational! 🚀`;

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

bot.onText(/^❓ Help$/, (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `
🤖 **ZKP2P Tracker Help**

**🔹 Deposit Tracking:**
• Track specific deposit IDs for targeted notifications  
• Listen to ALL deposits for complete market monitoring
• Get real-time alerts for order creation, fulfillment, and cancellation

**🔹 Sniper Alerts:**
• Monitor specific currencies for arbitrage opportunities
• Set custom profit thresholds (default 0.2%)
• Choose specific platforms or monitor all
• Get instant alerts when profitable rates appear

**🔹 Example Scenarios:**
• Track deposit #123 to see when orders are filled
• Snipe EUR on Revolut for arbitrage opportunities  
• Listen to all deposits to monitor market activity
• Set 0.5% threshold to only see highly profitable opportunities

**🔹 Available Commands:**
• \`/menu\` - Show interactive menu (recommended)
• \`/quickmenu\` - Show persistent button menu
• \`/deposit 123\` - Track specific deposit
• \`/sniper eur revolut\` - Snipe EUR on Revolut
• \`/list\` - Show current status
• \`/status\` - Check system status
• \`/clearall\` - Reset all settings

**🔹 Pro Tips:**
• Use the menu system for easier navigation
• Set reasonable thresholds (0.1-1%) for sniper alerts
• Monitor multiple currencies for more opportunities
• Track specific deposits for important transactions

Questions? The interactive menus make everything easier! 🚀
`.trim();

  bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    reply_markup: createMainMenu()
  });
});

// Add command to remove persistent keyboard
bot.onText(/^\/hidemenu$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '👋 Persistent menu hidden.\n\nUse `/menu` or `/quickmenu` anytime to access the interactive menus.', {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true }
  });
});

// Auto-show menu for new users or when they seem lost
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.toLowerCase();
  
  // Skip if it's a command or callback response
  if (text?.startsWith('/') || userStates.has(chatId)) return;
  
  // Show menu if user sends common confused messages
  const confusedPhrases = ['menu', '/', 'commands', 'start'];
  
  if (confusedPhrases.some(phrase => text?.includes(phrase))) {
    bot.sendMessage(chatId, '👋 **Need help?**\n\nUse the interactive menu below to easily navigate all features:', {
      parse_mode: 'Markdown',
      reply_markup: createMainMenu()
    });
  }
});

// Enhanced welcome message for group/channel usage
bot.on('new_chat_members', async (msg) => {
  // Only respond in private chats to avoid spam
  if (msg.chat.type !== 'private') return;
  
  const chatId = msg.chat.id;
  const newMembers = msg.new_chat_members;
  
  // Check if our bot was added
  const botInfo = await bot.getMe();
  const botAdded = newMembers.some(member => member.id === botInfo.id);
  
  if (botAdded) {
    setTimeout(() => {
      bot.sendMessage(chatId, `
🎉 **Welcome to ZKP2P Tracker!**

I'm here to help you track ZKP2P deposits and find arbitrage opportunities.

**Quick Start:**
• Use the menu below to get started
• Track specific deposits for notifications  
• Set up snipers for arbitrage alerts
• Monitor the entire ZKP2P ecosystem

Ready to begin?
`.trim(), {
      parse_mode: 'Markdown',
      reply_markup: createMainMenu()
    });
    }, 1000);
  }
});

console.log('✅ Interactive menu system loaded successfully!');


bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🤖 *ZKP2P Tracker Commands:*

**Deposit Tracking:**
• \`/deposit all\` - Listen to ALL deposits (every event)
• \`/deposit stop\` - Stop listening to all deposits
• \`/deposit 123\` - Track a specific deposit
• \`/deposit 123,456,789\` - Track multiple deposits
• \`/remove 123\` - Stop tracking specific deposit(s)

**Sniper (Arbitrage Alerts):**
- \`/sniper eur\` - Snipe EUR on ALL platforms
- \`/sniper eur revolut\` - Snipe EUR only on Revolut
- \`/sniper usd zelle\` - Snipe USD only on Zelle
- \`/sniper threshold 0.5\` - Set your alert threshold to 0.5%
- \`/sniper list\` - Show active sniper settings
- \`/sniper clear\` - Clear all sniper settings
- \`/unsnipe eur\` - Stop sniping EUR (all platforms)
- \`/unsnipe eur wise\` - Stop sniping EUR on Wise only

**General:**
• \`/list\` - Show all tracking status (deposits + snipers)
• \`/clearall\` - Stop all tracking and clear everything
• \`/status\` - Check WebSocket connection and settings
• \`/help\` - Show this help message

*Note: Each user has their own settings. Sniper alerts you when deposits offer better exchange rates than market!*
`.trim();
  
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Event handler function - now with sniper support
const handleContractEvent = async (log) => {
  console.log('\n📦 Raw log received:');
  console.log(log);

  try {
    const parsed = iface.parseLog({ 
      data: log.data, 
      topics: log.topics 
    });
    
    if (!parsed) {
      console.log('⚠️ Log format did not match our ABI');
      console.log('📝 Event signature:', log.topics[0]);
      
      if (log.topics.length >= 3) {
        const topicDepositId = parseInt(log.topics[2], 16);
        console.log('📊 Extracted deposit ID from topic:', topicDepositId);
        
        const interestedUsers = await db.getUsersInterestedInDeposit(topicDepositId);
        if (interestedUsers.length > 0) {
          console.log(`⚠️ Sending unrecognized event to ${interestedUsers.length} users`);
          
          const message = `
⚠️ *Unrecognized Event for Deposit*
• *Deposit ID:* \`${topicDepositId}\`
• *Event Signature:* \`${log.topics[0]}\`
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();
          
          interestedUsers.forEach(chatId => {
            const sendOptions = { 
              parse_mode: 'Markdown', 
              disable_web_page_preview: true,
              reply_markup: createDepositKeyboard(topicDepositId)
            };
            if (chatId === ZKP2P_GROUP_ID) {
              sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
            }
            bot.sendMessage(chatId, message, sendOptions);
          });
        }
      }
      return;
    }
    
    console.log('✅ Parsed log:', parsed.name);
    console.log('🔍 Args:', parsed.args);

    const { name } = parsed;

    if (name === 'IntentSignaled') {
      const { intentHash, depositId, verifier, owner, to, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;    
      const id = Number(depositId);
      const fiatCode = getFiatCode(fiatCurrency);
      const fiatAmount = ((Number(amount) / 1e6) * (Number(conversionRate) / 1e18)).toFixed(2);
      const platformName = getPlatformName(verifier);
      const formattedRate = formatConversionRate(conversionRate, fiatCode);
      
      console.log('🧪 IntentSignaled depositId:', id);
      
      intentDetails.set(intentHash.toLowerCase(), { fiatCurrency, conversionRate, verifier });
      
      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      console.log(`📤 Sending to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = `
🟡 *Order Created*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Platform:* ${platformName}
• *Owner:* \`${owner}\`
• *To:* \`${to}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Fiat Amount:* ${fiatAmount} ${fiatCode} 
• *Rate:* ${formattedRate}
• *Time:* ${formatTimestamp(timestamp)}
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();

      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
        await db.logEventNotification(chatId, id, 'signaled');
        
        const sendOptions = { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createDepositKeyboard(id)
        };
        if (chatId === ZKP2P_GROUP_ID) {
          sendOptions.message_thread_id = ZKP2P_TOPIC_ID;
        }
        bot.sendMessage(chatId, message, sendOptions);
      }
    }

if (name === 'IntentFulfilled') {
  const { intentHash, depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee } = parsed.args;
  const txHash = log.transactionHash;
  const id = Number(depositId);
  
  console.log('🧪 IntentFulfilled collected for batching - depositId:', id);
  
  // Initialize transaction data if not exists
  if (!pendingTransactions.has(txHash)) {
    pendingTransactions.set(txHash, {
      fulfilled: new Set(),
      pruned: new Set(),
      blockNumber: log.blockNumber,
      rawIntents: new Map()
    });
  }
  
  // Store the fulfillment data
  const txData = pendingTransactions.get(txHash);
  txData.fulfilled.add(intentHash.toLowerCase());
  txData.rawIntents.set(intentHash.toLowerCase(), {
    type: 'fulfilled',
    depositId: id,
    verifier,
    owner,
    to,
    amount,
    sustainabilityFee,
    verifierFee,
    intentHash
  });
  
  // Schedule processing this transaction
  scheduleTransactionProcessing(txHash);
}

if (name === 'IntentPruned') {
  const { intentHash, depositId } = parsed.args;
  const txHash = log.transactionHash;
  const id = Number(depositId);
  
  console.log('🧪 IntentPruned collected for batching - depositId:', id);
  
  // Initialize transaction data if not exists
  if (!pendingTransactions.has(txHash)) {
    pendingTransactions.set(txHash, {
      fulfilled: new Set(),
      pruned: new Set(),
      blockNumber: log.blockNumber,
      rawIntents: new Map()
    });
  }
  
  // Store the pruned data
  const txData = pendingTransactions.get(txHash);
  txData.pruned.add(intentHash.toLowerCase());
  txData.rawIntents.set(intentHash.toLowerCase(), {
    type: 'pruned',
    depositId: id,
    intentHash
  });
  
  // Schedule processing this transaction
  scheduleTransactionProcessing(txHash);
}

if (name === 'DepositWithdrawn') {
  const { depositId, depositor, amount } = parsed.args;
  const id = Number(depositId);
  
  console.log(`💸 DepositWithdrawn: ${formatUSDC(amount)} USDC from deposit ${id} by ${depositor} - ignored`);
  return;
}

if (name === 'DepositClosed') {
  const { depositId, depositor } = parsed.args;
  const id = Number(depositId);
  
  console.log(`🔒 DepositClosed: deposit ${id} by ${depositor} - ignored`);
  return;
}

if (name === 'BeforeExecution') {
  console.log(`🛠️ BeforeExecution event detected at block ${log.blockNumber}`);
  return;
}

if (name === 'UserOperationEvent') {
  const { userOpHash, sender, paymaster, nonce, success, actualGasCost, actualGasUsed } = parsed.args;
  console.log(`📡 UserOperationEvent:
  • Hash: ${userOpHash}
  • Sender: ${sender}
  • Paymaster: ${paymaster}
  • Nonce: ${nonce}
  • Success: ${success}
  • Gas Used: ${actualGasUsed}
  • Gas Cost: ${actualGasCost}
  • Block: ${log.blockNumber}`);
  return;
}

    
if (name === 'DepositCurrencyRateUpdated') {
  const { depositId, verifier, currency, conversionRate } = parsed.args;
  const id = Number(depositId);
  const fiatCode = getFiatCode(currency);
  const rate = (Number(conversionRate) / 1e18).toFixed(6);
  const platform = getPlatformName(verifier);

  console.log(`📶 DepositCurrencyRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);
  
  // Check for sniper opportunity with updated rate
  const depositAmount = await db.getDepositAmount(id);
  if (depositAmount > 0) {
    console.log(`🎯 Rechecking sniper opportunity due to rate update for deposit ${id}`);
    await checkSniperOpportunity(id, depositAmount, currency, conversionRate, verifier);
  }
}

if (name === 'DepositConversionRateUpdated') {
  const { depositId, verifier, currency, newConversionRate } = parsed.args;
  const id = Number(depositId);
  const fiatCode = getFiatCode(currency);
  const rate = (Number(newConversionRate) / 1e18).toFixed(6);
  const platform = getPlatformName(verifier);

  console.log(`📶 DepositConversionRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);
  
  // Check for sniper opportunity with updated rate
  const depositAmount = await db.getDepositAmount(id);
  if (depositAmount > 0) {
    console.log(`🎯 Rechecking sniper opportunity due to conversion rate update for deposit ${id}`);
    await checkSniperOpportunity(id, depositAmount, currency, newConversionRate, verifier);
  }
}
    
    
if (name === 'DepositReceived') {
  const { depositId, depositor, token, amount, intentAmountRange } = parsed.args;
  const id = Number(depositId);
  const usdcAmount = Number(amount);
  
  console.log(`💰 DepositReceived: ${id} with ${formatUSDC(amount)} USDC`);
  
  // Store the deposit amount for later sniper use
  await db.storeDepositAmount(id, usdcAmount);
}

    // NEW: Handle DepositCurrencyAdded for sniper functionality
  if (name === 'DepositCurrencyAdded') {
    const { depositId, verifier, currency, conversionRate } = parsed.args;  
    const id = Number(depositId);
    
    console.log('🎯 DepositCurrencyAdded detected:', id);
    
    // Get the actual deposit amount
    const depositAmount = await db.getDepositAmount(id);
    console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);
    
    // Check for sniper opportunity with real amount
    await checkSniperOpportunity(id, depositAmount, currency, conversionRate, verifier);
  }

  } catch (err) {
    console.error('❌ Failed to parse log:', err.message);
    console.log('👀 Raw log (unparsed):', log);
    console.log('📝 Topics received:', log.topics);
    console.log('📝 First topic (event signature):', log.topics[0]);
    console.log('🔄 Continuing to listen for other events...');
  }
};

// Add startup message
console.log('🤖 ZKP2P Telegram Bot Started (Supabase Integration with Auto-Reconnect + Sniper)');
console.log('🔍 Listening for contract events...');
// console.log(`📡 Contract: ${contractAddress}`);

// Improved graceful shutdown with proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`🔄 Received ${signal}, shutting down gracefully...`);

  try {
    // Stop accepting new connections
    if (web3Service) {
      await web3Service.destroy();
    }

    // Stop the Telegram bot
    if (bot) {
      console.log('🛑 Stopping Telegram bot...');
      await bot.stopPolling();
    }

    // Close database connections (if any)
    console.log('🛑 Cleaning up resources...');

    console.log('✅ Graceful shutdown completed');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

// Enhanced error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.error('Stack trace:', error.stack);

  // Attempt to restart WebSocket if it's a connection issue
  if (error.message.includes('WebSocket') || error.message.includes('ECONNRESET')) {
    console.log('🔄 Attempting to restart WebSocket due to connection error...');
    if (web3Service) {
      web3Service.restart();
    }
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);

  // Attempt to restart WebSocket if it's a connection issue
  if (reason && reason.message &&
      (reason.message.includes('WebSocket') || reason.message.includes('ECONNRESET'))) {
    console.log('🔄 Attempting to restart WebSocket due to rejection...');
    if (web3Service) {
      web3Service.restart();
    }
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Telegram Bot Message Handlers
bot.onText(/\/searchdeposit (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const depositId = parseInt(match[1]);

  try {
    // Initialize user in database
    await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);

    // Show typing indicator
    await bot.sendChatAction(chatId, 'typing');

    // Import search and formatting functions
    const { searchDeposit, formatTelegramMessage } = require('./scripts/search-deposit.js');

    // Search for deposit
    const result = await searchDeposit(depositId);

    // Format and send the message
    const message = await formatTelegramMessage(result);
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

  } catch (error) {
    console.error('Error in search deposit command:', error);
    await bot.sendMessage(chatId, `❌ Error searching deposit: ${error.message}`);
  }
});

// Health check interval
setInterval(async () => {
  if (web3Service && !web3Service.isConnected) {
    console.log('🔍 Health check: WebSocket disconnected, attempting restart...');
    await web3Service.restart();
  }
}, 120000); // Check every two minutes