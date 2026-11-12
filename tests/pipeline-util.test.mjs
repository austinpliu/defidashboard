import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundSmart, pctChange, normSeries, dailySeries, valueDaysAgo, changeOverDays, allTimeHigh,
  sumLastDays, trimDays, firstSentences, mentions, stripHtml, DAY,
} from '../scripts/lib/util.mjs';
import { parseFeed } from '../scripts/lib/rss.mjs';
import { prettyParentName, groupOverview, isChainKey, poolsForProtocol, categoryBreakdown } from '../scripts/lib/defillama.mjs';
import { spacesFromSources, mainQuery, latestQuery } from '../scripts/lib/governance.mjs';
import { carryForward } from '../scripts/lib/sources.mjs';
import { classify } from '../scripts/lib/feeds.mjs';
import { buildTokenUnlocks } from '../scripts/lib/unlocks.mjs';

const series = (vals, start = 1_700_000_000) => vals.map((v, i) => [Math.floor(start / DAY) * DAY + i * DAY, v]);

test('roundSmart keeps sensible precision', () => {
  assert.equal(roundSmart(1234.56), 1235);
  assert.equal(roundSmart(12.3456), 12.35);
  assert.equal(roundSmart(0.000123456), 0.0001235);
  assert.equal(roundSmart(null), null);
  assert.equal(roundSmart('abc'), null);
});

test('pctChange handles missing and zero baselines', () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(100, 0), null);
  assert.equal(pctChange(null, 100), null);
});

test('normSeries accepts objects, milliseconds and sorts', () => {
  const s = normSeries([{ date: 1700086400, tvl: 2 }, { date: 1700000000, tvl: 1 }], { tsKey: 'date', valKey: 'tvl' });
  assert.deepEqual(s, [[1700000000, 1], [1700086400, 2]]);
  const ms = normSeries([[1700000000000, 5]]);
  assert.deepEqual(ms, [[1700000000, 5]]);
});

test('changeOverDays compares with the point N days earlier', () => {
  const s = series([100, 101, 102, 103, 104, 105, 106, 120]);
  assert.equal(valueDaysAgo(s, 7), 100);
  assert.equal(Math.round(changeOverDays(s, 7)), 20);
  assert.equal(changeOverDays(s, 30), null, 'not enough history → null, never a guess');
});

test('allTimeHigh finds the record and its date', () => {
  const s = series([1, 5, 3]);
  assert.deepEqual(allTimeHigh(s), { value: 5, ts: s[1][0] });
});

test('sumLastDays and offsets', () => {
  const s = series([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(sumLastDays(s, 7), 14);
  assert.equal(sumLastDays(s, 7, 7), 7);
});

test('dailySeries keeps the last point of each day', () => {
  const d = Math.floor(1700000000 / DAY) * DAY;
  assert.deepEqual(dailySeries([[d + 10, 1], [d + 20, 2], [d + DAY + 5, 3]]), [[d, 2], [d + DAY, 3]]);
});

test('trimDays keeps the most recent window', () => {
  const s = series([1, 2, 3, 4, 5]);
  assert.equal(trimDays(s, 2).length, 3);
});

test('firstSentences returns at most n sentences, without HTML', () => {
  assert.equal(firstSentences('<p>One. Two! Three?</p>', 2), 'One. Two!');
  assert.equal(firstSentences('', 2), '');
});

test('mentions: tickers are case-sensitive words, names are not', () => {
  assert.ok(mentions('HYPE rallies after Hyperliquid upgrade', ['HYPE']));
  assert.ok(!mentions('The hype around memecoins', ['HYPE']));
  assert.ok(mentions('aave governance passes', ['Aave']));
  assert.ok(!mentions('Skyrocketing yields', ['SKY']));
  assert.ok(!mentions('Pendleton news', ['Pendle']));
});

test('stripHtml decodes entities and drops tags', () => {
  assert.equal(stripHtml('<b>A &amp; B</b>&nbsp;&#8217;s'), 'A & B ’s');
});

test('parseFeed reads RSS and Atom', () => {
  const rss = '<rss><channel><title>T</title><item><title><![CDATA[Hello]]></title><link>https://a.com/1</link><pubDate>Tue, 04 Nov 2025 10:00:00 GMT</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item></channel></rss>';
  const r = parseFeed(rss);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'Hello');
  assert.equal(r.items[0].date, '2025-11-04T10:00:00.000Z');
  const atom = '<feed><title>F</title><entry><title>E</title><link rel="alternate" href="https://b.com/2"/><updated>2025-11-04T10:00:00Z</updated></entry></feed>';
  const a = parseFeed(atom);
  assert.equal(a.items[0].link, 'https://b.com/2');
  assert.throws(() => parseFeed('<html>not a feed</html>'));
});

test('prettyParentName uses shared leading words', () => {
  assert.equal(prettyParentName({ children: ['Aave V2', 'Aave V3'], slug: 'aave' }), 'Aave');
  assert.equal(prettyParentName({ children: ['Sky Lending', 'Sky Savings'], slug: 'sky' }), 'Sky');
  assert.equal(prettyParentName({ children: ['Uniswap V3'], slug: 'uniswap' }), 'Uniswap');
  assert.equal(prettyParentName({ children: ['Foo', 'Bar'], slug: 'foo-bar' }), 'Foo Bar');
});

test('groupOverview aggregates children and drops chains', () => {
  const g = groupOverview([
    { name: 'Aave V3', defillamaId: '1', parentProtocol: 'parent#aave', total30d: 10, total60dto30d: 5, category: 'Lending' },
    { name: 'Aave V2', defillamaId: '2', parentProtocol: 'parent#aave', total30d: 5, total60dto30d: 5, category: 'Lending' },
    { name: 'Ethereum', defillamaId: '9', category: 'Chain', total30d: 999 },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].name, 'Aave');
  assert.equal(g[0].total30d, 15);
  assert.equal(g[0].change30dOver30d, 50);
});

test('isChainKey filters DefiLlama extra TVL buckets', () => {
  assert.ok(isChainKey('Ethereum'));
  assert.ok(!isChainKey('borrowed'));
  assert.ok(!isChainKey('Ethereum-borrowed'));
});

test('spacesFromSources reads DefiLlama ids and CoinGecko URLs', () => {
  assert.deepEqual(spacesFromSources({ governanceID: ['snapshot:aave.eth', 'eip155:1:0xabc'] }), ['aave.eth']);
  assert.deepEqual(spacesFromSources({ snapshotUrl: 'https://snapshot.box/#/s:pendle.eth' }), ['pendle.eth']);
  assert.deepEqual(spacesFromSources({ snapshotUrl: 'https://snapshot.org/#/ens.eth/' }), ['ens.eth']);
});

test('Snapshot queries stay within the hub limit of 5 top-level selections', () => {
  const roots = (q) => (q.match(/^\s{2}\w+: (proposals|spaces)\(/gm) || []).length + (q.match(/^\s{2}spaces\(/gm) || []).length;
  assert.ok(roots(mainQuery('id', true)) <= 5);
  assert.equal(roots(latestQuery('id', 5)), 5);
});

test('carryForward reuses recent data, marks it stale, and gives up after 48h', () => {
  const fresh = { ok: false, error: 'HTTP 429', fetchedAt: new Date().toISOString() };
  const recent = { ok: true, fetchedAt: new Date(Date.now() - 3 * 36e5).toISOString() };
  const r = carryForward({ freshData: null, freshSource: fresh, prevData: { x: 1 }, prevSource: recent });
  assert.deepEqual(r.data, { x: 1 });
  assert.equal(r.source.stale.reason, 'HTTP 429');
  const old = { ok: true, fetchedAt: new Date(Date.now() - 72 * 36e5).toISOString() };
  const r2 = carryForward({ freshData: null, freshSource: fresh, prevData: { x: 1 }, prevSource: old });
  assert.equal(r2.data, null);
  assert.equal(r2.source.error, 'HTTP 429');
});

test('classify labels launches and upgrades by keyword', () => {
  assert.equal(classify('Aave V4 goes live on mainnet', 'news'), 'launch-upgrade');
  assert.equal(classify('Weekly market wrap', 'news'), 'news');
  assert.equal(classify('[ARFC] Risk parameter update', 'governance-forum'), 'governance-forum');
});

test('poolsForProtocol lists pools that pay yield before zero-yield collateral pools', () => {
  const res = { ok: true, data: { data: [
    { pool: 'a', project: 'x', tvlUsd: 100, apy: 0 },
    { pool: 'b', project: 'x', tvlUsd: 10, apy: 3 },
    { pool: 'c', project: 'y', tvlUsd: 1000, apy: 5 },
    { pool: 'd', project: 'x', tvlUsd: 50, apy: null },
  ] } };
  assert.deepEqual(poolsForProtocol(res, new Set(['x'])).map((p) => p.pool), ['b', 'a', 'd']);
});

test('buildTokenUnlocks: monthly tranches, linear vesting, releases, and nothing invented', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const src = [{ id: 'docs', label: 'Docs', url: 'https://example.com/docs' }];
  const u = buildTokenUnlocks({
    status: 'scheduled', sources: src,
    schedules: [
      { label: 'Team', type: 'monthly', from: '2025-04', to: '2027-02', sharePerPeriod: 0.01, source: 'docs' },
      { label: 'Investors', type: 'monthly', from: '2025-04', to: '2027-02', sharePerPeriod: null, source: 'docs' },
      { label: 'Founders', type: 'linear', start: '2025-11-21', end: '2027-11-21', share: 0.152, source: 'docs' },
      { label: 'Window only', type: 'linear', start: null, end: '2029-04', share: 0.1, source: 'docs' },
    ],
    events: [{ date: '2027-01-18', label: 'Release', share: null, source: 'docs' }, { date: '2026-01-18', label: 'Past', share: 0.1 }],
  }, { supply: { max: 1e9 }, now });
  const team = u.events.filter((e) => e.label === 'Team');
  assert.equal(team.length, 3, 'Dec 2026, Jan and Feb 2027: this month is skipped (day unknown), nothing past the end');
  assert.equal(new Date(team[0].ts * 1000).toISOString().slice(0, 7), '2026-12');
  assert.equal(team[0].tokens, 1e7);
  assert.ok(u.events.filter((e) => e.label === 'Investors').every((e) => e.tokens === null), 'no share, no amount');
  const founders = u.schedules.find((s) => s.label === 'Founders');
  assert.ok(Math.abs(founders.tokensPerMonth - 152e6 / 24) < 1e5);
  assert.equal(u.schedules.find((s) => s.label === 'Window only').tokensPerMonth, null, 'no start date, no monthly rate');
  assert.ok(u.events.some((e) => e.label === 'Founders: vesting ends' && e.precision === 'day'));
  assert.ok(u.events.some((e) => e.label === 'Release' && e.tokens === null));
  assert.ok(!u.events.some((e) => e.label === 'Past'));
  assert.equal(buildTokenUnlocks(null).status, 'unconfirmed');
});

// ---- Regression tests for the Nov 2026 review (see REVIEW.md) ----

test('sumLastDays can require a complete window (a gap must not shrink one side of a comparison)', () => {
  const full = series([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  const gappy = full.filter((_, i) => i !== 2); // one day missing in the earlier week
  assert.equal(sumLastDays(gappy, 7, 7), 6); // the default 80% rule still sums 6 of 7 days
  assert.equal(sumLastDays(gappy, 7, 7, 7), null); // a complete window is required
  assert.equal(sumLastDays(full, 7, 7, 7), 7);
});

test('stripHtml survives entities outside the Unicode range instead of throwing', () => {
  assert.equal(stripHtml('a &#99999999; b &#x110000; c'), 'a � b � c');
});

test('categoryBreakdown: shares use the headline TVL, without liquid staking or double counting (REVIEW #7)', () => {
  // headline = 100: only Lending (60) and Dexs (40) count. Liquid staking, a vault curator that
  // deposits into Lending, and a liquid restaking token (both flags) must not inflate the total.
  const protocols = [
    { name: 'Lend', category: 'Lending', tvl: 60, chainTvls: { Ethereum: 60 } },
    { name: 'Swap', category: 'Dexs', tvl: 40, chainTvls: { Ethereum: 40 } },
    { name: 'Lido-like', category: 'Liquid Staking', tvl: 90, chainTvls: { Ethereum: 90, liquidstaking: 90 } },
    { name: 'Curator', category: 'Risk Curators', tvl: 30, chainTvls: { Ethereum: 30, doublecounted: 30 } },
    { name: 'LRT', category: 'Liquid Restaking', tvl: 10, chainTvls: { Ethereum: 10, doublecounted: 10, liquidstaking: 10, dcAndLsOverlap: 10 } },
    { name: 'Exchange', category: 'CEX', tvl: 500, chainTvls: { Ethereum: 500 } },
    { name: 'Bridge', category: 'Bridge', tvl: 70, chainTvls: { Ethereum: 70 } },
  ];
  const r = categoryBreakdown(protocols, 100);
  assert.equal(r.basis.method, 'defillama-keys');
  assert.deepEqual(r.list.map((c) => [c.category, c.tvl, c.share]), [['Lending', 60, 60], ['Dexs', 40, 40]]);
  const total = r.list.reduce((s, c) => s + c.share, 0);
  assert.ok(total <= 100.5, `shares add up to ${total}% of the headline, never more`);
  assert.equal(r.basis.attributed, 100);
  assert.equal(r.basis.attributedShare, 100);
  assert.equal(r.basis.liquidStaking, 90);
  assert.equal(r.basis.doubleCounted, 30);
  assert.equal(r.basis.both, 10);
  assert.equal(r.basis.rawSum, 230, 'the old method summed 230 against a headline of 100');
});

test('categoryBreakdown: falls back to category rules when DefiLlama sends no per-protocol figures', () => {
  const protocols = [
    { category: 'Lending', tvl: 50 }, { category: 'Liquid Staking', tvl: 80 }, { category: 'Yield', tvl: 20 },
    { category: 'Liquid Restaking', tvl: 5 }, { category: 'Dexs', tvl: 25 },
  ];
  const r = categoryBreakdown(protocols, 80);
  assert.equal(r.basis.method, 'category-rules');
  assert.deepEqual(r.list.map((c) => c.category), ['Lending', 'Dexs']);
  assert.equal(r.list[0].share, 62.5);
  assert.equal(r.basis.attributedShare, 93.75, 'a gap to the headline is reported, not hidden');
  // with no headline, shares fall back to the categories' own total and say so
  const r2 = categoryBreakdown(protocols, null);
  assert.equal(r2.basis.denominator, 'attributed-no-headline');
  assert.equal(r2.list.reduce((s, c) => s + c.share, 0), 100);
  // if what's left still exceeds the headline (unflagged double counting), shares of the
  // headline would total over 100%: use the categories' own total and say why
  const r3 = categoryBreakdown(protocols, 50);
  assert.equal(r3.basis.denominator, 'attributed-over-headline');
  assert.equal(r3.basis.attributedShare, 150);
  assert.equal(r3.list.reduce((s, c) => s + c.share, 0), 100);
});

// ---------- one price snapshot per run ----------
import { applySnapshot, changeVsSeries, snapshotUrl } from '../scripts/lib/coingecko.mjs';
import { buildCoinRows } from '../scripts/lib/markets.mjs';

test('the snapshot is one request that names every tracked token', () => {
  const u = snapshotUrl(['aave', 'ondo-finance']);
  assert.ok(u.includes('/coins/markets?'));
  assert.ok(u.includes('ids=aave,ondo-finance'));
  assert.ok(u.includes('price_change_percentage=24h,7d,14d,30d,200d,1y'));
});

test('changeVsSeries compares the snapshot price with the daily close N days earlier', () => {
  const now = 1_800_000_000;
  const hist = Array.from({ length: 120 }, (_, i) => [now - (119 - i) * DAY, 100 + i]);
  // 90 days before `now` is index 29 → 129
  assert.equal(changeVsSeries(258, hist, 90, now), 100);
  assert.equal(changeVsSeries(258, hist, 500, now), null, 'no history that far back: no number');
  assert.equal(changeVsSeries(null, hist, 90, now), null);
  assert.equal(changeVsSeries(258, [], 90, now), null);
  // a gap around the target date is not bridged
  const gappy = hist.filter(([t]) => t < now - 100 * DAY || t > now - 80 * DAY);
  assert.equal(changeVsSeries(258, gappy, 90, now), null);
});

test('applySnapshot replaces every live market field and keeps the rest', () => {
  const token = {
    id: 'aave',
    sources: { 'cg-coin': { ok: true } },
    market: { price: 100, marketCap: 1e9, fdv: 2e9, change24h: 1, athDate: '2021-05-18', mcapToTvl: 0.1, sparkline7d: [1, 2], src: 'cg-coin' },
    supply: { circulating: 1e7, src: 'cg-coin' },
    series: { price: [[1_800_000_000 - 90 * DAY, 50]] },
  };
  const source = { name: 'CoinGecko', api: 'https://example.test/markets?ids=aave', fetchedAt: new Date(1_800_000_000 * 1000).toISOString(), ok: true };
  const ok = applySnapshot(token, { id: 'aave', current_price: 101, market_cap: 1.01e9, fully_diluted_valuation: 2.02e9, total_volume: 5e7, price_change_percentage_24h_in_currency: -2, price_change_percentage_30d_in_currency: -29.4, price_change_percentage_1y_in_currency: -44, ath: 661, ath_change_percentage: -84.7 }, source, { page: 'https://www.coingecko.com/en/coins/aave' });
  assert.equal(ok, true);
  assert.equal(token.market.price, 101);
  assert.equal(token.market.marketCap, 1.01e9);
  assert.equal(token.market.fdv, 2.02e9);
  assert.equal(token.market.change30d, -29.4);
  assert.equal(token.market.change90d, 102, 'snapshot price vs the close 90 days before');
  assert.equal(token.market.src, 'cg-snapshot');
  assert.equal(token.market.asOf, source.fetchedAt);
  assert.equal(token.market.mcapToTvl, undefined, 'ratios CoinGecko computed at another price are dropped');
  assert.deepEqual(token.market.sparkline7d, [1, 2], 'fields the snapshot has no value for are kept');
  assert.equal(token.sources['cg-snapshot'].page, 'https://www.coingecko.com/en/coins/aave');
  assert.equal(token.supply.src, 'cg-coin', 'supply stays with the request it came from');
  // no row, or a row without a price: nothing changes
  const untouched = { id: 'x', sources: {}, market: { price: 5, src: 'dl-coin' } };
  assert.equal(applySnapshot(untouched, undefined, source), false);
  assert.equal(applySnapshot(untouched, { id: 'x', current_price: null }, source), false);
  assert.equal(untouched.market.src, 'dl-coin');
});

test('coin list rows for tracked tokens take the snapshot numbers', () => {
  const list = { ok: true, data: [{ id: 'btc', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1, current_price: 9, market_cap: 9e9 }, { id: 'aave', symbol: 'aave', name: 'Aave', market_cap_rank: 49, current_price: 113.51, market_cap: 1.7537e9 }] };
  const snap = new Map([['aave', { id: 'aave', current_price: 113.46, market_cap: 1.7515e9, fully_diluted_valuation: 1.8149e9, total_volume: 2e8, price_change_percentage_7d_in_currency: -13.4 }]]);
  const rows = buildCoinRows(list, { ok: false }, new Set(['aave']), snap);
  const aave = rows.find((r) => r.id === 'aave');
  assert.equal(aave.price, 113.46);
  assert.equal(aave.mcap, 1.7515e9);
  assert.equal(aave.snapshot, true);
  assert.equal(aave.rank, 49, 'rank still comes from the list');
  assert.equal(rows.find((r) => r.id === 'btc').price, 9);
  assert.equal(buildCoinRows(list, { ok: false }, new Set(['aave']), null).find((r) => r.id === 'aave').price, 113.51, 'without a snapshot the list’s own number stands');
});

// ---------- valuation ratios ----------
import { valuationRatios, valuationSources, annualize, ratioOf, shareOf } from '../scripts/lib/valuation.mjs';

test('valuation ratios: value ÷ a year at the last 30 days’ pace', () => {
  // Hyperliquid, 12 Nov 2026: market cap $17.14B, 30-day revenue $68.82M → 20.47×
  const v = valuationRatios({ fees30: 89_581_591, rev30: 68_824_519, hold30: 68_824_519, mcap: 17_139_842_417, fdv: 68_123_441_241, tvl: 7_712_889_420 });
  assert.equal(v.mcapToRevenue.value, 20.47);
  assert.equal(v.mcapToFees.value, 15.73);
  assert.equal(v.mcapToHoldersRevenue.value, 20.47);
  assert.equal(v.fdvToRevenue.value, 81.35);
  assert.equal(v.revenueShare.value, 76.83);
  assert.equal(v.holdersShare.value, 100);
  assert.equal(v.mcapToFdv.value, 25.16);
  assert.equal(v.annualizedRevenue.value, Math.round((68_824_519 * 365) / 30));
  assert.equal(v.mcapToRevenue.src, 'calc-mcap-revenue');
});

test('valuation ratios: no revenue or no data gives no multiple, never a made-up one', () => {
  // Ondo: fees are holders' yield, revenue is $0
  const ondo = valuationRatios({ fees30: 7_737_562, rev30: 0, hold30: 0, mcap: 1.7e9, fdv: 3.5e9, tvl: null });
  assert.equal(ondo.mcapToRevenue.value, null);
  assert.equal(ondo.mcapToHoldersRevenue.value, null);
  assert.equal(ondo.fdvToRevenue.value, null);
  assert.equal(ondo.revenueShare.value, 0);
  assert.equal(ondo.holdersShare.value, null, 'a share of zero revenue is undefined');
  assert.equal(ondo.mcapToTvl.value, null);
  assert.equal(ondo.annualizedRevenue.value, 0);
  // Ethena: DefiLlama has no holders-revenue data at all
  const ena = valuationRatios({ fees30: 17e6, rev30: 62_046, hold30: undefined, mcap: 1.9e9, fdv: 2.1e9, tvl: 5e9 });
  assert.equal(ena.annualizedHoldersRevenue.value, null);
  assert.equal(ena.mcapToHoldersRevenue.value, null);
  assert.ok(ena.mcapToRevenue.value > 2000, 'a tiny revenue gives a huge multiple, shown as it is');
  // no token
  const none = valuationRatios({ fees30: 1e6, rev30: 1e5, hold30: 0, mcap: null, fdv: null, tvl: 1e9 });
  assert.equal(none.mcapToFees.value, null);
  assert.equal(none.mcapToFdv.value, null);
  assert.equal(annualize(null), null);
  assert.equal(ratioOf(10, -1), null, 'negative revenue gives no multiple');
  assert.equal(shareOf(1, 0), null);
});

test('every ratio has a "Calculated" source naming its inputs and formula', () => {
  const v = valuationRatios({ fees30: 1, rev30: 1, hold30: 1, mcap: 1, fdv: 1, tvl: 1 });
  const S = valuationSources('cg-snapshot');
  for (const [k, x] of Object.entries(v)) {
    assert.ok(S[x.src], `${k} → ${x.src}`);
    assert.equal(S[x.src].derived, true);
    assert.ok(S[x.src].formula.length > 10);
  }
  assert.deepEqual(S['calc-mcap-holders'].from, ['cg-snapshot', 'dl-holders-revenue']);
});
