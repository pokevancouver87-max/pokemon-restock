/**
 * monitor.js — orchestrator for the Pokemon TCG restock monitor.
 *
 * Run modes (flags can be combined):
 *   (no flags)    Cron mode  — runs immediately, then on config.checkInterval schedule
 *   --once        One-shot   — run once and exit (GitHub Actions / CI)
 *   --test, -t    Dry-run    — full scrape + compare, log what would fire, skip notify + state save
 *   --init        Force init — re-baseline all retailers even if state already exists
 *
 * First-run behaviour (auto-detected when products.json is absent or empty):
 *   Scrapes all retailers + Pokemon Center, saves every product as "already seen",
 *   exits without notifying. On the second run, only genuine changes alert.
 *
 * Subsequent-run pipeline:
 *   [1] Refresh MSRP database (no-op if < 24 h old)
 *   [2] Scrape all enabled retailers in parallel
 *   [3] Compare each retailer's results against stored state
 *       → new products (never seen before, in stock, pass keyword + MSRP filter)
 *       → restocks (was OOS/pre-order, now in stock, pass filter)
 *   [4] Send notifications  (Discord and/or email; skipped in --test mode)
 *   [5] Save updated state  (skipped in --test mode so dry-runs stay ephemeral)
 */

require('dotenv').config();

const config = require('./config');

// Kept as module references (not destructured) so tests can stub individual
// functions without re-requiring the whole module.
const targetScraper   = require('./scrapers/target');
const walmartScraper  = require('./scrapers/walmart');
const bestbuyScraper  = require('./scrapers/bestbuy');
const amazonScraper   = require('./scrapers/amazon');
const gamestopScraper = require('./scrapers/gamestop');
const bnScraper       = require('./scrapers/barnesandnoble');
const pcScraper       = require('./scrapers/pokemoncenter');
const redditMonitor   = require('./monitors/reddit');
const notifierMod     = require('./notifier');
const msrpMod         = require('./msrpChecker');
const stateMod        = require('./stateManager');

// ── Logging ───────────────────────────────────────────────────────────────────

const DIVIDER = '━'.repeat(68);

const log = {
  divider: ()           => console.log(DIVIDER),
  phase:   (n, t, msg)  => console.log(`\n[${n}/${t}] ${msg}`),
  info:    (...a)        => console.log('     ', ...a),
  ok:      (...a)        => console.log('   ✓', ...a),
  warn:    (...a)        => console.warn('   ⚠', ...a),
  error:   (...a)        => console.error('   ✗', ...a),
  item:    (tag, msg)    => console.log(`     ${('[' + tag + ']').padEnd(12)} ${msg}`),
  blank:   ()            => console.log(''),
};

function elapsed(startMs) {
  const s = (Date.now() - startMs) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ── First-run detection ───────────────────────────────────────────────────────

/**
 * A first run is when the state file has never been successfully saved.
 * `lastSaved` is set by saveState() on every successful write; it's null on a
 * fresh empty state returned by loadState() when the file is absent.
 */
function isFirstRun(state) {
  return state.lastSaved === null;
}

// ── Scraper registry ──────────────────────────────────────────────────────────

// fn is a thunk so it resolves through the module ref at call time, not import time.
// This lets tests stub scraper functions without re-requiring monitor.
const SCRAPERS = [
  { key: 'target',          name: 'Target',          fn: () => targetScraper.scrapeTarget(),           cfg: () => config.retailers.target          },
  { key: 'walmart',         name: 'Walmart',         fn: () => walmartScraper.scrapeWalmart(),         cfg: () => config.retailers.walmart         },
  { key: 'bestbuy',         name: 'Best Buy',        fn: () => bestbuyScraper.scrapeBestBuy(),         cfg: () => config.retailers.bestbuy         },
  { key: 'amazon',          name: 'Amazon',          fn: () => amazonScraper.scrapeAmazon(),           cfg: () => config.retailers.amazon          },
  { key: 'gamestop',        name: 'GameStop',        fn: () => gamestopScraper.scrapeGameStop(),       cfg: () => config.retailers.gamestop        },
  { key: 'barnesandnoble',  name: 'Barnes & Noble',  fn: () => bnScraper.scrapeBarnesAndNoble(),       cfg: () => config.retailers.barnesandnoble  },
];

// ── Phase 0: Pokemon Center queue check ──────────────────────────────────────

/**
 * Check Pokemon Center for an active Queue-it queue.
 * Fires a CRITICAL notification immediately if a new queue is detected.
 * Skipped when PC_ENABLED=false or in dry-run mode.
 */
async function checkPokemonCenterQueue(phaseNum, totalPhases, isDryRun) {
  if (!config.retailers.pokemoncenter?.enabled) {
    log.phase(phaseNum, totalPhases, 'Pokemon Center queue check  [DISABLED — set PC_ENABLED=true to enable]');
    return;
  }

  log.phase(phaseNum, totalPhases, 'Pokemon Center queue check');
  const t0 = Date.now();

  let result;
  try {
    result = await pcScraper.scrapePokemonCenter();
  } catch (err) {
    log.warn(`Queue check failed — ${err.message}`);
    return;
  }

  const { queueEvent, isNewQueue, products } = result;

  if (!queueEvent) {
    log.info(`No active queue detected  (${elapsed(t0)})`);
  } else {
    const pos  = queueEvent.position != null ? ` · position ${queueEvent.position}` : '';
    const wait = queueEvent.waitTime  ? ` · wait ${queueEvent.waitTime}`             : '';
    log.warn(`QUEUE DETECTED${pos}${wait}  (${elapsed(t0)})`);

    if (isNewQueue) {
      if (isDryRun) {
        log.info('Would send CRITICAL queue alert — suppressed by --test flag');
      } else {
        log.info('Sending CRITICAL queue alert to all channels…');
        const alertResults = await notifierMod.notifyCritical(queueEvent);
        for (const [channel, r] of Object.entries(alertResults)) {
          if (r?.error)        log.error(`${channel}: ${r.error}`);
          else if (r?.sent === false) log.warn(`${channel}: not sent (check credentials)`);
          else                 log.ok(`${channel}: queue alert sent`);
        }
      }
    } else {
      log.info('Queue already known from previous run — no duplicate alert sent');
    }
  }

  if (products?.length) {
    log.info(`PC catalog: ${products.length} product(s) scraped from Pokemon Center`);
  }
}

// ── Phase 1: MSRP refresh ─────────────────────────────────────────────────────

async function refreshMsrp(phaseNum, totalPhases) {
  log.phase(phaseNum, totalPhases, 'MSRP database');
  const t0 = Date.now();

  try {
    const db = await msrpMod.updateMsrpDatabase();
    const age = db.lastUpdated
      ? Math.round((Date.now() - new Date(db.lastUpdated).getTime()) / 1000 / 60)
      : null;
    const ageStr = age !== null ? ` · ${age < 60 ? age + 'm' : Math.round(age / 60) + 'h'} old` : '';
    log.ok(`${db.count} products${ageStr}  (${elapsed(t0)})`);
    return db;
  } catch (err) {
    log.warn(`Update failed — using stale cache. ${err.message}`);
    return null;
  }
}

// ── Phase 2: Parallel retailer scraping ───────────────────────────────────────

async function scrapeRetailers(phaseNum, totalPhases) {
  
import { scrapeWalmartCA } from './scrapers/walmart-ca.js'
import { scrapeLondonDrugs } from './scrapers/londondrugs.js'
import { scrapeCanadianTire } from './scrapers/canadiantire.js'

// inside Promise.all
... scrapeWalmartCA(keywords),
... scrapeLondonDrugs(keywords),
... scrapeCanadianTire(keywords),
  const enabled = SCRAPERS.filter(s => s.cfg().enabled);
  const disabled = SCRAPERS.filter(s => !s.cfg().enabled);

  log.phase(phaseNum, totalPhases, `Scraping retailers  (${enabled.map(s => s.name).join(' + ') || 'none'} — parallel)`);

  if (disabled.length) {
    log.info(`Disabled: ${disabled.map(s => s.name).join(', ')}`);
  }

  if (!enabled.length) {
    log.warn('No retailers enabled — nothing to scrape.');
    return [];
  }

  // Fire all enabled scrapers simultaneously
  const settled = await Promise.allSettled(
    enabled.map(({ key, name, fn }) => {
      const t0 = Date.now();
      return fn()
        .then(products => ({ key, name, products, elapsedMs: Date.now() - t0, error: null }))
        .catch(err   => ({ key, name, products: [],  elapsedMs: Date.now() - t0, error: err }));
    }),
  );

  const results = settled.map(s => s.value ?? s.reason);

  for (const r of results) {
    if (r.error) {
      log.error(`${r.name.padEnd(10)} failed — ${r.error.message}`);
    } else {
      log.ok(`${r.name.padEnd(10)} ${r.products.length} product(s)  (${(r.elapsedMs / 1000).toFixed(1)}s)`);
    }
  }

  return results;
}

// ── Phase 3a: Initialization (first run) ──────────────────────────────────────

async function runInit(scraperResults, phaseNum, totalPhases) {
  log.phase(phaseNum, totalPhases, 'Baseline initialization  (first run — no notifications)');

  const byRetailer = {};
  for (const r of scraperResults) {
    if (!r.error) byRetailer[r.key] = r.products;
  }

  const summary = stateMod.initializeBaseline(byRetailer);
  const total   = summary.reduce((n, s) => n + s.count, 0);

  for (const { retailer, count } of summary) {
    log.ok(`${retailer.padEnd(10)} ${count} products baselined`);
  }

  log.blank();
  log.info(`${total} total products saved as baseline. Next run will detect changes.`);
}

// ── Reddit community alerts ───────────────────────────────────────────────────

async function scrapeRedditAlerts(phaseNum, totalPhases) {
  if (process.env.REDDIT_ENABLED === 'false') return [];
  try {
    const posts = await redditMonitor.scrapeReddit();
    if (posts.length) {
      log.ok(`Reddit     ${posts.length} community alert(s)`);
    }
    return posts;
  } catch (err) {
    log.warn(`Reddit failed — ${err.message}`);
    return [];
  }
}

// ── Phase 3b: Comparison (subsequent runs) ────────────────────────────────────

function compareRetailers(scraperResults, state, phaseNum, totalPhases) {
  log.phase(phaseNum, totalPhases, 'Comparing against stored state');

  const allNew       = [];
  const allRestocked = [];
  let   totalSeen    = 0;

  for (const r of scraperResults) {
    if (r.error) {
      log.warn(`${r.name} — skipping comparison (scraper failed)`);
      continue;
    }

    totalSeen += r.products.length;
    const { newProducts, restockedProducts } = stateMod.compareAndUpdate(r.key, r.products, state);

    const newCount     = newProducts.length;
    const restockCount = restockedProducts.length;

    if (newCount || restockCount) {
      const parts = [];
      if (newCount)     parts.push(`${newCount} new`);
      if (restockCount) parts.push(`${restockCount} restock`);
      log.ok(`${r.name.padEnd(10)} ${r.products.length} seen · ${parts.join(' · ')}`);
    } else {
      log.info(`${r.name.padEnd(10)} ${r.products.length} seen · no changes`);
    }

    allNew.push(...newProducts);
    allRestocked.push(...restockedProducts);
  }

  return { allNew, allRestocked, totalSeen };
}

// ── Phase 4: Log flagged products ─────────────────────────────────────────────

function logFlaggedProducts(allNew, allRestocked) {
  if (!allNew.length && !allRestocked.length) return;

  log.blank();
  for (const p of allNew) {
    const msrpNote = p.msrp ? ` (MSRP ${p.msrp.msrpFormatted})` : '';
    log.item('NEW', `${p.name}  ${p.price}${msrpNote}  ${p.url}`);
  }
  for (const p of allRestocked) {
    const wasLabel = p.previousStockStatus?.replace(/_/g, ' ') ?? 'unknown';
    const msrpNote = p.msrp ? ` (MSRP ${p.msrp.msrpFormatted})` : '';
    log.item('RESTOCK', `${p.name}  ${p.price}${msrpNote}  was: ${wasLabel}  ${p.url}`);
  }
}

// ── Phase 5: Notify ───────────────────────────────────────────────────────────

async function sendNotifications(toNotify, phaseNum, totalPhases, isDryRun) {
  log.phase(phaseNum, totalPhases, `Notifications${isDryRun ? '  [DRY RUN — skipped]' : ''}`);

  if (!toNotify.length) {
    log.info('Nothing to notify.');
    return;
  }

  if (isDryRun) {
    log.info(`Would notify: ${toNotify.length} product(s) — suppressed by --test flag`);
    return;
  }

  const results = await notifierMod.notify(toNotify);

  for (const [channel, result] of Object.entries(results)) {
    if (result?.error)  log.error(`${channel}: ${result.error}`);
    else if (result?.sent === false) log.warn(`${channel}: not sent (check credentials)`);
    else                log.ok(channel);
  }
}

// ── Phase 6: Save state ───────────────────────────────────────────────────────

function persistState(state, phaseNum, totalPhases, isDryRun) {
  log.phase(phaseNum, totalPhases, `Save state${isDryRun ? '  [DRY RUN — skipped]' : ''}`);

  if (isDryRun) {
    log.info(`State not written — dry-run mode keeps state ephemeral.`);
    return;
  }

  stateMod.saveState(state);

  const rows = stateMod.summarizeState(state);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const inStock = rows.reduce((n, r) => n + r.inStock, 0);
  log.ok(`${config.dataFile}  (${total} products tracked, ${inStock} in-stock)`);
}

// ── Run summary ───────────────────────────────────────────────────────────────

function printSummary(context) {
  const { runStart, isDryRun, initMode, totalSeen, allNew, allRestocked } = context;

  log.blank();
  log.divider();

  const parts = [];
  if (initMode) {
    parts.push('Baseline complete');
  } else {
    parts.push(`${totalSeen} products checked`);
    if (allNew.length)       parts.push(`${allNew.length} new`);
    if (allRestocked.length) parts.push(`${allRestocked.length} restocked`);
    if (!allNew.length && !allRestocked.length) parts.push('no changes');
  }

  if (isDryRun) parts.push('DRY RUN');
  parts.push(elapsed(runStart));

  console.log(parts.join('  ·  '));
  log.divider();
  log.blank();
}

// ── Main orchestration ────────────────────────────────────────────────────────

async function run({ isDryRun = false, forceInit = false } = {}) {
  const runStart = Date.now();
  const now      = new Date().toISOString();
  const state    = stateMod.loadState();
  const initMode = forceInit || isFirstRun(state);

  // Header
  log.divider();
  const modeFlags = [
    initMode  ? 'INIT'     : null,
    isDryRun  ? 'DRY RUN'  : null,
  ].filter(Boolean);
  const modeSuffix = modeFlags.length ? `  [${modeFlags.join(' · ')}]` : '';
  console.log(`Pokemon TCG Monitor  ·  ${now}${modeSuffix}`);
  log.divider();

  // ── Phase counts depend on mode ───────────────────────────────────────────
  // Init:       [1] PC Queue  [2] MSRP  [3] Scrape + Reddit  [4] Baseline
  // Normal:     [1] PC Queue  [2] MSRP  [3] Scrape + Reddit  [4] Compare  [5] Notify  [6] Save
  const totalPhases = initMode ? 4 : 6;
  let   phase       = 0;

  // [1] Pokemon Center queue check — always first; fires critical alert if live
  await checkPokemonCenterQueue(++phase, totalPhases, isDryRun);

  // [2] MSRP database
  await refreshMsrp(++phase, totalPhases);

  // [3] Scrape all enabled retailers + Reddit in parallel
  const [scraperResults, redditAlerts] = await Promise.all([
    scrapeRetailers(++phase, totalPhases),
    scrapeRedditAlerts(phase, totalPhases),  // runs alongside, logs its own output
  ]);

  if (initMode) {
    // [4] Baseline — mark all current products as "already seen"
    await runInit(scraperResults, ++phase, totalPhases);
    printSummary({ runStart, isDryRun, initMode: true, totalSeen: 0, allNew: [], allRestocked: [] });
    return { initMode: true, newProducts: [], restockedProducts: [] };
  }

  // [4] Compare retailer results against stored state
  const { allNew, allRestocked, totalSeen } = compareRetailers(scraperResults, state, ++phase, totalPhases);

  // Community alerts (Reddit) bypass state comparison — seen-ID file handles dedup
  const toNotify = [...allNew, ...allRestocked, ...redditAlerts];
  logFlaggedProducts(allNew, allRestocked);

  if (redditAlerts.length) {
    log.blank();
    for (const p of redditAlerts) {
      const subs = p.subreddit ? ` [r/${p.subreddit}]` : '';
      log.item('REDDIT', `${p.name}${subs}  ${p.url ?? ''}`);
    }
  }

  // [5] Notify
  await sendNotifications(toNotify, ++phase, totalPhases, isDryRun);

  // [6] Save
  persistState(state, ++phase, totalPhases, isDryRun);

  printSummary({ runStart, isDryRun, initMode: false, totalSeen, allNew, allRestocked });

  return { initMode: false, newProducts: allNew, restockedProducts: allRestocked };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args      = process.argv.slice(2);
  const isDryRun  = args.includes('--test') || args.includes('-t');
  const isOnce    = args.includes('--once') || process.env.CI === 'true';
  const forceInit = args.includes('--init');

  if (isDryRun) {
    console.log('[Monitor] Dry-run mode — scraping and comparing, but no notifications or state writes.');
  }

  const runOnce = () =>
    run({ isDryRun, forceInit }).catch(err => {
      console.error('\n[Monitor] Fatal error:', err.stack ?? err.message);
      process.exit(1);
    });

  if (isOnce || isDryRun) {
    // Single execution (CI, manual test, or dry-run)
    runOnce();
  } else {
    // Cron mode — run immediately then on schedule
    const cron = require('node-cron');
    console.log(`[Monitor] Cron mode — schedule: ${config.checkInterval}`);
    console.log('[Monitor] Starting first run immediately…\n');
    runOnce().then(() => {
      cron.schedule(config.checkInterval, () => run({ isDryRun: false, forceInit: false }));
      console.log(`[Monitor] Next run scheduled. Waiting…`);
    });
  }
}

module.exports = { run };
