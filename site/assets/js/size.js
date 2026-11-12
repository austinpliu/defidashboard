// Size measures (TVL, tokenized assets, open interest, loans outstanding) and DefiLlama's fee
// definitions, shared by the Tokens, Protocols and protocol pages.
// Data: index.json › protocols[].size and protocols/<slug>.json › size / definitions.
import { h, extLink, term, srcLinks } from './ui.js';
import { usd, pct, dateTime } from './format.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const KIND_TERM = { tvl: 'tvl', tokenized: 'tokenizedAssets', openInterest: 'openInterest', borrowed: 'loansOutstanding' };

export const primaryOf = (size) => size?.measures?.find((m) => m.kind === size.primary) || null;
export const othersOf = (size) => (size?.measures || []).filter((m) => m.kind !== size.primary);

/** "$2.4B" with a small label saying which measure it is (when it isn't TVL). */
export function sizeCell(size, { always = false } = {}) {
  const m = primaryOf(size);
  if (!m) return h('span', { class: 'muted', title: size?.unavailable || 'No size measure for this protocol' }, '—');
  return h('span', { title: m.what }, usd(m.value), m.kind !== 'tvl' || always ? h('span', { class: 'sub' }, ` ${m.label.toLowerCase()}`) : null, m.stale ? h('span', { class: 'sub' }, ' (stale)') : null);
}

/** Where one measure can be checked: its API endpoint, and for listings the DefiLlama pages. */
export function measureLinks(m, sources = {}) {
  const src = sources[m.src];
  const out = h('span', { class: 'sub' });
  const parts = [];
  if (src) parts.push(srcLinks([[m.kind === 'tokenized' ? 'yields list' : m.kind === 'openInterest' ? 'open interest' : 'protocol', src]]));
  for (const p of m.projects || []) if (p.page) parts.push(extLink(p.page, `${p.project} listings`, { title: `${usd(p.value)} across this project’s listings` }));
  for (const v of m.venues || []) if (v.page) parts.push(extLink(v.page, v.name, { title: `${usd(v.value)} open interest` }));
  parts.forEach((p, i) => { if (i) out.append(' · '); out.append(p); });
  return out;
}

/** One sentence on what a measure covers for this protocol, from the data. */
export function measureDetail(m) {
  if (m.kind === 'tokenized') {
    const top = (m.top || []).slice(0, 2).map((t) => `${t.meta || t.symbol} on ${t.chain} (${usd(t.value)})`).join(', ');
    return `${m.listings} listing${m.listings === 1 ? '' : 's'} in DefiLlama’s yields list${top ? `; largest: ${top}` : ''}.${m.notListed?.length ? ` Not included (no listings): ${m.notListed.join(', ')}.` : ''}`;
  }
  if (m.kind === 'openInterest') return `${(m.venues || []).map((v) => `${v.name} ${usd(v.value)}`).join(', ')}.`;
  return '';
}

/** A table of every size measure a protocol has (protocol page). */
export function sizeTable(size, sources = {}) {
  const ms = size?.measures || [];
  if (!ms.length) return null;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Measure'), h('th', { class: 'n' }, 'Value'), h('th', { class: 'n' }, '30d'), h('th', {}, 'What it measures'), h('th', {}, 'Check'))),
    h('tbody', {}, ms.map((m) => h('tr', {},
      h('td', {}, term(m.label, KIND_TERM[m.kind]), m.kind === size.primary ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'used for this protocol') : null),
      h('td', { class: 'n' }, usd(m.value), m.stale ? h('div', { class: 'sub' }, `stale: from ${dateTime(m.stale.lastGoodAt)}`) : null),
      h('td', { class: 'n' }, isNum(m.change30d) ? h('span', { class: `delta ${m.change30d > 0 ? 'up' : m.change30d < 0 ? 'down' : 'flat'}` }, pct(m.change30d)) : '—'),
      h('td', { class: 'sub wrap' }, m.what, measureDetail(m) ? ` ${measureDetail(m)}` : ''),
      h('td', { class: 'wrap' }, measureLinks(m, sources)))))));
}

const DEF_LABEL = { Fees: 'Fees', Revenue: 'Revenue', HoldersRevenue: 'Holders revenue', SupplySideRevenue: 'Paid on to others' };

/** DefiLlama's own words for what it counts, per sub-protocol (largest by fees first). */
export function definitionsList(defs, { max = 3, keys = ['Fees', 'Revenue', 'HoldersRevenue'] } = {}) {
  const list = (defs?.list || []).slice(0, max);
  if (!list.length) return null;
  return h('div', {}, list.map((d) => h('div', { style: { marginTop: '10px' } },
    h('p', { class: 'chart-title', style: { margin: '0 0 4px' } }, d.page ? extLink(d.page, d.name) : d.name,
      h('span', { class: 'sub' }, isNum(d.fees30d) ? ` · ${usd(d.fees30d)} of fees in 30 days${isNum(d.shareOfFees) && list.length > 1 ? ` (${pct(d.shareOfFees, { signed: false, digits: 0 })} of the total)` : ''}` : ''),
      d.methodologyUrl ? h('span', { class: 'sub' }, ' · ', extLink(d.methodologyUrl, 'how it is calculated (code)')) : null),
    h('ul', { class: 'summary-list' }, keys.map((k) => h('li', {}, h('b', {}, `${DEF_LABEL[k] || k}: `), d.methodology[k] || h('span', { class: 'muted' }, 'DefiLlama publishes no definition for this sub-protocol.')))))));
}
