// 03 — Tokens overview
import { h, band, sourceLine, pageError, sparkline, takeaway, extLink, unavailable, snapshotNote, segmented, srcLinks, term } from '../ui.js';
import { chartCard } from '../cards.js';
import { loadMany } from '../data.js';
import { divergingChart } from '../charts.js';
import { dataTable } from '../table.js';
import { usd, usdPrice, pct, ratio, compact, date } from '../format.js';
import { priceMovesTakeaway, tokenValuationTakeaway, sizeTakeaway, unlockOverviewTakeaway } from '../takeaways.js';
import { STATUS as UNLOCK_STATUS, whenText, circText, daysText, docDate } from '../unlocks.js';
import { primaryOf, othersOf, measureLinks, measureDetail, KIND_TERM } from '../size.js';

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
  // what DefiLlama counts as fees for each protocol, in its own words (they differ a lot by type)
  const withDefs = rows.filter((r) => r.feesAre?.fees);
  const defsBlock = withDefs.length
    ? h('details', { class: 'src-details', style: { margin: '10px 0' } },
      h('summary', {}, `What “fees” and “revenue” mean for each of these ${withDefs.length} protocols, in DefiLlama’s words`),
      h('ul', { class: 'summary-list' }, withDefs.map((r) => h('li', {},
        h('b', {}, h('a', { href: `#/protocol/${r.slug}` }, r.name)), h('span', { class: 'sub' }, ` (${r.feesAre.from}${isNum(r.feesAre.shareOfFees) && r.feesAre.shareOfFees < 99.5 ? `, ${pct(r.feesAre.shareOfFees, { signed: false, digits: 0 })} of its fees` : ''})`),
        h('div', {}, h('b', {}, 'Fees: '), r.feesAre.fees),
        r.feesAre.revenue ? h('div', {}, h('b', {}, 'Revenue: '), r.feesAre.revenue) : null,
        h('div', {}, h('b', {}, 'Holders revenue: '), r.feesAre.holders || h('span', { class: 'muted' }, 'DefiLlama publishes no definition for this sub-protocol.'))))))
    : null;
  root.append(h('section', { class: 'card', style: { marginTop: '18px' } },
    h('div', { class: 'kicker' }, term('Valuation against earnings', 'valuationMultiple')),
    valHead,
    h('div', { class: 'chart-controls' }, segmented([{ value: 'mcap', label: 'Value by market cap' }, { value: 'fdv', label: 'Value by FDV' }], basis, (v) => { basis = v; renderValuation(); }, 'Valuation basis')),
    h('p', { class: 'chart-note' }, 'Each multiple is the token’s value divided by a year at the last 30 days’ pace (30-day total × 365 ÷ 30): a run-rate, not a forecast. “No revenue” means DefiLlama records $0, so there is nothing to divide by; a dash means the figure is missing. '),
    h('p', { class: 'chart-note' }, h('b', {}, 'Not like for like: '), '“Fees” is everything users pay, and how much of it is the protocol’s differs by type. A lender’s fees are all the interest its borrowers pay, and most of that goes to depositors; an exchange’s fees are trading fees it largely keeps. The “Kept” column shows the difference. Compare tokens on revenue, or on holders revenue, before fees.'),
    valHolder,
    defsBlock,
    sourceLine([...priceSrc, ...feeSrcs, ...(rows.find((r) => r.srcDefinitions) ? [{ ...rows.find((r) => r.srcDefinitions).srcDefinitions }] : [])])));

  // ---------- Size, in the measure that fits each protocol ----------
  const sized = rows.map((r) => ({ ...r, P: primaryOf(r.size) }));
  const kinds = [...new Set(sized.filter((r) => r.P).map((r) => r.P.label))];
  root.append(h('section', { class: 'card', style: { marginTop: '18px' } },
    h('div', { class: 'kicker' }, term('Size', 'sizeMeasure')),
    takeaway(sizeTakeaway(sized.filter((r) => r.P).map((r) => ({ name: r.name, kind: r.P.kind, label: r.P.label, value: r.P.value }))), 'How big each protocol is, in the measure that fits it'),
    h('p', { class: 'chart-note' }, h('b', {}, 'Not like for like: '), 'TVL counts deposits held in a protocol’s contracts. That fits lenders and vaults, but a real-world-asset issuer holds its assets off-chain (so its TVL is blank) and a perps exchange’s TVL is only the collateral bridged in. Each protocol is sized here by the measure that fits it, and the measures are not interchangeable: sort within one measure, and don’t divide a market cap by a mix of them.'),
    dataTable({
      caption: 'Protocol size', csvName: 'token-protocol-size', sortKey: 'sizeValue', pageSize: 50,
      filters: [{ key: 'sizeLabel', label: 'Measure', plural: 'measures' }, { key: 'groupLabel', label: 'List', plural: 'lists' }],
      searchKeys: ['symbol', 'name', 'category'],
      rowClass: (r) => (r.group === 'watchlist' ? 'is-watch' : null),
      columns: [
        { key: 'symbol', label: 'Token', fmt: tokenCell },
        { key: 'category', label: 'Category', termKey: 'category' },
        { key: 'sizeLabel', label: 'Measure', fmt: (v, r) => (r.P ? term(r.P.label, KIND_TERM[r.P.kind]) : h('span', { class: 'muted', title: r.size?.unavailable || '' }, '—')) },
        { key: 'sizeValue', label: 'Size', num: true, fmt: (v, r) => (r.P ? h('span', {}, usd(r.P.value), r.P.stale ? h('span', { class: 'sub' }, ' (stale)') : null) : '—') },
        { key: 'size30d', label: '30d', num: true, fmt: (v) => (isNum(v) ? delta(v) : '—'), title: 'TVL and open interest: today against 30 days ago. Not available for tokenized assets (the yields list has no history).' },
        { key: 'mcap', label: 'Market cap', num: true, fmt: (v) => usd(v), termKey: 'marketCap' },
        { key: 'also', label: 'Also', wrap: true, fmt: (v, r) => (othersOf(r.size).length ? h('span', { class: 'sub' }, othersOf(r.size).map((m) => `${m.label} ${usd(m.value)}`).join(' · ')) : ''), csv: (r) => othersOf(r.size).map((m) => `${m.label} ${m.value}`).join('; ') },
        { key: 'detail', label: 'What is counted', wrap: true, fmt: (v, r) => (r.P ? h('span', { class: 'sub' }, measureDetail(r.P) || r.P.what) : h('span', { class: 'sub' }, r.size?.unavailable || '')), csv: (r) => (r.P ? measureDetail(r.P) || r.P.what : r.size?.unavailable || '') },
        { key: 'check', label: 'Check', wrap: true, fmt: (v, r) => (r.P ? measureLinks(r.P, r.sizeSources || {}) : ''), csv: (r) => (r.P ? r.sizeSources?.[r.P.src]?.api || '' : '') },
      ],
      rows: sized.map((r) => ({ ...r, sizeLabel: r.P?.label || null, sizeValue: r.P?.value ?? null, size30d: r.P?.change30d ?? null })),
    }),
    h('p', { class: 'chart-note' }, kinds.length ? `Measures in use: ${kinds.join(', ')}. ` : '', 'Tokenized assets come from DefiLlama’s yields list, because its dedicated real-world-asset dataset is on the paid plan; products with no listing there are named in “What is counted” and not included.'),
    sourceLine(Object.values(Object.fromEntries(sized.flatMap((r) => (r.P && r.sizeSources?.[r.P.src] ? [[`${r.P.src}|${r.P.src === 'dl-protocol' ? r.slug : ''}`, { ...r.sizeSources[r.P.src], label: r.P.src === 'dl-protocol' ? `${r.name}: TVL` : r.sizeSources[r.P.src].label }]] : [])))))));

  // ---------- Upcoming unlocks ----------
  const U = rows.map((r) => ({ ...r, u: r.unlock || null }));
  if (U.some((r) => r.u)) {
    const sym = (r) => r.symbol || r.tokenId;
    root.append(h('section', { class: 'card', style: { marginTop: '18px' } },
      h('div', { class: 'kicker' }, term('Upcoming unlocks', 'unlock')),
      takeaway(unlockOverviewTakeaway(U.map((r) => ({ symbol: sym(r), status: r.u?.status || 'unconfirmed', pct12m: r.u?.next12m?.pctCirculating ?? null, unknown12m: r.u?.next12m?.unknown || 0, events12m: r.u?.next12m?.events || 0 }))), 'Scheduled token unlocks for the tokens you track'),
      h('p', { class: 'chart-note' }, 'Dates and amounts are taken by hand from each project’s own documents, because every unlock API needs a paid key. “Unconfirmed” means no schedule could be confirmed from those documents; it does not mean nothing unlocks. Values use today’s price and will move with it. “Next 12 months” adds up only the tranches with a published amount.'),
      dataTable({
        caption: 'Upcoming token unlocks', csvName: 'token-unlocks', sortKey: 'pct12', pageSize: 50, search: false,
        filters: [{ key: 'statusLabel', label: 'Status', plural: 'statuses' }],
        rowClass: (r) => (r.group === 'watchlist' ? 'is-watch' : null),
        columns: [
          { key: 'symbol', label: 'Token', fmt: tokenCell },
          { key: 'statusLabel', label: 'Schedule' },
          { key: 'nextTs', label: 'Next unlock', fmt: (v, r) => (r.u?.next ? whenText(r.u.next.ts, r.u.next.precision) : '—'), csv: (r) => (r.u?.next ? (r.u.next.precision === 'month' ? new Date(r.u.next.ts * 1000).toISOString().slice(0, 7) : new Date(r.u.next.ts * 1000).toISOString().slice(0, 10)) : '') },
          { key: 'nextTokens', label: 'Amount', num: true, fmt: (v, r) => (r.u?.next ? (v != null ? `${compact(v, 2)} ${sym(r)}` : h('span', { class: 'sub' }, 'not published')) : '—') },
          { key: 'nextUsd', label: 'Value today', num: true, fmt: (v) => (v != null ? usd(v) : '—'), title: 'Calculated: tokens × the price snapshot' },
          { key: 'nextPct', label: '% of circulating', num: true, fmt: (v) => circText(v), title: 'Calculated: tokens ÷ circulating supply' },
          { key: 'nextDays', label: 'Days of volume', num: true, fmt: (v) => daysText(v), title: 'Calculated: value ÷ 24-hour trading volume' },
          { key: 'pct12', label: 'Next 12 months', num: true, fmt: (v, r) => (v != null ? h('span', {}, `${circText(v)} of circulating`, r.u.next12m.unknown ? h('span', { class: 'sub' }, ` + ${r.u.next12m.unknown} of unpublished size`) : null) : r.u?.next12m?.events ? h('span', { class: 'sub' }, `${r.u.next12m.events} dated, size not published`) : '—'), title: 'Calculated: tokens due in the next 12 months with a published amount ÷ circulating supply' },
          { key: 'usd12', label: '12-month value today', num: true, fmt: (v) => (v != null ? usd(v) : '—') },
          { key: 'vestPct', label: 'Vesting continuously', wrap: true, fmt: (v, r) => ((r.u?.vesting || []).length ? h('span', { class: 'sub' }, r.u.vesting.map((s) => `${s.label}: about ${compact(s.tokensPerMonth, 2)} ${sym(r)} a month${s.pctCirculatingPerMonth != null ? ` (${circText(s.pctCirculatingPerMonth)} of circulating${s.usdPerMonth != null ? `, ${usd(s.usdPerMonth)}` : ''})` : ''} until ${docDate(s.end)}`).join('; ')) : '—'), csv: (r) => (r.u?.vesting || []).map((s) => `${s.label}: ${s.tokensPerMonth} a month until ${s.end}`).join('; '), title: 'Linear vesting: the total in the project’s documents spread evenly over the vesting window' },
          { key: 'source', label: 'Checked against', wrap: true, fmt: (v, r) => (r.u?.source?.url ? h('span', { class: 'sub' }, extLink(r.u.source.url, r.u.source.label), r.u.lastChecked ? ` · checked ${date(Date.parse(`${r.u.lastChecked}T00:00:00Z`))}` : '') : h('span', { class: 'sub' }, 'no published source')), csv: (r) => r.u?.source?.url || '' },
        ],
        rows: U.map((r) => ({ ...r, vestPct: (r.u?.vesting || []).reduce((s, x) => s + (x.pctCirculatingPerMonth || 0), 0) || null, statusLabel: UNLOCK_STATUS[r.u?.status] || 'Unconfirmed', nextTs: r.u?.next?.ts ?? null, nextTokens: r.u?.next?.tokens ?? null, nextUsd: r.u?.next?.usd ?? null, nextPct: r.u?.next?.pctCirculating ?? null, nextDays: r.u?.next?.daysOfVolume ?? null, pct12: r.u?.next12m?.pctCirculating ?? null, usd12: r.u?.next12m?.usd ?? null })),
      }),
      h('p', { class: 'src' }, 'Each token page has the full schedule, the passage it was taken from and the vesting still running. Sizes are calculated from the price snapshot above.'),
      sourceLine(priceSrc)));
  }

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
