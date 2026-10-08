require('dotenv').config();

const keywords = (process.env.SEARCH_KEYWORDS || 'pokemon trading card game,pokemon tcg booster,pokemon elite trainer box')
  .split(',').map(k => k.trim()).filter(Boolean);

const filterKeywords = (process.env.FILTER_KEYWORDS || 'booster,elite trainer,etb,tin,collection,bundle,box,pack')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

module.exports = {
  notify: {
    // Which channels to route notifications through.
    // Valid values: 'discord', 'email'  (comma-separated)
    // Each channel also requires its own credentials to be set (see below).
    channels: (process.env.NOTIFY_CHANNELS || 'discord,email')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  },

  discord: {
    webhookUrl:          process.env.DISCORD_WEBHOOK_URL          || '',
    communityWebhookUrl: process.env.DISCORD_COMMUNITY_WEBHOOK_URL || '',
    mention:             process.env.DISCORD_MENTION              || '',
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || '',
    to: process.env.EMAIL_TO || '',
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
    },
  },

  retailers: {
    target: {
      enabled: process.env.TARGET_ENABLED !== 'false',
      name: 'Target',
      color: 0xcc0000,
      keywords,
    },
walmartca: { enabled: process.env.WALMARTCA_ENABLED!== 'false', label: 'Walmart CA' },
londondrugs: { enabled: process.env.LONDONDRUGS_ENABLED!== 'false', label: 'London Drugs' },
canadiantire: { enabled: process.env.CANADIANTIRE_ENABLED!== 'false', label: 'Canadian Tire' },
bestbuyca: { enabled: process.env.BESTBUYCA_ENABLED!== 'false', label: 'Best Buy CA' },
toysrusca: { enabled: process.env.TOYSRUSCA_ENABLED!== 'false', label: 'Toys R Us CA' },
    
    amazon: {
      enabled:    process.env.AMAZON_ENABLED !== 'false',
      name:       'Amazon',
      color:      0xff9900,
      accessKey:  process.env.AMAZON_ACCESS_KEY  || '',
      secretKey:  process.env.AMAZON_SECRET_KEY  || '',
      partnerTag: process.env.AMAZON_PARTNER_TAG || '',
      // true  → include 3rd-party FBA/Prime-eligible sellers
      // false → only items sold directly by Amazon.com (default; safer for MSRP)
      fbaOnly:    process.env.AMAZON_FBA_ONLY === 'true',
    },
    gamestop: {
      // Disabled by default: GameStop uses Cloudflare Enterprise which blocks server-side
      // HTTP requests (GitHub Actions, VPS, etc.). Enable only if you have a residential
      // proxy configured or are running monitor.js locally from a home IP.
      enabled: process.env.GAMESTOP_ENABLED === 'true',
      name:    'GameStop',
      color:   0xe31837,
      keywords,
    },
    barnesandnoble: {
      enabled: process.env.BN_ENABLED !== 'false',
      name:    'Barnes & Noble',
      color:   0x1d6b3d,
      keywords,
    },
    pokemoncenter: {
      enabled:         process.env.PC_ENABLED !== 'false',
      name:            'Pokemon Center',
      color:           0xff0000,
      // Session cookie copied from a real browser (required for product scraping;
      // queue detection works without it). Set PC_COOKIE env var.
      cookie:          process.env.PC_COOKIE || '',
      // Comma-separated product URLs to watch for queue redirects.
      watchUrls:       (process.env.PC_WATCH_URLS || '').split(',').map(u => u.trim()).filter(Boolean),
      // Queue-it customer IDs to probe (the subdomain before .queue-it.net).
      queueitIds:      (process.env.PC_QUEUEIT_IDS || 'pokemoncenter,pokemon,tpci').split(',').map(s => s.trim()).filter(Boolean),
      // When true, Discord queue alert includes @here mention.
      mentionEveryone: process.env.PC_QUEUE_MENTION_EVERYONE === 'true',
    },
  },

  reddit: {
    enabled:    process.env.REDDIT_ENABLED !== 'false',
    subreddits: (process.env.REDDIT_SUBREDDITS || 'PokemonTCG,PokeInvesting')
      .split(',').map(s => s.trim()).filter(Boolean),
  },

  discordListener: {
    enabled: process.env.LISTENER_ENABLED === 'true',
    port:    parseInt(process.env.LISTENER_PORT || '3001', 10),
    secret:  process.env.LISTENER_SECRET || '',
  },

  filterKeywords,
  maxPages: parseInt(process.env.MAX_PAGES || '3', 10),
  dataFile: './data/products.json',
  checkInterval: '*/15 * * * *',

  requestHeaders: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  },
};
