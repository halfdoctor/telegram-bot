const { supabase } = require('../config');

class DatabaseManager {
  // Helper function to format timestamps for PostgreSQL (without timezone)
  _formatTimestamp(date) {
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  // Initialize user if not exists
  async initUser(chatId, username = null, firstName = null, lastName = null) {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        chat_id: chatId,
        username: username,
        first_name: firstName,
        last_name: lastName,
        last_active: new Date().toISOString()
      }, {
        onConflict: 'chat_id',
        ignoreDuplicates: false
      });

    if (error) console.error('Error initializing user:', error);
    return data;
  }

  // Get user's ACTIVE tracked deposits only
  async getUserDeposits(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits

    if (error) {
      console.error('Error fetching user deposits:', error);
      return new Set();
    }

    if (!data || data.length === 0) {
      return new Set();
    }

    return new Set(data.map(row => parseInt(row.deposit_id)));
  }

  // Get user's ACTIVE deposit states only
  async getUserDepositStates(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status, intent_hash')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits

    if (error) {
      console.error('Error fetching user deposit states:', error);
      return new Map();
    }

    if (!data || data.length === 0) {
      return new Map();
    }

    const statesMap = new Map();
    data.forEach(row => {
      statesMap.set(parseInt(row.deposit_id), {
        status: row.status,
        intentHash: row.intent_hash
      });
    });

    return statesMap;
  }

  // Add deposit for user (always creates as active)
  async addUserDeposit(chatId, depositId) {
    // Validate inputs
    if (!chatId || !depositId) {
      console.error('Error: Missing chatId or depositId');
      return false;
    }

    // Ensure depositId is a valid integer
    const depositIdInt = parseInt(depositId);
    if (isNaN(depositIdInt) || depositIdInt <= 0) {
      console.error('Error: Invalid depositId, must be a positive integer');
      return false;
    }

    try {
      // First, try to update existing record if it exists
      const { data: updateData, error: updateError } = await supabase
        .from('user_deposits')
        .update({
          status: 'tracking',
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .eq('chat_id', chatId)
        .eq('deposit_id', depositIdInt)
        .select();

      if (updateError) {
        console.error('Error updating deposit:', updateError);
        return false;
      }

      // If no rows were updated, insert a new record
      if (!updateData || updateData.length === 0) {
        const { data: insertData, error: insertError } = await supabase
          .from('user_deposits')
          .insert({
            chat_id: chatId,
            deposit_id: depositIdInt,
            status: 'tracking',
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

        if (insertError) {
          console.error('Error inserting deposit:', insertError);
          return false;
        }
      }

      console.log(`✅ Successfully added deposit ${depositIdInt} for user ${chatId}`);
      return true;

    } catch (error) {
      console.error('Error in addUserDeposit:', error);
      return false;
    }
  }

  // Remove deposit - mark as inactive instead of deleting
  async removeUserDeposit(chatId, depositId) {
    // Validate inputs
    if (!chatId || !depositId) {
      console.error('Error: Missing chatId or depositId');
      return false;
    }

    // Ensure depositId is a valid integer
    const depositIdInt = parseInt(depositId);
    if (isNaN(depositIdInt) || depositIdInt <= 0) {
      console.error('Error: Invalid depositId, must be a positive integer');
      return false;
    }

    const { data, error } = await supabase
      .from('user_deposits')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('chat_id', chatId)
      .eq('deposit_id', depositIdInt);

    if (error) {
      console.error('Error removing deposit:', error);
      return false;
    }

    console.log(`✅ Successfully removed deposit ${depositIdInt} for user ${chatId}`);
    return true;
  }

  // Update deposit status (only for active deposits)
  async updateDepositStatus(chatId, depositId, status, intentHash = null) {
    // Validate inputs
    if (!chatId || !depositId || !status) {
      console.error('Error: Missing chatId, depositId, or status');
      return false;
    }

    // Ensure depositId is a valid integer
    const depositIdInt = parseInt(depositId);
    if (isNaN(depositIdInt) || depositIdInt <= 0) {
      console.error('Error: Invalid depositId, must be a positive integer');
      return false;
    }

    const updateData = {
      status: status,
      updated_at: new Date().toISOString()
    };

    if (intentHash) {
      updateData.intent_hash = intentHash;
    }

    const { data, error } = await supabase
      .from('user_deposits')
      .update(updateData)
      .eq('chat_id', chatId)
      .eq('deposit_id', depositIdInt)
      .eq('is_active', true); // Only update active deposits

    if (error) {
      console.error('Error updating deposit status:', error);
      return false;
    }

    console.log(`✅ Successfully updated deposit ${depositIdInt} status to ${status} for user ${chatId}`);
    return true;
  }

  // Get ACTIVE listen all preference only
  async getUserListenAll(chatId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('listen_all')
      .eq('chat_id', chatId)
      .eq('is_active', true) // Only get active settings
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error getting listen all:', error);
    }
    return data?.listen_all || false;
  }

  async setUserListenAll(chatId, listenAll) {
    const { error } = await supabase
      .from('user_settings')
      .upsert({
        chat_id: chatId,
        listen_all: listenAll,
        is_active: true, // Always active when setting
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'chat_id'
      });

    if (error) console.error('Error setting listen all:', error);
  }

  // Clear user data - mark as inactive (PRESERVES DATA FOR ANALYTICS)
  async clearUserData(chatId) {
    const timestamp = new Date().toISOString();

    // Mark deposits as inactive instead of deleting
    const { error: error1 } = await supabase
      .from('user_deposits')
      .update({
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);

    // Mark settings as inactive instead of deleting
    const { error: error2 } = await supabase
      .from('user_settings')
      .update({
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);

    // Clear sniper settings too
    const now = new Date();
    const sniperTimestamp = this._formatTimestamp(now);
    const { error: error3 } = await supabase
      .from('user_snipers')
      .update({
        is_active: false,
        updated_at: sniperTimestamp
      })
      .eq('chat_id', chatId);

    if (error1) console.error('Error clearing user deposits:', error1);
    if (error2) console.error('Error clearing user settings:', error2);
    if (error3) console.error('Error clearing user snipers:', error3);
  }

  // Log event notification (for analytics)
  async logEventNotification(chatId, depositId, eventType) {
    const { error } = await supabase
      .from('event_notifications')
      .insert({
        chat_id: chatId,
        deposit_id: depositId,
        event_type: eventType,
        sent_at: new Date().toISOString()
      });

    if (error) console.error('Error logging notification:', error);
  }

  // Get users interested in a deposit (only ACTIVE users/settings)
  async getUsersInterestedInDeposit(depositId) {
    // Users listening to all deposits (ACTIVE settings only)
    const { data: allListeners } = await supabase
      .from('user_settings')
      .select('chat_id')
      .eq('listen_all', true)
      .eq('is_active', true); // Only active "listen all" users

    // Users tracking specific deposit (ACTIVE tracking only)
    const { data: specificTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id')
      .eq('deposit_id', depositId)
      .eq('is_active', true); // Only active deposit tracking

    const allUsers = new Set();

    allListeners?.forEach(user => allUsers.add(user.chat_id));
    specificTrackers?.forEach(user => allUsers.add(user.chat_id));

    return Array.from(allUsers);
  }

  // Get all unique chat_ids from user_deposits where is_active is true
  async getAllUsersWithActiveDeposits() {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('chat_id')
      .eq('is_active', true);

    if (error) {
      console.error('Error fetching all users with active deposits:', error);
      return [];
    }

    // Return unique chat_ids
    return [...new Set(data.map(row => row.chat_id))];
  }

  // BONUS: Analytics methods (new!)
  async getAnalytics() {
    // Total users who ever used the bot
    const { data: totalUsers } = await supabase
      .from('users')
      .select('chat_id', { count: 'exact' });

    // Currently active trackers
    const { data: activeTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' })
      .eq('is_active', true);

    // Total tracking sessions (including cleared ones)
    const { data: allTimeTracking } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' });

    // Most tracked deposits
    const { data: popularDeposits } = await supabase
      .from('user_deposits')
      .select('deposit_id')
      .eq('is_active', true);

    return {
      totalUsers: totalUsers?.length || 0,
      activeTrackers: activeTrackers?.length || 0,
      allTimeTracking: allTimeTracking?.length || 0,
      popularDeposits: popularDeposits || []
    };
  }

  async removeUserSniper(chatId, currency = null, platform = null) {
    const now = new Date();
    const timestamp = this._formatTimestamp(now);

    let query = supabase
      .from('user_snipers')
      .update({
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);

    if (currency) {
      query = query.eq('currency', currency.toUpperCase());
    }

    if (platform) {
      query = query.eq('platform', platform.toLowerCase());
    }

    const { error } = await query;
    if (error) console.error('Error removing sniper:', error);
  }

  async setUserSniper(chatId, currency, platform = null) {
    // Always insert - no deactivation needed
    const now = new Date();
    const timestamp = this._formatTimestamp(now);

    // First, try to deactivate any existing snipers for this currency/platform combo
    let deactivateQuery = supabase
      .from('user_snipers')
      .update({ is_active: false, updated_at: timestamp })
      .eq('chat_id', chatId)
      .eq('currency', currency.toUpperCase())
      .eq('is_active', true);

    if (platform !== null) {
      deactivateQuery = deactivateQuery.eq('platform', platform.toLowerCase());
    } else {
      deactivateQuery = deactivateQuery.is('platform', null);
    }

    await deactivateQuery;

    // Now insert the new sniper
    const { error } = await supabase
    .from('user_snipers')
    .insert({
      chat_id: chatId,
      currency: currency.toUpperCase(),
      platform: platform ? platform.toLowerCase() : null,
      is_active: true,
      created_at: timestamp,
      updated_at: timestamp
    });

    if (error) {
      console.error('Error setting sniper:', error);
      return false;
    }
    return true;
  }

  async getUserSnipers(chatId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    // Format date to match PostgreSQL timestamp without time zone format
    const thirtyDaysAgoFormatted = this._formatTimestamp(thirtyDaysAgo);

    const { data, error } = await supabase
      .from('user_snipers')
      .select('currency, platform, created_at')
      .eq('chat_id', chatId)
      .eq('is_active', true)
      .gte('created_at', thirtyDaysAgoFormatted)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching user snipers:', error);
      return [];
    }

    // Deduplicate - keep only the newest entry for each currency+platform combo
    const unique = new Map();
    data.forEach(row => {
      const key = `${row.currency}-${row.platform ?? 'all'}`; // ← Add fallback for null
      const existing = unique.get(key);
      if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
        unique.set(key, row);
      }
    });

    return Array.from(unique.values());
  }

  async getUsersWithSniper(currency, platform = null) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    // Format date to match PostgreSQL timestamp without time zone format
    const thirtyDaysAgoFormatted = this._formatTimestamp(thirtyDaysAgo);

    let query = supabase
      .from('user_snipers')
      .select('chat_id, currency, platform, created_at')
      .eq('currency', currency.toUpperCase())
      .eq('is_active', true)
      .gte('created_at', thirtyDaysAgoFormatted);

    // If platform is specified, only get users who specifically want this platform OR all platforms
    // If platform is null, only get users who want all platforms (null platform)
    if (platform) {
      // Get users who either specified this platform OR want all platforms (null)
      query = query.or(`platform.eq.${platform.toLowerCase()},platform.is.null`);
    } else {
      // No platform specified - only get users who want all platforms
      query = query.is('platform', null);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching users with sniper:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Deduplicate by chat_id to prevent duplicate notifications
    const uniqueUsers = new Map();
    data.forEach(user => {
      // Validate user object structure
      if (!user || !user.chat_id) {
        console.error('Invalid user object in getUsersWithSniper result:', user);
        return;
      }

      const chatId = user.chat_id;

      // Keep the entry with the most recent created_at timestamp
      const existingUser = uniqueUsers.get(chatId);
      if (!existingUser ||
          // If user.created_at is missing/invalid, prefer the existing entry
          (user.created_at && (!existingUser.created_at ||
          new Date(user.created_at) > new Date(existingUser.created_at)))) {
        uniqueUsers.set(chatId, user);
      }
    });

    return Array.from(uniqueUsers.values());
  }

  async logSniperAlert(chatId, depositId, currency, depositRate, marketRate, percentageDiff) {
    const { error } = await supabase
      .from('sniper_alerts')
      .insert({
        chat_id: chatId,
        deposit_id: depositId,
        currency: currency.toUpperCase(),
        deposit_rate: depositRate,
        market_rate: marketRate,
        percentage_diff: percentageDiff,
        sent_at: new Date().toISOString()
      });

    if (error) console.error('Error logging sniper alert:', error);
  }

  async storeDepositAmount(depositId, amount) {
    const { error } = await supabase
      .from('deposit_amounts')
      .upsert({
        deposit_id: depositId,
        amount: amount,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'deposit_id'
      });

    if (error) console.error('Error storing deposit amount:', error);
  }

  async getDepositAmount(depositId) {
    const { data, error } = await supabase
      .from('deposit_amounts')
      .select('amount')
      .eq('deposit_id', depositId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error getting deposit amount:', error);
      return null;
    }

    return data?.amount || null;
  }

  async getUserThreshold(chatId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('threshold')
      .eq('chat_id', chatId)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error getting user threshold:', error);
    }

    return data?.threshold ?? 0.5; // Returns 0 when threshold is 0
  }

  async setUserThreshold(chatId, threshold) {
    const { error } = await supabase
      .from('user_settings')
      .upsert({
        chat_id: chatId,
        threshold: threshold,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'chat_id'
      });

    if (error) console.error('Error setting user threshold:', error);
  }

  async setUserDepositThreshold(chatId, threshold) {
    const { error } = await supabase
      .from('user_settings')
      .upsert({
        chat_id: chatId,
        deposit_threshold: threshold,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'chat_id'
      });

    if (error) console.error('Error setting user deposit threshold:', error);
  }

  async getUserDepositThreshold(chatId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('deposit_threshold')
      .eq('chat_id', chatId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error getting user deposit threshold:', error);
    }

    return data?.deposit_threshold;
  }

  // Store full intent data for persistence
  async storeIntentData(rawIntent) {
    const { error } = await supabase
      .from('intent_data')
      .upsert({
        intent_hash: rawIntent.intentHash.toLowerCase(),
        deposit_id: rawIntent.depositId,
        fiat_currency: rawIntent.fiatCurrency.toLowerCase(),
        conversion_rate: rawIntent.conversionRate,
        verifier: rawIntent.verifier.toLowerCase(),
        owner: rawIntent.owner.toLowerCase(),
        to: rawIntent.to.toLowerCase(),
        amount: rawIntent.amount,
        timestamp: rawIntent.timestamp
      }, {
        onConflict: 'intent_hash'
      });

    if (error) console.error('Error storing intent data:', error);
  }

  // Retrieve full intent data by intent hash
  async getIntentData(intentHash) {
    const { data, error } = await supabase
      .from('intent_data')
      .select('*')
      .eq('intent_hash', intentHash.toLowerCase())
      .single();

    if (error) {
      console.error('Error retrieving intent data:', error);
      return null;
    }

    return data;
  }
}

module.exports = DatabaseManager;