// 03 — Tokens overview
import { h, band, sourceLine, pageError, sparkline, takeaway, extLink, unavailable, snapshotNote, segmented, srcLinks, term } from '../ui.js';
import { chartCard } from '../cards.js';
import { loadMany } from '../data.js';
import { divergingChart } from '../charts.js';
import { dataTable } from '../table.js';
import { usd, usdPrice, pct, ratio } from '../format.js';
import { priceMovesTakeaway, tokenValuationTakeaway } from '../takeaways.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const PERIODS = [
  { value: 'priceChange7d', label: '7D', words: 'the past 7 days', title: '7-day' },
  { value: 'priceChange30d', label: '30D', words: 'the past 30 days', title: '30-day' },
  { value: 'priceChange90d', label: '90D', words: 'the past 90 days', title: '90-day' },
  { value: 'priceChange1y', label: '1Y', words: 'the past year', title: '1-year' },
];

export async function render(root) {
  const files = await loadMany(['index.json', 'coins.json']);
  const idx = files['index.json'].data;
  if (!idx) { root.append(pageError(files['index.json'].error)); return; }
  const rows = idx.protocols.filter((p) => p.tokenId).map((p) => ({ ...p, V: p.valuation || {}, groupLabel: p.group === 'peer' ? 'Peer' : 'Watchlist' }));
  const coins = files['coins.json'].data;
  const C = (coins?.rows || []).map((r) => ({ ...r, groupLabel: r.defi === true ? 'DeFi' : r.defi === false ? 'Other' : 'Unknown' }));
  root.append(band({ n: '03', tag: 'Section 03 · Tokens', title: 'Tokens', sub: `${rows.length} tokens belonging to the protocols you track${C.length ? `, plus ${C.length} coins from CoinGecko’s market list` : ''}. Prices from CoinGecko; fees and revenue from DefiLlama.` }));
  const delta = (v) => h('span', { class: `delta ${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}` }, pct(v));
  const tokenCell = (v, r) => h('span', {}, h('a', { href: `#/token/${r.tokenId}`, class: 'name' }, v || r.tokenId), h('span', { class: 'sub' }, ' ', h('a', { href: `#/protocol/${r.slug}` }, r.name)));
  // the one request all tracked prices come from; tokens it missed keep their own request
  const snap = idx.priceSnapshot || null;
  const own = rows.filter((r) => !r.priceFromSnapshot && r.srcPrice);
  const priceSrc = snap
    ? [snap, ...own.map((r) => ({ ...r.srcPrice, label: `${r.symbol || r.tokenId}: not in the snapshot, fetched on its own` }))]
    : rows.filter((r) => r.srcPrice).map((r) => ({ ...r.srcPrice, label: `${r.symbol || r.tokenId} price` }));
  const chartSrc = rows.filter((r) => r.srcChart).map((r) => ({ ...r.srcChart, label: `${r.symbol || r.tokenId} daily price history (for the 90-day change)` }));

  // ---------- Prices ----------
  root.append(h('section', { class: 'card' },
    h('div', { class: 'kicker' }, 'Prices'),
    (() => {
      const m = rows.filter((r) => r.mcap).sort((a, b) => b.mcap - a.mcap);
      return takeaway(m.length >= 2 ? { pre: `${m[0].symbol} is the largest token you track, `, hl: `worth ${usd(m[0].mcap)}`, post: `, ${(m[0].mcap / m[1].mcap).toFixed(1)}x the next one (${m[1].symbol})` } : null, 'Token prices and market caps');
    })(),
    dataTable({
      caption: 'Token prices', csvName: 'token-prices', sortKey: 'mcap', pageSize: 50,
      filters: [{ key: 'category', label: 'Category', plural: 'categories' }, { key: 'groupLabel', label: 'List', plural: 'lists' }],
      searchKeys: ['symbol', 'name', 'category'],
      rowClass: (r) => (r.group === 'watchlist' ? 'is-watch' : null),
      columns: [
        { key: 'symbol', label: 'Token', fmt: tokenCell },
        { key: 'category', label: 'Category', termKey: 'category' },
        { key: 'price', label: 'Price', num: true, fmt: (v) => usdPrice(v), termKey: 'price' },
        { key: 'priceChange24h', label: '24h', num: true, fmt: delta },
        { key: 'priceChange7d', label: '7d', num: true, fmt: delta, termKey: 'change7d' },
        { key: 'priceChange30d', label: '30d', num: true, fmt: delta, termKey: 'change30d' },
        { key: 'priceChange90d', label: '90d', num: true, fmt: delta, termKey: 'change90d', title: 'Calculated: the snapshot price against the daily close 90 days earlier' },
        { key: 'priceChange1y', label: '1y', num: true, fmt: delta },
        { key: 'priceSpark', label: '7-day price', fmt: (v) => h('div', { style: { width: '90px' } }, sparkline(v, { height: 22, fill: false })), sortValue: (r) => r.priceChange7d, csv: () => '' },
        { key: 'mcap', label: 'Market cap', num: true, fmt: (v) => usd(v), termKey: 'marketCap' },
        { key: 'fdv', label: 'FDV', num: true, fmt: (v) => usd(v), termKey: 'fdv' },
        { key: 'mcapToFdv', label: 'Mcap % of FDV', num: true, fmt: (v, r) => (isNum(r.V.mcapToFdv) ? pct(r.V.mcapToFdv, { signed: false, digits: 0 }) : '—'), sortValue: (r) => r.V.mcapToFdv ?? null, csv: (r) => r.V.mcapToFdv ?? '', termKey: 'mcapToFdv', title: 'Calculated: market cap ÷ FDV × 100' },
      ],
      rows,
    }),
    snapshotNote(snap, { extra: 'The 90-day change is calculated here (snapshot price against the daily close 90 days earlier); CoinGecko publishes the others.' }),
    sourceLine([...priceSrc, ...chartSrc])));

  // ---------- Valuation against earnings ----------
  let basis = 'mcap';
  const BASIS = {
    mcap: { label: 'Market cap', value: (r) => r.mcap, fees: 'mcapToFees', rev: 'mcapToRevenue', hold: 'mcapToHoldersRevenue', term: 'marketCap' },
    fdv: { label: 'FDV', value: (r) => r.fdv, fees: 'fdvToFees', rev: 'fdvToRevenue', hold: 'fdvToHoldersRevenue', term: 'fdv' },
  };
  const valHolder = h('div');
  const valHead = h('div');
  const money = (v, note) => (isNum(v) ? usd(v) : h('span', { class: 'muted', title: note || 'DefiLlama has no figure for this protocol' }, '—'));
  const share = (v) => (isNum(v) ? pct(v, { signed: false, digits: v >= 10 ? 0 : 1 }) : '—');
  // a multiple needs something to divide by: "no revenue" is a fact, a dash means the data is missing
  const multiple = (v, total30, what) => (isNum(v) ? ratio(v)
    : total30 === 0 ? h('span', { class: 'sub', title: `DefiLlama records $0 of ${what} over the last 30 days, so there is nothing to divide by` }, `no ${what}`)
      : h('span', { class: 'muted', title: 'Needs both a value and a 30-day figure' }, '—'));
  const renderValuation = () => {
    const B = BASIS[basis];
    valHead.replaceChildren(takeaway(tokenValuationTakeaway(rows.map((r) => ({ symbol: r.symbol || r.tokenId, multiple: r.V[B.rev], revenue30d: r.revenue30d })), { basisLabel: B.label }), 'What the market pays for a year of fees and revenue'));
    valHolder.replaceChildren(dataTable({
      caption: 'Token valuation against fees and revenue', csvName: `token-valuation-${basis}`, sortKey: 'value', pageSize: 50,
      filters: [{ key: 'category', label: 'Category', plural: 'categories' }, { key: 'groupLabel', label: 'List', plural: 'lists' }],
      searchKeys: ['symbol', 'name', 'category'],
      rowClass: (r) => (r.group === 'watchlist' ? 'is-watch' : null),
      columns: [
        { key: 'symbol', label: 'Token', fmt: tokenCell },
        { key: 'category', label: 'Category', termKey: 'category' },
        { key: 'value', label: B.label, num: true, fmt: (v, r) => usd(B.value(r)), sortValue: (r) => B.value(r) ?? null, csv: (r) => B.value(r) ?? '', termKey: B.term },
        { key: 'fees30d', label: 'Fees 30d', num: true, fmt: (v, r) => money(v, r.feesNote), termKey: 'fees' },
        { key: 'revenue30d', label: 'Revenue 30d', num: true, fmt: (v, r) => money(v, r.revenueNote), termKey: 'revenue' },
        { key: 'kept', label: 'Kept', num: true, fmt: (v, r) => share(r.V.revenueShare), sortValue: (r) => r.V.revenueShare ?? null, csv: (r) => r.V.revenueShare ?? '', termKey: 'revenueShare', title: 'Calculated: 30-day revenue ÷ 30-day fees. The share of what users pay that the protocol keeps.' },
        { key: 'holdersRevenue30d', label: 'To holders 30d', num: true, fmt: (v, r) => money(v, r.holdersRevenueNote), termKey: 'holdersRevenue' },
        { key: 'holdersShare', label: 'Share to holders', num: true, fmt: (v, r) => share(r.V.holdersShare), sortValue: (r) => r.V.holdersShare ?? null, csv: (r) => r.V.holdersShare ?? '', termKey: 'holdersShare', title: 'Calculated: 30-day holders revenue ÷ 30-day revenue' },
        { key: 'pf', label: '÷ fees', num: true, fmt: (v, r) => multiple(r.V[B.fees], r.fees30d, 'fees'), sortValue: (r) => r.V[B.fees] ?? null, csv: (r) => r.V[B.fees] ?? '', termKey: basis === 'mcap' ? 'mcapToFees' : 'fdvToFees', title: `Calculated: ${B.label} ÷ (30-day fees × 365 ÷ 30)` },
        { key: 'pr', label: '÷ revenue', num: true, fmt: (v, r) => multiple(r.V[B.rev], r.revenue30d, 'revenue'), sortValue: (r) => r.V[B.rev] ?? null, csv: (r) => r.V[B.rev] ?? '', termKey: basis === 'mcap' ? 'mcapToRevenue' : 'fdvToRevenue', title: `Calculated: ${B.label} ÷ (30-day revenue × 365 ÷ 30)` },
        { key: 'ph', label: '÷ holders revenue', num: true, fmt: (v, r) => multiple(r.V[B.hold], r.holdersRevenue30d, 'holders revenue'), sortValue: (r) => r.V[B.hold] ?? null, csv: (r) => r.V[B.hold] ?? '', termKey: 'mcapToHoldersRevenue', title: `Calculated: ${B.label} ÷ (30-day holders revenue × 365 ÷ 30)` },
        { key: 'check', label: 'Check', fmt: (v, r) => srcLinks([['fees', r.srcFees], ['revenue', r.srcRevenue], ['holders', r.srcHolders]]), csv: (r) => [r.srcFees?.api, r.srcRevenue?.api, r.srcHolders?.api].filter(Boolean).join(' ') },
      ],
      rows,
    }));
  };
  renderValuation();
  const feeSrcs = rows.flatMap((r) => [[r.srcFees, 'fees'], [r.srcRevenue, 'revenue'], [r.srcHolders, 'holders revenue']].filter(([s]) => s).map(([s, what]) => ({ ...s, label: `${r.name}: ${what}, daily` })));
  root.append(h('section', { class: 'card', style: { marginTop: '18px' } },
    h('div', { class: 'kicker' }, term('Valuation against earnings', 'valuationMultiple')),
    valHead,
    h('div', { class: 'chart-controls' }, segmented([{ value: 'mcap', label: 'Value by market cap' }, { value: 'fdv', label: 'Value by FDV' }], basis, (v) => { basis = v; renderValuation(); }, 'Valuation basis')),
    h('p', { class: 'chart-note' }, 'Each multiple is the token’s value divided by a year at the last 30 days’ pace (30-day total × 365 ÷ 30): a run-rate, not a forecast. “No revenue” means DefiLlama records $0, so there is nothing to divide by; a dash means the figure is missing. '),
    h('p', { class: 'chart-note' }, h('b', {}, 'Not like for like: '), '“Fees” is everything users pay, and how much of it is the protocol’s differs by type. A lender’s fees are all the interest its borrowers pay, and most of that goes to depositors; an exchange’s fees are trading fees it largely keeps. The “Kept” column shows the difference. Compare tokens on revenue, or on holders revenue, before fees.'),
    valHolder,
    sourceLine([...priceSrc, ...feeSrcs])));

  // ---------- Price moves ----------
  let period = PERIODS[0];
  const moveRows = () => rows.filter((r) => isNum(r[period.value])).sort((a, b) => b[period.value] - a[period.value]);
  const moveOpts = () => {
    const list = moveRows();
    return {
      take: priceMovesTakeaway(list.map((r) => ({ symbol: r.symbol || r.tokenId, change: r[period.value] })), period.words),
      title: `${period.title} price change, tracked tokens${period.value === 'priceChange90d' ? ' (calculated from the snapshot price and daily history)' : ''}`,
      build: divergingChart({ items: list.map((r) => ({ name: r.symbol || r.tokenId, value: r[period.value], sub: r.name })) }),
      table: () => ({ columns: [{ key: 'symbol', label: 'Token' }, { key: 'name', label: 'Protocol' }, { key: period.value, label: `${period.title} change`, num: true, fmt: (v) => pct(v), csv: (r) => r[period.value] }], rows: list }),
    };
  };
  if (moveRows().length >= 2) {
    const card = chartCard({
      kicker: 'Price moves',
      termKey: 'change7d',
      fallback: 'Price change, tracked tokens',
      ...moveOpts(),
      controls: segmented(PERIODS.map((p) => ({ value: p.value, label: p.label })), period.value, (v) => {
        period = PERIODS.find((p) => p.value === v);
        const o = moveOpts();
        // a period with fewer than two tokens of data has no chart to draw; the headline falls back to the title
        card.update({ ...o, take: o.take || null });
      }, 'Period'),
      src: [...priceSrc, ...chartSrc],
      csvName: 'token-price-change',
    });
    root.append(h('div', { style: { marginTop: '18px' } }, card));
  }

  // ---------- All coins: CoinGecko's market list ----------
  const cs = coins?.sources || {};
  const top = C.filter((r) => r.rank != null && r.rank <= 250 && r.change7d != null);
  root.append(h('section', { class: 'card', style: { marginTop: '18px' } },
    h('div', { class: 'kicker' }, 'All coins'),
    takeaway(top.length ? { pre: '', hl: `${top.filter((r) => r.change7d > 0).length} of the ${top.length} largest coins rose`, post: ' over the past 7 days' } : null, 'The largest coins by market cap'),
    C.length ? h('p', { class: 'chart-note' }, `${C.length} coins: CoinGecko’s 250 largest by market cap, plus the 250 largest in its DeFi category. Coins you track link to their page here; the rest link to CoinGecko.`) : null,
    C.some((r) => r.snapshot) ? h('p', { class: 'chart-note' }, `The ${C.filter((r) => r.snapshot).length} highlighted rows are tokens you track. Their numbers come from the price snapshot used in the tables above, not from this list’s own request, so each token shows one price on this page.`) : null,
    C.length
      ? dataTable({
        caption: 'All coins', csvName: 'coins', sortKey: 'rank', sortDir: 'asc', pageSize: 50,
        filters: [{ key: 'groupLabel', label: 'Group', plural: 'groups' }],
        rowClass: (r) => (r.tracked ? 'is-watch' : null),
        columns: [
          { key: 'rank', label: '#', num: true },
          { key: 'name', label: 'Coin', fmt: (v, r) => h('span', {}, r.tracked ? h('a', { href: `#/token/${r.id}`, class: 'name' }, v) : extLink(r.page, v, { class: 'name' }), h('span', { class: 'sub' }, ` ${r.symbol}`)) },
          { key: 'price', label: 'Price', num: true, fmt: (v) => usdPrice(v), termKey: 'price' },
          { key: 'change24h', label: '24h', num: true, fmt: delta },
          { key: 'change7d', label: '7d', num: true, fmt: delta, termKey: 'change7d' },
          { key: 'change30d', label: '30d', num: true, fmt: delta, termKey: 'change30d' },
          { key: 'mcap', label: 'Market cap', num: true, fmt: (v) => usd(v), termKey: 'marketCap' },
          { key: 'fdv', label: 'FDV', num: true, fmt: (v) => usd(v), termKey: 'fdv' },
          { key: 'volume24h', label: '24h volume', num: true, fmt: (v) => usd(v), termKey: 'volume24h' },
          { key: 'groupLabel', label: 'Group' },
        ],
        rows: C,
        csvExtra: [{ label: 'CoinGecko page', get: (r) => r.page }],
      })
      : unavailable('Coin list unavailable', coins?.unavailable || files['coins.json'].error),
    sourceLine([cs['cg-markets'], cs['cg-markets-defi'], cs['cg-snapshot'] ? { ...cs['cg-snapshot'], label: 'Price snapshot (rows for the tokens you track)' } : null].filter(Boolean))));
}
