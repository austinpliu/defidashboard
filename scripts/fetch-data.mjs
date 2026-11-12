#!/usr/bin/env node
// Fetches every number the dashboard shows and writes JSON files to site/data/.
//
//   node scripts/fetch-data.mjs          (normal run)
//   PROBE=1 node scripts/fetch-data.mjs  (also prints the shape of each API response)
//
// No API keys. No dependencies (Node 18+ has fetch built in).
// Runs every 6 hours on GitHub Actions (.github/workflows/update-data.yml).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Http } from './lib/http.mjs';
import {
  DL, fetchGlobal, buildMarket, buildScreener, fetchProtocolRaw, buildProtocolCore, resolveSlug,
  childSlugs, familyIds, poolsForProtocol, hacksForProtocol, fetchChainHistory, fetchStableHistory, fetchLlamaCoin,
} from './lib/defillama.mjs';
import { fetchCoinRaw, buildToken, applyLlamaFallback, searchCoin, fetchPriceSnapshot, applySnapshot, CG } from './lib/coingecko.mjs';
import { fetchNetworkMap, fetchTokenPools } from './lib/dex.mjs';
import { spacesFromSources, fetchProposals } from './lib/governance.mjs';
import { fetchFeed, feedItems, topicsOf } from './lib/feeds.mjs';
import { fetchCoinMarkets, buildCoinRows, fetchPredictionEvents, buildPredictionEvents, predictionProtocols } from './lib/markets.mjs';
import { probeEmissionsRepo, EMISSIONS_REPO, loadManualUnlocks, buildTokenUnlocks } from './lib/unlocks.mjs';
import { sourceRecord, derivedRecord, carryForward } from './lib/sources.mjs';
import { fetchWeeklyPrices, fundamentalsInputs } from './lib/fundamentals.mjs';
import { valuationRatios, valuationSources } from './lib/valuation.mjs';
import { tokenizedAssets, openInterestFor, sizeMeasures, feeDefinitions } from './lib/size.mjs';
import { unlockSize, sizeTokenUnlocks, sizeText, unlockSizeSource } from './lib/unlock-size.mjs';
import { roundSmart, num, slugify, normSeries, dailySeries, trimDays, compactSeries, firstSentences } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DATA_OUT_DIR || join(ROOT, 'site', 'data');
const WATCHLIST = process.env.WATCHLIST_FILE || join(ROOT, 'watchlist.json');
const PROBE = process.env.PROBE === '1';
const started = Date.now();
const problems = [];
const problem = (severity, message, hint) => {
  if (problems.some((p) => p.message === message)) return; // say each thing once
  problems.push({ severity, message, ...(hint ? { hint } : {}) });
  console.log(`${severity === 'error' ? '✗✗' : '!!'} ${message}${hint ? ` — ${hint}` : ''}`);
};

// ---------- small file helpers ----------
const readJSON = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJSON = (p, obj, pretty = false) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(obj, null, pretty ? 2 : 0)}\n`);
};
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, path, v) => {
  const ks = path.split('.');
  let cur = o;
  ks.slice(0, -1).forEach((k) => {
    if (cur[k] == null) cur[k] = {};
    cur = cur[k];
  });
  cur[ks[ks.length - 1]] = v;
};

function shape(v, depth = 0) {
  if (Array.isArray(v)) return `Array(${v.length})${v.length && depth < 2 ? `<${shape(v[0], depth + 1)}>` : ''}`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= 2) return `{${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}}`;
    return `{${keys.slice(0, 30).map((k) => `${k}:${shape(v[k], depth + 1)}`).join(', ')}${keys.length > 30 ? ', …' : ''}}`;
  }
  return typeof v === 'string' ? `str(${v.slice(0, 24)})` : typeof v;
}
const probe = (label, res) => {
  if (PROBE && res?.ok) console.log(`   ↳ shape ${label}: ${shape(res.data).slice(0, 1500)}`);
};

/** Reuse last run's data for sections whose source failed this run (max 48h old). */
function carrySections(next, prev, groups) {
  if (!prev?.sources) return next;
  for (const { src, paths } of groups) {
    const fresh = next.sources?.[src];
    if (!fresh || fresh.ok) continue;
    const prevSource = prev.sources[src];
    const prevData = paths.map((p) => getPath(prev, p));
    if (prevData.every((d) => d == null)) continue;
    const { data, source } = carryForward({ freshData: null, freshSource: fresh, prevData, prevSource });
    if (data) {
      paths.forEach((p, i) => setPath(next, p, prevData[i]));
      next.sources[src] = source;
      problem('warn', `${src}: showing the copy fetched ${source.stale.lastGoodAt} because the latest fetch failed (${String(fresh.error).slice(0, 160)})`);
    }
  }
  return next;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- main ----------
async function main() {
  const watchlist = readJSON(WATCHLIST);
  if (!watchlist || !Array.isArray(watchlist.protocols)) throw new Error('watchlist.json is missing or has no "protocols" list');
  const entries = [
    ...watchlist.protocols.map((p) => ({ ...p, group: 'watchlist' })),
    ...(watchlist.peers || []).map((p) => ({ ...p, group: 'peer' })),
  ].filter((p) => {
    if (!p.name || !p.defillama) {
      problem('error', `watchlist.json entry ${JSON.stringify(p).slice(0, 80)} needs both "name" and "defillama"`);
      return false;
    }
    return true;
  });

  // 22-minute budget: GitHub kills the job at 40 minutes, and a partial,
  // honestly-labelled update is better than none.
  const http = new Http({ budgetMs: Number(process.env.FETCH_BUDGET_MIN || 22) * 60e3 });
  http.configureHost('api.llama.fi', { minIntervalMs: 300, concurrency: 3 });
  http.configureHost('stablecoins.llama.fi', { minIntervalMs: 300, concurrency: 2 });
  http.configureHost('yields.llama.fi', { minIntervalMs: 300, concurrency: 1 });
  http.configureHost('coins.llama.fi', { minIntervalMs: 300, concurrency: 2 });
  http.configureHost('api.coingecko.com', { minIntervalMs: 7000, concurrency: 1 });
  http.configureHost('api.geckoterminal.com', { minIntervalMs: 3500, concurrency: 1 });
  http.configureHost('api.dexscreener.com', { minIntervalMs: 400, concurrency: 1 });
  http.configureHost('hub.snapshot.org', { minIntervalMs: 1500, concurrency: 1 });

  // 1. Market-wide data ---------------------------------------------------
  console.log('\n== DefiLlama market-wide data');
  const raw = await fetchGlobal(http);
  for (const [k, r] of Object.entries(raw)) probe(k, r);
  if (PROBE && raw.fees.ok) console.log('   ↳ fees protocol sample:', JSON.stringify(raw.fees.data.protocols?.slice(0, 2)).slice(0, 1500));
  if (PROBE && raw.protocols.ok) console.log('   ↳ protocols sample:', JSON.stringify(raw.protocols.data.find((p) => p.parentProtocol)).slice(0, 1200));
  if (PROBE && raw.pools.ok) console.log('   ↳ pool sample:', JSON.stringify(raw.pools.data.data?.[0]).slice(0, 800));
  if (PROBE && raw.hacks.ok) console.log('   ↳ hack sample:', JSON.stringify(raw.hacks.data?.[0]).slice(0, 800));
  if (PROBE && raw.emissions.ok) console.log('   ↳ emissions sample:', JSON.stringify(raw.emissions.data?.[0]).slice(0, 1500));
  if (PROBE && raw.raises.ok) console.log('   ↳ raises sample:', JSON.stringify(raw.raises.data?.raises?.[0] ?? raw.raises.data?.[0]).slice(0, 800));

  const topChains = raw.chains.ok ? [...raw.chains.data].sort((a, b) => b.tvl - a.tvl).slice(0, 6).map((c) => c.name) : [];
  const chainHistory = topChains.length ? await fetchChainHistory(http, topChains) : null;
  let stableHistory = null;
  if (raw.stables.ok && raw.stableChart.ok) {
    const top = [...raw.stables.data.peggedAssets]
      .map((a) => ({ id: a.id, symbol: a.symbol, c: Object.values(a.circulating || {}).reduce((s, v) => s + (Number(v) || 0), 0) }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 5);
    const totalSeries = dailySeries(normSeries(raw.stableChart.data.map((p) => [Number(p.date), Object.values(p.totalCirculatingUSD || {}).reduce((s, v) => s + (Number(v) || 0), 0)])));
    stableHistory = await fetchStableHistory(http, top, totalSeries);
  }

  const prevMarket = readJSON(join(OUT, 'market.json'));
  let market = buildMarket(raw, { chainHistory, stableHistory });
  market = carrySections(market, prevMarket, [
    { src: 'dl-tvl', paths: ['headline.tvl'] },
    { src: 'dl-stable-chart', paths: ['headline.stablecoins'] },
    { src: 'dl-dexs', paths: ['headline.dexVolume'] },
    { src: 'dl-fees', paths: ['headline.fees', 'topFees'] },
    { src: 'dl-revenue', paths: ['headline.revenue', 'topRevenue'] },
    { src: 'dl-chains', paths: ['chains'] },
    { src: 'dl-protocols', paths: ['categories', 'movers'] },
    { src: 'dl-stablecoins', paths: ['stablecoins'] },
  ]);

  const watchSlugs = new Set(entries.map((e) => e.defillama));
  const screener = buildScreener(raw, watchSlugs);
  if (market.categories?.basis) {
    const b = market.categories.basis;
    console.log(`   ↳ categories (${b.method}): ${roundSmart((b.attributed || 0) / 1e9)}B of the ${roundSmart((b.headline || 0) / 1e9)}B headline (${b.attributedShare}%); left out: liquid staking ${roundSmart((b.liquidStaking || 0) / 1e9)}B, double counted ${roundSmart((b.doubleCounted || 0) / 1e9)}B, both ${roundSmart((b.both || 0) / 1e9)}B; raw sum ${roundSmart((b.rawSum || 0) / 1e9)}B`);
    if (b.method === 'category-rules') problem('info', `Category TVL: DefiLlama's free protocol list doesn't mark double-counted or liquid-staking TVL per protocol, so whole categories are left out by rule; the rest adds up to ${b.attributedShare}% of the headline TVL, so category shares are of that total (explained on the Overview)`);
  }
  if (PROBE && raw.protocols.ok) {
    const keyCount = {};
    for (const p of raw.protocols.data) for (const k of ['doublecounted', 'liquidstaking', 'dcAndLsOverlap']) if (p.chainTvls && k in p.chainTvls) keyCount[k] = (keyCount[k] || 0) + 1;
    console.log(`   ↳ protocols with double-count keys: ${JSON.stringify(keyCount)}; with a doublecounted flag: ${raw.protocols.data.filter((p) => p.doublecounted === true).length}`);
  }

  // 2. One file per protocol -----------------------------------------------
  console.log('\n== Protocols');
  const protocolList = raw.protocols.ok ? raw.protocols.data : null;
  const fees30dById = new Map((raw.fees.ok ? raw.fees.data.protocols || [] : []).map((p) => [String(p.defillamaId ?? p.id), num(p.total30d)]));
  const yieldsSrc = sourceRecord({ name: 'DefiLlama', label: 'Yield pools', page: `${DL.site}/yields`, res: raw.pools });
  const oiSrc = sourceRecord({ name: 'DefiLlama', label: 'Perps open interest (all venues)', page: `${DL.site}/open-interest`, res: raw.openInterest });
  const defsSrc = sourceRecord({ name: 'DefiLlama', label: 'What DefiLlama counts as fees, revenue and holders revenue, per sub-protocol', page: `${DL.site}/fees`, res: raw.fees });
  if (!raw.openInterest.ok) problem('warn', `DefiLlama open interest failed (${raw.openInterest.error}); perps venues fall back to TVL as their size measure this run`);
  const hacksSrc = sourceRecord({ name: 'DefiLlama', label: 'Hacks database', page: `${DL.site}/hacks`, res: raw.hacks, note: raw.hacks.ok ? undefined : 'DefiLlama lists /hacks as a Pro (paid) endpoint; the free host refused it.' });

  const protocols = await mapLimit(entries, 2, async (entry) => {
    let slug = entry.defillama;
    let r = await fetchProtocolRaw(http, slug);
    if (!r.protocol.ok && protocolList) {
      const alt = resolveSlug(protocolList, slug) || resolveSlug(protocolList, entry.name);
      if (alt && alt !== slug) {
        problem('warn', `DefiLlama slug "${slug}" for ${entry.name} failed (${r.protocol.error}); using "${alt}" found in the protocol list`, `Update "defillama" for ${entry.name} in watchlist.json to "${alt}"`);
        slug = alt;
        r = await fetchProtocolRaw(http, slug);
      }
    }
    if (!r.protocol.ok) problem('error', `Could not load ${entry.name} from DefiLlama (${r.protocol.error})`, `Check the "defillama" slug for ${entry.name} in watchlist.json — it's the last part of its defillama.com/protocol/... URL`);
    probe(`protocol ${slug}`, r.protocol);
    probe(`fees ${slug}`, r.fees);
    const core = buildProtocolCore(r, slug);
    // a parent's id isn't always parent#<slug> (Sky's is parent#maker), so match on the id DefiLlama returns
    const parentIds = new Set([`parent#${slug}`, String(r.protocol.data?.id || '')].filter((x) => x.startsWith('parent#')));
    const kidsAll = protocolList ? protocolList.filter((x) => parentIds.has(x.parentProtocol)) : [];
    if (PROBE) console.log(`   ↳ ${slug} children in /protocols: ${JSON.stringify(kidsAll.map((k) => ({ slug: k.slug, tvl: k.tvl, cat: k.category })))}`);
    // Some parents (seen with RWA issuers) return no TVL at all; then add up the
    // child protocols' own TVL series and say so on the page.
    if (!core.tvl?.series?.length && kidsAll.length) {
      const kidRes = await Promise.all(kidsAll.slice(0, 6).map((k) => http.json(`${DL.api}/protocol/${encodeURIComponent(k.slug)}`, { label: `DefiLlama child protocol ${k.slug}` })));
      const byDay = new Map();
      const used = [];
      kidRes.forEach((kr, i) => {
        const s2 = kr.ok ? dailySeries(normSeries(kr.data?.tvl || [], { tsKey: 'date', valKey: 'totalLiquidityUSD' })) : [];
        if (s2.length) used.push(kidsAll[i].slug);
        for (const [ts, v] of s2) byDay.set(ts, (byDay.get(ts) || 0) + v);
      });
      const summed = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
      if (summed.length) {
        const tmp = buildProtocolCore({ ...r, protocol: { ...r.protocol, data: { ...r.protocol.data, tvl: summed.map(([date, v]) => ({ date, totalLiquidityUSD: v })) } } }, slug);
        core.tvl = { ...tmp.tvl, note: `DefiLlama returned no TVL for the ${entry.name} parent, so this is the sum of its sub-protocols' TVL (${used.join(', ')}).` };
      } else {
        core.tvl = { ...core.tvl, unavailable: `DefiLlama reports no TVL history for ${entry.name} or its sub-protocols (${kidsAll.map((k) => k.slug).join(', ')}).` };
      }
    } else if (!core.tvl?.series?.length && core.tvl) {
      core.tvl.unavailable = core.tvl.unavailable || `DefiLlama reports no TVL history for ${entry.name}.`;
    }
    // DefiLlama sometimes gives a parent the description of one of its products (Ondo Finance
    // carries the text for its Treasury-fund token). Say so, instead of passing it off as the whole.
    if (core.about?.description && kidsAll.length > 1) {
      const same = kidsAll.filter((k) => k.description && firstSentences(k.description, 2) === core.about.description);
      if (same.length === 1) core.about.descriptionOf = { name: same[0].name, slug: same[0].slug, of: kidsAll.length };
    }
    // Parent protocols carry no category/chains of their own; use their children's.
    if (core.about && protocolList) {
      const kids = kidsAll;
      if (!core.about.category && kids.length) {  // kids === kidsAll
        // Weight each sub-protocol by its 30-day fees (what the business earns from), falling
        // back to TVL when DefiLlama has no fees for any of them. By TVL alone Hyperliquid
        // would be a "Bridge", because the deposits behind its exchange sit in its bridge.
        const fee = (k) => fees30dById.get(String(k.id)) || 0;
        const byFees = kids.some((k) => fee(k) > 0);
        const counts = {};
        for (const k of kids) if (k.category) counts[k.category] = (counts[k.category] || 0) + (byFees ? fee(k) : k.tvl || 0) + 1;
        const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c]) => c);
        core.about.category = ranked[0] || null;
        if (ranked.length) {
          core.about.categoryNote = `${entry.name} has no category of its own on DefiLlama, so this is the category of the sub-protocols with the most ${byFees ? 'fees over 30 days' : 'TVL'}.${ranked.length > 1 ? ` Its sub-protocols also cover: ${ranked.slice(1).join(', ')}.` : ''}`;
        }
      }
      if (!core.about.chains?.length) {
        const set = new Set(kids.flatMap((k) => k.chains || []));
        for (const c of core.chainTvl?.list || []) set.add(c.chain);
        core.about.chains = [...set];
      }
    }
    const doc = {
      slug,
      configuredSlug: entry.defillama,
      name: entry.name,
      symbol: entry.symbol || core.about?.symbol || null,
      group: entry.group,
      generatedAt: new Date().toISOString(),
      ...core,
    };
    // links: DefiLlama + watchlist overrides
    doc.links = {
      website: core.about?.url || null,
      docs: entry.links?.docs || null,
      twitter: core.about?.twitter || null,
      github: core.about?.github?.[0] || null,
      audits: core.about?.auditLinks || [],
      defillama: `${DL.site}/protocol/${slug}`,
      ...(entry.links || {}),
    };

    // yields
    const slugs = childSlugs(protocolList, slug, core.about?.otherProtocols || []);
    for (const k of kidsAll) slugs.add(k.slug);
    const pools = poolsForProtocol(raw.pools, slugs);
    doc.sources['dl-yields'] = yieldsSrc;
    const zeroApyPools = pools ? raw.pools.data.data.filter((p) => slugs.has(p.project) && !((Number(p.apy) || 0) > 0)).length : 0;
    doc.yields = pools ? { list: pools, projects: [...slugs], zeroApyPools, src: 'dl-yields' } : { unavailable: raw.pools.error, src: 'dl-yields' };

    // hacks / incidents
    const names = [entry.name, core.about?.name, ...(core.about?.otherProtocols || [])].filter(Boolean);
    const ids = familyIds(protocolList, slug, r.protocol.data?.id);
    for (const k of kidsAll) ids.add(String(k.id));
    const hacks = hacksForProtocol(raw.hacks, names, ids);
    doc.sources['dl-hacks'] = hacksSrc;
    doc.hacks = hacks ? { list: hacks, src: 'dl-hacks' } : { unavailable: hacksSrc.error, note: hacksSrc.note, src: 'dl-hacks' };

    // what the size measures and fee definitions are matched on (see step 8b)
    const kidSlugs = new Set(kidsAll.map((k) => k.slug));
    const rwaKidSlugs = new Set(kidsAll.filter((k) => k.category === 'RWA').map((k) => k.slug));
    return { entry, doc, slugs, match: { parentIds, ids, slugs: new Set([slug, ...kidSlugs]) }, rwaKidSlugs };
  });

  // 3. Tokens (CoinGecko, spaced out to respect the keyless rate limit) -----
  console.log('\n== Tokens');
  const tokenJobs = [];
  for (const p of protocols) {
    const id = p.entry.coingecko || p.doc.about?.geckoId;
    if (id) tokenJobs.push({ id, protocol: p });
    else problem('warn', `${p.entry.name}: no CoinGecko id (none in watchlist.json and DefiLlama has none) — token data skipped`);
  }
  const tokens = [];
  for (const job of tokenJobs) {
    let { id } = job;
    let r = await fetchCoinRaw(http, id);
    probe(`coin ${id}`, r.coin);
    // CoinGecko renames migrated tokens "Name [OLD]"; DefiLlama usually knows the new id.
    const dlId = job.protocol.doc.about?.geckoId;
    if (r.coin.ok && /\[old\]|\(old\)/i.test(r.coin.data?.name || '') && dlId && dlId !== id) {
      problem('warn', `CoinGecko id "${id}" is "${r.coin.data.name}" (a retired token); using DefiLlama's id "${dlId}" instead`, `Change "coingecko" for ${job.protocol.entry.name} in watchlist.json to "${dlId}"`);
      id = dlId;
      job.id = dlId;
      r = await fetchCoinRaw(http, id);
    }
    let token = buildToken(r, id);
    if (r.coin.status === 404) {
      const hits = await searchCoin(http, job.protocol.entry.symbol || job.protocol.entry.name);
      problem('error', `CoinGecko id "${id}" (${job.protocol.entry.name}) was not found`, hits.length ? `CoinGecko search suggests: ${hits.map((h) => `${h.id} (${h.name}, ${h.symbol})`).join('; ')}` : 'Check the "coingecko" field in watchlist.json');
    }
    if (!r.coin.ok || !r.chart.ok) {
      const llama = await fetchLlamaCoin(http, id);
      token = applyLlamaFallback(token, llama, id);
    }
    const prevTok = readJSON(join(OUT, 'tokens', `${id}.json`));
    token = carrySections(token, prevTok, [
      { src: 'cg-coin', paths: ['profile', 'market', 'supply'] },
      { src: 'cg-chart', paths: ['series'] },
    ]);
    token.protocol = { slug: job.protocol.doc.slug, name: job.protocol.entry.name };
    token.symbol = token.profile?.symbol || job.protocol.entry.symbol || null;
    token.name = token.profile?.name || job.protocol.entry.name;
    token.generatedAt = new Date().toISOString();
    tokens.push(token);
    job.protocol.token = token;
  }

  // 3b. One price snapshot for every tracked token ---------------------------
  // The per-token requests above are spaced out over several minutes, and the market list
  // further down is another request again, so the same token used to show slightly different
  // prices in different tables. This single request is the one source for every tracked
  // token's price, market cap, FDV, volume and price changes, everywhere on the site.
  let snapshot = { ok: false, byId: new Map(), source: null };
  if (tokens.length) {
    snapshot = await fetchPriceSnapshot(http, tokens.map((t) => t.id));
    probe('price snapshot', { ok: snapshot.ok, data: [...snapshot.byId.values()] });
    const missed = [];
    for (const t of tokens) {
      if (!applySnapshot(t, snapshot.byId.get(t.id), snapshot.source, { page: `${CG.site}/${t.id}` })) missed.push(t.id);
    }
    if (!snapshot.ok) problem('warn', `CoinGecko price snapshot failed (${snapshot.source.error}), so tracked tokens show the prices fetched one by one a few minutes apart`);
    else if (missed.length) problem('info', `The price snapshot has no row for ${missed.join(', ')}; ${missed.length === 1 ? 'that token keeps' : 'those tokens keep'} the price from ${missed.length === 1 ? 'its' : 'their'} own request`);
  }

  // 4. DEX liquidity (GeckoTerminal, DexScreener fallback) --------------------
  console.log('\n== DEX liquidity');
  // GeckoTerminal's network list is only fetched if some platform needs it
  let networkMapPromise = null;
  const getNetworkMap = () => {
    if (!networkMapPromise) {
      networkMapPromise = fetchNetworkMap(http).then(({ map, res }) => {
        if (!res?.ok) problem('warn', `GeckoTerminal network list failed (${res?.error}); some DEX pools may be missing`);
        return map;
      });
    }
    return networkMapPromise;
  };
  for (const t of tokens) {
    const platforms = t.profile?.platforms;
    if (!platforms || !Object.keys(platforms).length) {
      t.dex = { unavailable: t.profile ? 'CoinGecko lists no contract addresses for this token (it may be native to its own chain)' : 'Token profile unavailable, so contract addresses are unknown', pools: [] };
      continue;
    }
    const d = await fetchTokenPools(http, platforms, getNetworkMap);
    t.sources = { ...t.sources, ...d.sources };
    t.dex = { pools: d.pools, totalLiquidity: d.totalLiquidity, totalVolume24h: d.totalVolume24h, poolCount: d.poolCount, attempted: d.attempted };
    if (!d.pools.length) t.dex.unavailable = d.attempted.map((a) => `${a.platform}: ${a.error || 'no pools'}`).join('; ') || 'No pools found';
    const prevTok = readJSON(join(OUT, 'tokens', `${t.id}.json`));
    if (!d.pools.length && prevTok?.dex?.pools?.length && prevTok.dex.fetchedAt && Date.now() - Date.parse(prevTok.dex.fetchedAt) < 48 * 36e5) {
      const staleInfo = { lastGoodAt: prevTok.dex.fetchedAt, lastAttemptAt: new Date().toISOString(), reason: t.dex.unavailable };
      t.dex = { ...prevTok.dex, stale: staleInfo };
      // The site reads stale.lastGoodAt and stale.reason, so `stale` must be an object (a bare
      // `true` printed "Latest attempt failed: undefined" and dropped the fetch time).
      for (const [k, v] of Object.entries(prevTok.sources || {})) {
        if (!(k.startsWith('gt-') || k.startsWith('ds-'))) continue;
        t.sources[k] = v.ok || v.stale ? { ...v, stale: { ...staleInfo, lastGoodAt: v.stale?.lastGoodAt || v.fetchedAt || staleInfo.lastGoodAt } } : v;
      }
    } else {
      t.dex.fetchedAt = new Date().toISOString();
    }
  }

  // 5. Governance (Snapshot) ---------------------------------------------------
  console.log('\n== Governance');
  const spaceOwner = new Map();
  for (const p of protocols) {
    const spaces = spacesFromSources({
      governanceID: p.doc.about?.governanceID || [],
      snapshotUrl: p.token?.profile?.links?.snapshot || null,
      override: p.entry.snapshot || [],
    });
    p.spaces = spaces;
    // a space shared by several entries belongs to the first watchlist entry that lists it
    spaces.forEach((s) => {
      const cur = spaceOwner.get(s);
      if (!cur || (cur.entry.group !== 'watchlist' && p.entry.group === 'watchlist')) spaceOwner.set(s, p);
    });
  }
  const allSpaces = [...spaceOwner.keys()];
  const gov = await fetchProposals(http, allSpaces);
  if (gov.source && !gov.source.ok) problem('warn', `Snapshot query failed (${gov.source.error})`);
  if (gov.source?.ok && gov.spaceInfo && Object.keys(gov.spaceInfo).length) {
    for (const s of allSpaces) {
      if (gov.spaceInfo[s]) continue;
      const owner = spaceOwner.get(s);
      const found = (owner?.spaces || []).filter((x) => gov.spaceInfo[x]);
      if (found.length) problem('info', `Snapshot has no space "${s}" (listed for ${owner.entry.name} by DefiLlama, CoinGecko or watchlist.json), so ${owner.entry.name}'s votes come from ${found.join(', ')}`);
      else problem('warn', `Snapshot space "${s}" (${owner?.entry.name}) was not found on Snapshot`, `Find the protocol's space on snapshot.org and list its id under "snapshot" in watchlist.json (or remove it)`);
    }
  }
  for (const p of protocols) {
    const props = gov.proposals.filter((x) => p.spaces.includes(x.space));
    p.doc.sources.snapshot = gov.source || sourceRecord({ name: 'Snapshot', label: 'Governance proposals', page: 'https://snapshot.org', res: { ok: false, error: 'No Snapshot space found for this protocol' } });
    p.doc.governance = p.spaces.length
      ? { spaces: p.spaces, spaceInfo: Object.fromEntries(p.spaces.map((s) => [s, gov.spaceInfo?.[s] || null])), proposals: props, src: 'snapshot', ...(gov.source?.ok ? {} : { unavailable: gov.source?.error }) }
      : { spaces: [], proposals: [], src: 'snapshot', unavailable: 'No Snapshot space found in DefiLlama or CoinGecko data for this protocol (it may vote on-chain or elsewhere)' };
  }

  // 6. Feeds (protocol blogs/forums + crypto news) ----------------------------
  console.log('\n== Feeds');
  // every tracked protocol (watchlist first, then peers) can be matched in news and catalysts
  const watchMeta = protocols.map((p) => ({ slug: p.doc.slug, name: p.entry.name, symbol: p.entry.symbol || p.doc.symbol, keywords: p.entry.keywords, group: p.entry.group }));
  const feedJobs = [
    ...protocols.flatMap((p) => (p.entry.feeds || []).map((f) => ({ ...f, owner: p.doc.slug }))),
    ...(watchlist.newsFeeds || []).map((f) => ({ ...f, type: 'news' })),
  ];
  const feedResults = await mapLimit(feedJobs, 4, async (f) => ({ f, ...(await fetchFeed(http, f)) }));
  const catSources = {};
  let feedItemsAll = [];
  for (const { f, items, source } of feedResults) {
    const key = `feed-${slugify(f.name)}`;
    catSources[key] = source;
    if (!source.ok) problem('warn', `Feed "${f.name}" failed (${source.error})`, `Check or remove its URL in watchlist.json: ${f.url}`);
    feedItemsAll.push(...feedItems({ items, feed: f, srcKey: key, protocols: watchMeta, ownerSlug: f.owner || null, maxAgeDays: f.type === 'news' ? 21 : 45 }));
  }
  // de-duplicate by URL
  const seen = new Set();
  feedItemsAll = feedItemsAll.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)));

  // 7. Unlocks ------------------------------------------------------------------
  // Route 1: DefiLlama's open-source emissions adapters, if the repo is publicly cloneable.
  const unlockNames = protocols.flatMap((p) => [p.entry.defillama, p.token?.id, p.entry.symbol, String(p.entry.name).split(' ')[0]]).filter(Boolean);
  const ea = await probeEmissionsRepo({ names: unlockNames, printFiles: PROBE });
  console.log(ea.ok ? `   ✓ emissions-adapters is public (${ea.sha}); ${ea.protocolCount} protocol files; matching: ${ea.files.join(', ') || 'none'}` : `   ✗ emissions-adapters: ${ea.error}`);
  catSources['emissions-adapters'] = {
    name: 'DefiLlama emissions-adapters', label: 'Open-source unlock schedules (GitHub)', page: EMISSIONS_REPO, api: null,
    fetchedAt: ea.fetchedAt, ok: ea.ok, status: null, error: ea.ok ? null : `Repository not publicly cloneable: ${ea.error}`,
  };
  // DefiLlama's own emissions API (paid-only on the free host; asked once per run in case that changes)
  const unlockNote = raw.emissions.ok
    ? null
    : `Unlock schedules unavailable: DefiLlama serves them only on its paid Pro API, and no free keyless source was found (${raw.emissions.error}).`;
  const unlockItems = [];
  const unlockNoteParts = [];
  if (raw.emissions.ok && Array.isArray(raw.emissions.data)) {
    for (const p of protocols) {
      const gid = p.token?.id;
      const e = raw.emissions.data.find((x) => (gid && (x.gecko_id === gid || x.token === `coingecko:${gid}`)) || String(x.name || '').toLowerCase() === p.entry.name.toLowerCase());
      if (!e) continue;
      const evs = (e.events || [])
        .filter((ev) => Number(ev.timestamp) * 1000 > Date.now() && Number(ev.timestamp) * 1000 < Date.now() + 365 * 86400e3)
        .slice(0, 12)
        .map((ev) => ({
          ts: Number(ev.timestamp),
          tokens: Array.isArray(ev.noOfTokens) ? ev.noOfTokens.reduce((s, v) => s + (Number(v) || 0), 0) : num(ev.noOfTokens),
          description: ev.description || null,
          category: ev.category || null,
        }));
      p.doc.unlocks = { list: evs, src: 'dl-emissions' };
      p.doc.sources['dl-emissions'] = sourceRecord({ name: 'DefiLlama', label: 'Token unlocks', page: `${DL.site}/unlocks`, res: raw.emissions });
      for (const ev of evs) {
        unlockItems.push({
          id: `unlock-${p.doc.slug}-${ev.ts}`,
          date: new Date(ev.ts * 1000).toISOString(),
          type: 'unlock',
          status: 'upcoming',
          protocols: [p.doc.slug],
          symbols: [p.entry.symbol].filter(Boolean),
          title: `${p.entry.symbol || p.entry.name} unlock: ${roundSmart(ev.tokens)?.toLocaleString('en-US')} tokens${ev.category ? ` (${ev.category})` : ''}`,
          summary: ev.description || '',
          url: `${DL.site}/unlocks/${p.doc.slug}`,
          sourceName: 'DefiLlama',
          src: 'dl-emissions',
          tokens: ev.tokens,
        });
      }
    }
    catSources['dl-emissions'] = sourceRecord({ name: 'DefiLlama', label: 'Token unlocks', page: `${DL.site}/unlocks`, res: raw.emissions });
  } else {
    for (const p of protocols) {
      p.doc.unlocks = { unavailable: unlockNote, src: 'dl-emissions' };
      p.doc.sources['dl-emissions'] = sourceRecord({ name: 'DefiLlama', label: 'Token unlocks', page: `${DL.site}/unlocks`, res: raw.emissions, note: 'Pro-only endpoint' });
    }
  }

  // Route 3: hand-checked unlocks.json, built from each project's own docs. Used whenever
  // DefiLlama's (paid) unlock data isn't available, which is every run on the free host.
  if (!raw.emissions.ok) {
    const manual = loadManualUnlocks(process.env.UNLOCKS_FILE || join(ROOT, 'unlocks.json'));
    for (const msg of manual.problems) problem('warn', msg, 'Fix that entry in unlocks.json (see README › Token unlocks)');
    if (manual.lastChecked && Date.now() - Date.parse(manual.lastChecked) > 90 * 86400e3) {
      problem('info', `unlocks.json was last checked on ${manual.lastChecked}; re-check the linked docs pages and update it`);
    }
    const unconfirmed = [];
    for (const p of protocols) {
      if (!p.token) continue;
      // each dated unlock also gets a size: dollars at the snapshot price, share of circulating supply, days of volume
      const u = sizeTokenUnlocks(buildTokenUnlocks(manual.tokens[p.token.id], { supply: p.token.supply }), p.token.market || {}, p.token.supply || {});
      const sizeCtx = { price: p.token.market?.price, circulating: p.token.supply?.circulating, volume24h: p.token.market?.volume24h };
      const sym = p.entry.symbol || p.token.symbol || p.entry.name;
      const srcKey = `manual-unlocks-${p.token.id}`;
      const first = u.sources[0];
      const srcRec = first
        ? { name: first.label, label: 'Unlock schedule, hand-checked from the project’s docs', page: first.url, api: null, fetchedAt: u.lastChecked ? `${u.lastChecked}T00:00:00.000Z` : null, ok: true, status: null, error: null, manual: true, note: `Manually sourced; last checked ${u.lastChecked}` }
        : null;
      p.token.unlocks = { ...u, src: srcRec ? srcKey : null };
      p.doc.unlocks = { ...u, src: srcRec ? srcKey : null };
      if (srcRec) { p.token.sources[srcKey] = srcRec; p.doc.sources[srcKey] = srcRec; catSources[srcKey] = srcRec; }
      if (srcRec && u.sizedAt) {
        const calc = unlockSizeSource(srcKey, p.token.market?.src || 'cg-coin');
        p.token.sources['calc-unlock-size'] = calc;
        p.doc.sources['calc-unlock-size'] = calc;
        p.token.unlocks.sizeSrc = 'calc-unlock-size';
        p.doc.unlocks.sizeSrc = 'calc-unlock-size';
      }
      if (u.status === 'unconfirmed') unconfirmed.push(sym);
      // Catalysts: dated events. Tranches that fall in the same month (or on the same day) for
      // one token become one item, and monthly schedules show their next 6 months.
      const groups = new Map();
      for (const e of u.events) {
        const key = `${e.ts}|${e.precision}|${e.kind === 'vesting-end' ? 'end' : 'unlock'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      const monthsShown = new Set();
      for (const [key, evs] of groups) {
        const e0 = evs[0];
        if (evs.every((e) => e.kind === 'monthly')) {
          if (!monthsShown.has(e0.ts) && monthsShown.size >= 6) continue;
          monthsShown.add(e0.ts);
        }
        // 3 significant digits, so the docs' 0.625% isn't shown as 0.63%
        const amountOf = (e) => (e.tokens != null ? `${Math.round(e.tokens).toLocaleString('en-US')} ${sym}${e.share != null ? ` (${Number((e.share * 100).toPrecision(3))}% of supply)` : ''}` : 'amount not published');
        const known = evs.filter((e) => e.tokens != null);
        const total = known.reduce((sum, e) => sum + e.tokens, 0);
        const title = key.endsWith('|end')
          ? `${sym}: ${evs.map((e) => e.label).join('; ')}`
          : `${sym} unlock: ${evs.map((e) => `${amountOf(e)} · ${e.label}`).join(' + ')}`;
        unlockItems.push({
          id: `unlock-${p.token.id}-${key.replace(/\|/g, '-')}`,
          date: new Date(e0.ts * 1000).toISOString(),
          datePrecision: e0.precision,
          type: 'unlock',
          status: 'upcoming',
          protocols: [p.doc.slug],
          symbols: [sym],
          title,
          summary: evs.map((e) => e.basis).filter(Boolean).join(' '),
          url: e0.source?.url || first?.url,
          sourceName: `${e0.source?.label || first?.label} (hand-checked ${u.lastChecked})`,
          src: srcKey,
          tokens: known.length ? total : null,
          share: known.length && known.every((e) => e.share != null) ? known.reduce((sum, e) => sum + e.share, 0) : null,
          partialAmount: known.length > 0 && known.length < evs.length,
          manual: true,
          // how big it is (calculated; null when the docs publish no amount)
          size: known.length ? unlockSize(total, sizeCtx) : null,
          sizeText: known.length ? sizeText(unlockSize(total, sizeCtx)) : '',
          sizeSrc: known.length && p.token.market?.src ? p.token.market.src : null,
        });
      }
    }
    unlockItems.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    unlockNoteParts.push(unconfirmed.length
      ? `Unconfirmed for ${unconfirmed.join(', ')}: their projects publish no unlock schedule we could confirm, so none is shown (each token page says what the docs do say).`
      : null);
  }

  // 8. Derived ratios + per-protocol news ------------------------------------
  for (const p of protocols) {
    const doc = p.doc;
    const t = p.token;
    if (t) {
      doc.token = { id: t.id, symbol: t.symbol, name: t.name, description: t.profile?.description || null, market: t.market || null, supply: t.supply || null, unavailable: t.unavailable || null };
      doc.tokenSeries = t.series || null;
      for (const [k, v] of Object.entries(t.sources)) if (k.startsWith('cg-') || k.startsWith('dl-coin')) doc.sources[k] = v;
    } else {
      doc.token = { unavailable: 'No token configured for this protocol' };
    }
    // What the market pays for a year of fees, of revenue, and of revenue that reaches holders.
    // Market cap and FDV come from the price snapshot, so every ratio uses the same price.
    doc.derived = valuationRatios({
      fees30: doc.fees?.total30d, rev30: doc.revenue?.total30d, hold30: doc.holdersRevenue?.total30d,
      mcap: t?.market?.marketCap, fdv: t?.market?.fdv, tvl: doc.tvl?.value,
    });
    Object.assign(doc.sources, valuationSources(t?.market?.src || 'cg-coin'));

    const allNews = feedItemsAll
      .filter((i) => i.protocols.includes(doc.slug))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    doc.news = allNews.slice(0, 12);
    // the page lists the latest 12; its headline counts them all
    doc.newsTotal = allNews.length;
    doc.newsSince = allNews.length ? allNews[allNews.length - 1].date : null;
    for (const i of doc.news) doc.sources[i.src] = catSources[i.src];
  }

  // carry forward per-protocol sections whose sources failed
  for (const p of protocols) {
    const prev = readJSON(join(OUT, 'protocols', `${p.doc.slug}.json`));
    p.doc = carrySections(p.doc, prev, [
      { src: 'dl-protocol', paths: ['about', 'tvl', 'chainTvl', 'tokenBreakdown', 'raises', 'hallmarks'] },
      { src: 'dl-fees', paths: ['fees'] },
      { src: 'dl-revenue', paths: ['revenue'] },
      { src: 'dl-yields', paths: ['yields'] },
      { src: 'snapshot', paths: ['governance'] },
    ]);
  }

  // 8b. A size measure that fits each kind of protocol, and DefiLlama's fee definitions -----
  // Runs after the carry-forward above, so a stale TVL is still a TVL here.
  for (const p of protocols) {
    const doc = p.doc;
    const category = doc.about?.category || null;
    const prev = readJSON(join(OUT, 'protocols', `${doc.slug}.json`));
    const fresh = (iso) => iso && Date.now() - Date.parse(iso) < 48 * 36e5;
    // a measure whose source failed this run is kept from the last run for up to 48 hours, marked stale
    const keep = (kind, src) => {
      const old = prev?.size?.measures?.find((m) => m.kind === kind);
      const at = old?.stale?.lastGoodAt || old?.asOf;
      return old && fresh(at) ? { ...old, stale: { lastGoodAt: at, reason: src.error } } : null;
    };
    let tok = category === 'RWA' ? tokenizedAssets(raw.pools, p.slugs) : null;
    if (tok) {
      // only real-world-asset sub-protocols belong in "not listed" (a perps venue has nothing to tokenize)
      tok.notListed = tok.notListed.filter((s) => p.rwaKidSlugs.has(s));
      tok.asOf = yieldsSrc.fetchedAt;
    }
    const oi = openInterestFor(raw.openInterest, p.match);
    if (oi) oi.asOf = oiSrc.fetchedAt;
    const size = sizeMeasures({ category, tvl: doc.tvl, borrowed: doc.chainTvl?.borrowed, tokenized: tok, openInterest: oi });
    for (const m of size.measures) {
      if (m.kind === 'tokenized') m.asOf = tok.asOf;
      if (m.kind === 'openInterest') m.asOf = oi.asOf;
      if (m.kind === 'tvl' || m.kind === 'borrowed') m.asOf = doc.sources['dl-protocol']?.stale?.lastGoodAt || doc.sources['dl-protocol']?.fetchedAt || null;
    }
    const carried = [!raw.pools.ok && category === 'RWA' ? keep('tokenized', yieldsSrc) : null, !raw.openInterest.ok ? keep('openInterest', oiSrc) : null].filter(Boolean);
    if (carried.length) {
      const all = [...size.measures, ...carried];
      const want = category === 'RWA' ? 'tokenized' : category === 'Derivatives' ? 'openInterest' : null;
      const first = all.find((m) => m.kind === want) || all.find((m) => m.kind === size.primary) || all[0];
      size.measures = [first, ...all.filter((m) => m !== first)];
      size.primary = first.kind;
      delete size.unavailable;
    }
    doc.size = size;
    if (size.measures.some((m) => m.kind === 'openInterest')) doc.sources['dl-open-interest'] = oiSrc;
    const defs = feeDefinitions(raw.fees, p.match);
    doc.definitions = defs ? { list: defs, src: 'dl-fees-overview' } : { unavailable: raw.fees.ok ? 'DefiLlama publishes no fee definitions for this protocol.' : raw.fees.error, src: 'dl-fees-overview' };
    doc.sources['dl-fees-overview'] = defsSrc;
  }

  // 9. Catalysts ---------------------------------------------------------------
  const now = Date.now();
  const govWindowStart = Date.now() / 1000 - 45 * 86400;
  const govItems = gov.proposals.filter((x) => x.state !== 'closed' || x.end >= govWindowStart).map((x) => {
    const owner = spaceOwner.get(x.space);
    const isOpen = x.state === 'active';
    const isPending = x.state === 'pending';
    const when = isPending ? x.start : x.end;
    const lead = x.leadingChoice ? `Leading: “${x.leadingChoice}” with ${x.leadingShare}% of voting power.` : '';
    const summary = isPending
      ? `Voting opens ${new Date(x.start * 1000).toUTCString().slice(5, 22)} UTC and closes ${new Date(x.end * 1000).toUTCString().slice(5, 22)} UTC.`
      : isOpen
        ? `Voting closes ${new Date(x.end * 1000).toUTCString().slice(5, 22)} UTC. ${lead} ${x.votes ?? 0} votes so far.`
        : `Closed ${new Date(x.end * 1000).toUTCString().slice(5, 16)}. ${x.leadingChoice ? `Result: “${x.leadingChoice}” (${x.leadingShare}%).` : ''} ${x.votes ?? 0} votes.`;
    return {
      id: `snapshot-${x.id}`,
      date: new Date(when * 1000).toISOString(),
      type: 'governance-vote',
      status: isOpen ? 'open' : isPending ? 'upcoming' : 'closed',
      protocols: owner ? [owner.doc.slug] : [],
      symbols: owner ? [owner.entry.symbol].filter(Boolean) : [],
      group: owner?.entry.group,
      title: x.title,
      topics: topicsOf(x.title),
      summary: summary.trim(),
      url: x.url,
      sourceName: `Snapshot · ${x.spaceName}`,
      src: 'snapshot',
      start: x.start,
      end: x.end,
      votes: x.votes,
    };
  });
  if (gov.source) catSources.snapshot = gov.source;
  // unlock sizes are calculated from the price snapshot, so Catalysts cites it too
  if (snapshot.ok && unlockItems.some((i) => i.sizeSrc === 'cg-snapshot')) catSources['cg-snapshot'] = snapshot.source;
  for (const i of unlockItems) if (i.sizeSrc && !catSources[i.sizeSrc]) i.sizeSrc = null;
  const scheduled = protocols.flatMap((p) =>
    (p.doc.hallmarks?.list || [])
      .filter((h) => h.ts * 1000 > now)
      .map((h) => ({
        id: `hallmark-${p.doc.slug}-${h.ts}`,
        date: new Date(h.ts * 1000).toISOString(),
        type: 'scheduled',
        status: 'upcoming',
        protocols: [p.doc.slug],
        symbols: [p.entry.symbol].filter(Boolean),
        title: h.text,
        summary: 'Listed as a future date on DefiLlama’s protocol timeline.',
        url: `${DL.site}/protocol/${p.doc.slug}`,
        sourceName: 'DefiLlama timeline',
        src: 'dl-hallmarks',
      }))
  );
  if (scheduled.length) catSources['dl-hallmarks'] = sourceRecord({ name: 'DefiLlama', label: 'Protocol timeline notes', page: `${DL.site}/`, res: raw.protocols });

  const watchSet = new Set(watchMeta.map((w) => w.slug));
  const catalystItems = [...govItems, ...unlockItems, ...scheduled, ...feedItemsAll.filter((i) => i.protocols.some((s) => watchSet.has(s)))]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const allHeadlines = feedItemsAll
    .filter((i) => i.baseType === 'news' && (i.defi || i.protocols.length))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const headlines = allHeadlines.slice(0, 30);
  const catalysts = {
    generatedAt: new Date().toISOString(),
    items: catalystItems,
    headlines,
    // the list is capped at 30; these count every matching headline so the site can say how many there were
    headlinesTotal: allHeadlines.length,
    headlinesSince: allHeadlines.length ? allHeadlines[allHeadlines.length - 1].date : null,
    headlinesOutlets: new Set(allHeadlines.map((i) => i.sourceName)).size,
    unavailable: unlockNoteParts.filter(Boolean).map((reason) => ({ type: 'unlock', title: 'Token unlocks: unconfirmed for some tokens', reason })),
    protocols: watchMeta.map(({ slug, name, symbol, group }) => ({ slug, name, symbol, group })),
    sources: catSources,
    disclaimer: 'Information, not predictions. Each item links to its original source; dates and labels come from that source or from simple keyword rules described on the page.',
  };

  // 9b. Coins beyond the watchlist, and prediction markets -------------------
  console.log('\n== Coins and prediction markets');
  const coinRes = await fetchCoinMarkets(http);
  probe('coin markets', coinRes.all);
  probe('coin markets (DeFi)', coinRes.defi);
  const freshCoins = buildCoinRows(coinRes.all, coinRes.defi, new Set(tokens.map((t) => t.id)), snapshot.ok ? snapshot.byId : null);
  const coinsSrc = freshCoins ? coinRes.sources['cg-markets'] : { ...coinRes.sources['cg-markets'], ok: false, error: coinRes.sources['cg-markets'].error || 'Unexpected response shape' };
  const prevCoins = readJSON(join(OUT, 'coins.json'));
  const coinCarry = carryForward({ freshData: freshCoins, freshSource: coinsSrc, prevData: prevCoins?.rows ?? null, prevSource: prevCoins?.sources?.['cg-markets'] });
  if (!coinsSrc.ok) problem('warn', `CoinGecko coin list failed (${coinsSrc.error})`);
  else if (!coinRes.defi.ok) problem('warn', `CoinGecko DeFi category list failed (${coinRes.defi.error}), so coins aren't tagged DeFi this run`);
  const coinsDoc = {
    generatedAt: new Date().toISOString(),
    rows: coinCarry.data,
    sources: { ...coinRes.sources, 'cg-markets': coinCarry.source, ...(snapshot.ok ? { 'cg-snapshot': snapshot.source } : {}) },
    // tracked tokens' rows carry the snapshot's numbers, so a token never shows two prices on one page
    snapshotRows: coinCarry.data ? coinCarry.data.filter((r) => r.snapshot).length : 0,
    ...(coinCarry.data ? {} : { unavailable: coinsSrc.error }),
  };

  const pm = await fetchPredictionEvents(http);
  probe('polymarket events', pm.res);
  if (PROBE && pm.res.ok) console.log('   ↳ polymarket event sample:', JSON.stringify((Array.isArray(pm.res.data) ? pm.res.data : pm.res.data?.data || [])[0]).slice(0, 1500));
  const freshEvents = buildPredictionEvents(pm.res);
  const pmSrc = freshEvents ? pm.source : { ...pm.source, ok: false, error: pm.source.error || 'Unexpected response shape' };
  const prevPred = readJSON(join(OUT, 'predictions.json'));
  const evCarry = carryForward({ freshData: freshEvents, freshSource: pmSrc, prevData: prevPred?.events ?? null, prevSource: prevPred?.sources?.['pm-events'] });
  if (!pmSrc.ok) problem('warn', `Polymarket prediction markets failed (${pmSrc.error})`);
  const predictions = {
    generatedAt: new Date().toISOString(),
    events: evCarry.data,
    protocols: predictionProtocols(raw.protocols, fees30dById),
    sources: {
      'pm-events': evCarry.source,
      'dl-protocols': sourceRecord({ name: 'DefiLlama', label: 'Protocols in the Prediction Market category (TVL, 7-day change)', page: `${DL.site}/`, res: raw.protocols }),
      'dl-fees': sourceRecord({ name: 'DefiLlama', label: 'Fees (30d) per protocol', page: `${DL.site}/fees`, res: raw.fees }),
    },
    ...(evCarry.data ? {} : { unavailable: pmSrc.error }),
    note: 'Prediction-market prices are what traders pay for each outcome, read as probabilities. They are bets, not forecasts by this site.',
  };

  // 10. Index (nav, search, watchlist strip) ----------------------------------
  const index = {
    generatedAt: new Date().toISOString(),
    // the one request every tracked token's price, market cap and FDV come from (null if it failed)
    priceSnapshot: snapshot.ok ? snapshot.source : null,
    protocols: protocols.map(({ entry, doc, token }) => ({
      slug: doc.slug,
      name: entry.name,
      symbol: entry.symbol || doc.symbol || null,
      group: entry.group,
      tokenId: token?.id || null,
      category: doc.about?.category || null,
      chains: doc.about?.chains || [],
      logo: doc.about?.logo || null,
      tvl: doc.tvl?.value ?? null,
      tvlChange1d: doc.tvl?.change1d ?? null,
      tvlChange7d: doc.tvl?.change7d ?? null,
      tvlChange30d: doc.tvl?.change30d ?? null,
      tvlSpark: doc.tvl?.series ? doc.tvl.series.slice(-30).map((p) => p[1]) : [],
      fees30d: doc.fees?.total30d ?? null,
      revenue30d: doc.revenue?.total30d ?? null,
      holdersRevenue30d: doc.holdersRevenue?.total30d ?? null,
      // why a figure is missing (shown on hover instead of a guess)
      feesNote: doc.fees?.unavailable || null,
      revenueNote: doc.revenue?.unavailable || null,
      holdersRevenueNote: doc.holdersRevenue?.unavailable || null,
      // calculated ratios (formulas in each protocol file's sources): value ÷ (30-day total × 365 ÷ 30)
      valuation: Object.fromEntries(Object.entries(doc.derived || {}).map(([k, v]) => [k, v.value])),
      // upcoming unlocks, hand-checked from the project's docs, with calculated sizes
      unlock: token?.unlocks ? { status: token.unlocks.status, summary: token.unlocks.summary || null, lastChecked: token.unlocks.lastChecked || null, next: token.unlocks.next || null, next12m: token.unlocks.next12m || null, vesting: token.unlocks.vesting || [], source: token.unlocks.sources?.[0] || null, sized: Boolean(token.unlocks.sizedAt) } : null,
      // size in the measure that fits this kind of protocol (TVL, tokenized assets or open interest)
      size: doc.size || null,
      feesAre: doc.definitions?.list?.[0] ? { from: doc.definitions.list[0].name, shareOfFees: doc.definitions.list[0].shareOfFees, fees: doc.definitions.list[0].methodology.Fees || null, revenue: doc.definitions.list[0].methodology.Revenue || null, holders: doc.definitions.list[0].methodology.HoldersRevenue || null } : null,
      sizeSources: { 'dl-protocol': doc.sources['dl-protocol'] || null, 'dl-yields': doc.sources['dl-yields'] || null, 'dl-open-interest': doc.sources['dl-open-interest'] || null },
      srcDefinitions: doc.sources['dl-fees-overview'] || null,
      srcChart: token?.series?.src ? token.sources[token.series.src] || null : null,
      srcFees: doc.sources['dl-fees'] || null,
      srcRevenue: doc.sources['dl-revenue'] || null,
      srcHolders: doc.sources['dl-holders-revenue'] || null,
      price: token?.market?.price ?? null,
      priceChange24h: token?.market?.change24h ?? null,
      priceChange7d: token?.market?.change7d ?? null,
      priceChange30d: token?.market?.change30d ?? null,
      priceChange90d: token?.market?.change90d ?? null,
      priceChange1y: token?.market?.change1y ?? null,
      mcap: token?.market?.marketCap ?? null,
      fdv: token?.market?.fdv ?? null,
      volume24h: token?.market?.volume24h ?? null,
      // true when this token's numbers come from the shared snapshot (one request for all tokens)
      priceFromSnapshot: token?.market?.src === 'cg-snapshot',
      priceSpark: token?.market?.sparkline7d || [],
      srcTvl: doc.sources['dl-protocol'],
      srcPrice: token ? token.sources[token.market?.src] || token.sources['cg-coin'] : null,
    })),
  };

  // 10b. Fundamentals Checklist inputs (statuses are computed in the browser) ---
  console.log('\n== Fundamentals inputs');
  const fundamentals = { generatedAt: new Date().toISOString(), protocols: [] };
  for (const p of protocols) {
    const weekly = p.token?.id ? await fetchWeeklyPrices(http, p.token.id) : null;
    if (weekly && !weekly.source.ok) problem('info', `Weekly price history for ${p.token.id} unavailable (${weekly.source.error}); the price-range check shows no data`);
    fundamentals.protocols.push(fundamentalsInputs({ entry: p.entry, doc: p.doc, token: p.token, weekly }));
  }
  if (PROBE) console.log(`   ↳ weekly price points: ${fundamentals.protocols.map((f) => `${f.tokenId}:${f.priceWeekly.length}`).join(', ')}`);

  // 11. Write everything ---------------------------------------------------
  console.log('\n== Writing files');
  const keepProtocols = new Set();
  for (const p of protocols) {
    writeJSON(join(OUT, 'protocols', `${p.doc.slug}.json`), p.doc);
    keepProtocols.add(`${p.doc.slug}.json`);
  }
  const keepTokens = new Set();
  for (const t of tokens) {
    writeJSON(join(OUT, 'tokens', `${t.id}.json`), t);
    keepTokens.add(`${t.id}.json`);
  }
  // remove files for protocols/tokens no longer in the watchlist
  for (const [dir, keep] of [['protocols', keepProtocols], ['tokens', keepTokens]]) {
    const d = join(OUT, dir);
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.json') && !keep.has(f)) unlinkSync(join(d, f));
  }
  market.generatedAt = new Date().toISOString();
  writeJSON(join(OUT, 'market.json'), market);
  if (screener) writeJSON(join(OUT, 'screener.json'), { generatedAt: new Date().toISOString(), ...screener });
  writeJSON(join(OUT, 'catalysts.json'), catalysts);
  writeJSON(join(OUT, 'fundamentals.json'), fundamentals);
  writeJSON(join(OUT, 'coins.json'), coinsDoc);
  writeJSON(join(OUT, 'predictions.json'), predictions);
  writeJSON(join(OUT, 'index.json'), index);

  const failed = http.requests.filter((r) => !r.ok);
  const run = process.env.GITHUB_RUN_ID
    ? { id: process.env.GITHUB_RUN_ID, url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, trigger: process.env.GITHUB_EVENT_NAME }
    : { local: true };
  writeJSON(
    join(OUT, 'meta.json'),
    {
      generatedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - started) / 1000),
      run,
      counts: { requests: http.requests.length, failed: failed.length, protocols: protocols.length, tokens: tokens.length, catalysts: catalystItems.length, coins: coinsDoc.rows?.length ?? 0, predictionMarkets: predictions.events?.length ?? 0 },
      problems,
      requests: http.requests,
    },
    true
  );
  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s — ${http.requests.length} requests, ${failed.length} failed, ${problems.length} problems noted.`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
