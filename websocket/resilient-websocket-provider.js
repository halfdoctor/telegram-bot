const { WebSocketProvider } = require('ethers');
const {
  CONTRACT_ADDRESS,
  CONNECTION_CONFIG,
  WEBSOCKET_STATES
} = require('../config/web3-config');

/**
 * Enhanced WebSocket Provider with better connection stability
 */
class ResilientWebSocketProvider {
  constructor(url, eventHandler) {
    this.url = url;
    this.contractAddress = CONTRACT_ADDRESS;
    this.eventHandler = eventHandler;
    this.reconnectDelay = CONNECTION_CONFIG.RECONNECT_DELAY_MS;
    this.maxReconnectDelay = CONNECTION_CONFIG.MAX_RECONNECT_DELAY_MS;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = CONNECTION_CONFIG.MAX_RECONNECT_ATTEMPTS;
    this.isConnecting = false;
    this.isDestroyed = false;
    this.provider = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.lastActivityTime = Date.now();

    this.connect();
  }

  async connect() {
    if (this.isConnecting || this.isDestroyed) return;
    this.isConnecting = true;

    try {
      console.log(`🔌 Attempting WebSocket connection (attempt ${this.reconnectAttempts + 1})`);

      // Properly cleanup existing provider
      if (this.provider) {
        await this.cleanup();
      }

      // Add connection options for better stability
      this.provider = new WebSocketProvider(this.url, undefined, {
        reconnectInterval: CONNECTION_CONFIG.RECONNECT_DELAY_MS,
        maxReconnectInterval: CONNECTION_CONFIG.MAX_RECONNECT_DELAY_MS,
        reconnectDecay: CONNECTION_CONFIG.RECONNECT_BACKOFF_MULTIPLIER,
        timeoutInterval: CONNECTION_CONFIG.CONNECTION_TIMEOUT_MS,
        maxReconnectAttempts: null, // We handle this ourselves
        debug: false
      });

      this.setupEventListeners();

      // Test connection with timeout
      const networkPromise = this.provider.getNetwork();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_CONFIG.CONNECTION_TIMEOUT_MS)
      );

      await Promise.race([networkPromise, timeoutPromise]);

      console.log('✅ WebSocket connected successfully');
      this.lastActivityTime = Date.now();

      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.isConnecting = false;

      this.setupContractListening();
      this.startKeepAlive(); // Start keep-alive mechanism

    } catch (error) {
      console.error('❌ WebSocket connection failed:', error.message);
      this.isConnecting = false;

      // Only schedule reconnect if not destroyed
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    }
  }

  async cleanup() {
    if (this.provider) {
      try {
        // Stop keep-alive first
        this.stopKeepAlive();

        // Remove all listeners first
        this.provider.removeAllListeners();

        // Close WebSocket connection if it exists
        if (this.provider._websocket) {
          this.provider._websocket.removeAllListeners();
          if (this.provider._websocket.readyState === WEBSOCKET_STATES.OPEN) {
            this.provider._websocket.close(1000, 'Normal closure'); // Proper close code
          }
        }

        // Destroy provider
        if (typeof this.provider.destroy === 'function') {
          await this.provider.destroy();
        }

        console.log('🧹 Cleaned up existing provider');
      } catch (error) {
        console.error('⚠️ Error during cleanup:', error.message);
      }
    }
  }

  setupEventListeners() {
    if (!this.provider || this.isDestroyed) return;

    if (this.provider._websocket) {
      this.provider._websocket.on('close', (code, reason) => {
        console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
        this.stopKeepAlive();
        if (!this.isDestroyed) {
          // Add delay before reconnecting to avoid rapid reconnections
          setTimeout(() => {
            if (!this.isDestroyed) {
              this.scheduleReconnect();
            }
          }, CONNECTION_CONFIG.RAPID_RECONNECT_DELAY_MS);
        }
      });

      this.provider._websocket.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        this.stopKeepAlive();
        if (!this.isDestroyed) {
          this.scheduleReconnect();
        }
      });

      // Enhanced ping/pong handling
      this.provider._websocket.on('ping', (data) => {
        console.log('🏓 WebSocket ping received');
        this.lastActivityTime = Date.now();
        this.provider._websocket.pong(data); // Respond to ping
      });

      this.provider._websocket.on('pong', () => {
        console.log('🏓 WebSocket pong received');
        this.lastActivityTime = Date.now();
      });

      // Track any message activity
      this.provider._websocket.on('message', () => {
        this.lastActivityTime = Date.now();
      });
    }

    // Listen for provider events too
    this.provider.on('error', (error) => {
      console.error('❌ Provider error:', error.message);
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    });
  }

  startKeepAlive() {
    this.stopKeepAlive(); // Clear any existing timer

    // Send ping every configured interval to keep connection alive
    this.keepAliveTimer = setInterval(() => {
      if (this.provider && this.provider._websocket && this.provider._websocket.readyState === WEBSOCKET_STATES.OPEN) {
        try {
          this.provider._websocket.ping();

          console.log('🏓 Sent keep-alive ping');

          // Check if we haven't received any activity in configured threshold
          const timeSinceActivity = Date.now() - this.lastActivityTime;
          if (timeSinceActivity > CONNECTION_CONFIG.INACTIVITY_THRESHOLD_MS) {
            console.log(`⚠️ No activity for ${CONNECTION_CONFIG.INACTIVITY_THRESHOLD_MS / 1000} seconds, forcing reconnection`);
            this.scheduleReconnect();
          }
        } catch (error) {
          console.error('❌ Keep-alive ping failed:', error.message);
          this.scheduleReconnect();
        }
      }
    }, CONNECTION_CONFIG.KEEP_ALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  setupContractListening() {
    if (!this.provider || this.isDestroyed) return;

    try {
      // Add error handling for the event listener
      this.provider.on({ address: this.contractAddress.toLowerCase() }, (log) => {
        this.lastActivityTime = Date.now(); // Update activity time on events
        this.eventHandler(log);
      });

      console.log(`👂 Listening for events on contract: ${CONTRACT_ADDRESS}`);
    } catch (error) {
      console.error('❌ Failed to set up contract listening:', error.message);
      if (!this.isDestroyed) {
        this.scheduleReconnect();
      }
    }
  }

  scheduleReconnect() {
    if (this.isConnecting || this.isDestroyed) return;

    // Clear existing timer if any
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.stopKeepAlive(); // Stop keep-alive during reconnection

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`💀 Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping.`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(CONNECTION_CONFIG.RECONNECT_BACKOFF_MULTIPLIER, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    console.log(`⏰ Scheduling reconnection in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }

  // Add manual restart method
  async restart() {
    console.log('🔄 Manual restart initiated...');
    this.reconnectAttempts = 0;
    this.reconnectDelay = CONNECTION_CONFIG.RECONNECT_DELAY_MS;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopKeepAlive();
    await this.cleanup();

    // Wait a bit before reconnecting
    setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, CONNECTION_CONFIG.MANUAL_RESTART_DELAY_MS);
  }

  // Add proper destroy method
  async destroy() {
    console.log('🛑 Destroying WebSocket provider...');
    this.isDestroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopKeepAlive();
    await this.cleanup();
    this.provider = null;
  }

  get currentProvider() {
    return this.provider;
  }

  get isConnected() {
    return this.provider &&
             this.provider._websocket &&
             this.provider._websocket.readyState === WEBSOCKET_STATES.OPEN &&
             (Date.now() - this.lastActivityTime) < CONNECTION_CONFIG.ACTIVITY_TIMEOUT_MS;
  }
}

module.exports = ResilientWebSocketProvider;