// A size measure that fits each kind of protocol, and DefiLlama's own definitions of fees and
// revenue for it. Pure functions, unit-tested.
//
// TVL (deposits held in a protocol's contracts) is a fair size measure for lenders and vaults,
// but it is blank for real-world-asset issuers (the assets sit off-chain) and misleading for a
// perps exchange (its "TVL" is the collateral bridged in, not the trading it hosts). So each
// protocol gets every measure the free APIs have for it, and one is marked as the primary:
//   - tokenized assets  (RWA issuers)   sum of the protocol's listings in DefiLlama's yields list
//   - open interest     (perps venues)  DefiLlama /overview/open-interest
//   - TVL               (everyone else) DefiLlama /protocol/{slug}
// Lenders also get "loans outstanding" (DefiLlama's borrowed balance) as a second measure.
// These measure different things. The site shows them side by side and never divides a market
// cap by a mix of them.
import { DL } from './defillama.mjs';
import { roundSmart, num, pctChange } from './util.mjs';

export const SIZE_KINDS = {
  tvl: { label: 'TVL', what: 'Deposits held in the protocol’s contracts right now. Coins lent on to borrowers are not included.' },
  tokenized: { label: 'Tokenized assets', what: 'The dollar value of the tokens the issuer has outstanding, added up from its listings in DefiLlama’s yields list. The assets themselves sit off-chain with a custodian, so this is the amount issued, not deposits in a contract.' },
  openInterest: { label: 'Open interest', what: 'The dollar value of all open perpetual-futures positions. It measures trading exposure, not deposits: positions use leverage, so it can be larger than the collateral behind it.' },
  borrowed: { label: 'Loans outstanding', what: 'What borrowers currently owe. This is the balance a lender earns interest on; DefiLlama leaves it out of TVL so the same coins aren’t counted twice.' },
};

/** Every yield-list entry for a protocol's project slugs, added up (RWA issuers' tokens are listed there). */
export function tokenizedAssets(poolsRes, slugs) {
  if (!poolsRes?.ok || !Array.isArray(poolsRes.data?.data)) return null;
  const mine = poolsRes.data.data.filter((p) => slugs.has(p.project) && num(p.tvlUsd) > 0);
  if (!mine.length) return null;
  const byProject = new Map();
  for (const p of mine) byProject.set(p.project, (byProject.get(p.project) || 0) + p.tvlUsd);
  const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1]).map(([project, v]) => ({ project, value: roundSmart(v), page: `${DL.site}/yields?project=${encodeURIComponent(project)}` }));
  return {
    value: roundSmart(mine.reduce((s, p) => s + p.tvlUsd, 0)),
    listings: mine.length,
    projects,
    // sub-protocols with nothing in the yields list are not in the total: name them
    notListed: [...slugs].filter((s) => !byProject.has(s)),
    top: [...mine].sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 5).map((p) => ({ symbol: p.symbol, chain: p.chain, meta: p.poolMeta || null, value: roundSmart(p.tvlUsd), page: `${DL.site}/yields/pool/${p.pool}` })),
  };
}

/** Open interest of a protocol's perps venues, from DefiLlama's open-interest overview. */
export function openInterestFor(oiRes, { parentIds = new Set(), ids = new Set(), slugs = new Set() } = {}) {
  const list = oiRes?.ok && Array.isArray(oiRes.data?.protocols) ? oiRes.data.protocols : null;
  if (!list) return null;
  const mine = list.filter((p) => (p.parentProtocol && parentIds.has(p.parentProtocol)) || ids.has(String(p.defillamaId ?? p.id)) || slugs.has(p.slug)).filter((p) => num(p.total24h) > 0);
  if (!mine.length) return null;
  const sum = (k) => { const vals = mine.map((p) => num(p[k])); return vals.every((v) => v !== null) ? vals.reduce((s, v) => s + v, 0) : null; };
  const now = sum('total24h');
  const weekAgo = sum('total7DaysAgo');
  const monthAgo = sum('total30DaysAgo');
  return {
    value: roundSmart(now),
    weekAgo: roundSmart(weekAgo),
    monthAgo: roundSmart(monthAgo),
    change7d: roundSmart(pctChange(now, weekAgo)),
    change30d: roundSmart(pctChange(now, monthAgo)),
    venues: mine.sort((a, b) => b.total24h - a.total24h).map((p) => ({ name: p.displayName || p.name, slug: p.slug || null, value: roundSmart(p.total24h), page: p.slug ? `${DL.site}/protocol/${p.slug}` : null })),
  };
}

/**
 * All size measures for one protocol, with the primary one first.
 * tvl: the protocol's tvl section ({ value, change30d, unavailable }); borrowed: number or null.
 */
export function sizeMeasures({ category, tvl, borrowed, tokenized, openInterest }) {
  const out = [];
  const add = (kind, fields) => out.push({ kind, label: SIZE_KINDS[kind].label, what: SIZE_KINDS[kind].what, ...fields });
  if (num(tvl?.value) > 0) add('tvl', { value: tvl.value, change30d: tvl.change30d ?? null, src: 'dl-protocol' });
  if (num(borrowed) > 0) add('borrowed', { value: roundSmart(borrowed), change30d: null, src: 'dl-protocol' });
  if (tokenized && num(tokenized.value) > 0) add('tokenized', { value: tokenized.value, change30d: null, src: 'dl-yields', listings: tokenized.listings, projects: tokenized.projects, notListed: tokenized.notListed, top: tokenized.top });
  if (openInterest && num(openInterest.value) > 0) add('openInterest', { value: openInterest.value, change30d: openInterest.change30d, change7d: openInterest.change7d, src: 'dl-open-interest', venues: openInterest.venues });
  const has = (k) => out.find((m) => m.kind === k);
  // RWA issuers are measured by what they have issued; a derivatives venue by its open interest;
  // everything else by TVL. With no TVL at all, fall back to whatever exists.
  const primary = (category === 'RWA' && has('tokenized'))
    || (category === 'Derivatives' && has('openInterest'))
    || has('tvl') || has('tokenized') || has('openInterest') || null;
  return {
    primary: primary ? primary.kind : null,
    measures: primary ? [primary, ...out.filter((m) => m !== primary)] : out,
    ...(primary ? {} : { unavailable: tvl?.unavailable || 'DefiLlama has no TVL, yield listings or open interest for this protocol.' }),
  };
}

const METHOD_KEYS = ['Fees', 'Revenue', 'HoldersRevenue', 'SupplySideRevenue', 'ProtocolRevenue', 'UserFees'];

/**
 * DefiLlama's own description of what it counts as fees, revenue and holders revenue for each of
 * a protocol's sub-protocols (they differ: a lender's fees are borrower interest, an RWA
 * issuer's are the yield its holders earn). Largest by 30-day fees first.
 */
export function feeDefinitions(feesRes, { parentIds = new Set(), ids = new Set(), slugs = new Set() } = {}, limit = 5) {
  const list = feesRes?.ok && Array.isArray(feesRes.data?.protocols) ? feesRes.data.protocols : null;
  if (!list) return null;
  const mine = list
    .filter((p) => (p.parentProtocol && parentIds.has(p.parentProtocol)) || ids.has(String(p.defillamaId ?? p.id)) || (p.slug && slugs.has(p.slug)))
    .filter((p) => p.methodology && typeof p.methodology === 'object');
  if (!mine.length) return null;
  const total = mine.reduce((s, p) => s + (num(p.total30d) || 0), 0);
  return mine
    .sort((a, b) => (num(b.total30d) || 0) - (num(a.total30d) || 0))
    .slice(0, limit)
    .map((p) => ({
      name: p.displayName || p.name,
      slug: p.slug || null,
      category: p.category || null,
      fees30d: roundSmart(p.total30d),
      shareOfFees: total > 0 ? roundSmart(((num(p.total30d) || 0) / total) * 100) : null,
      methodology: Object.fromEntries(METHOD_KEYS.filter((k) => typeof p.methodology[k] === 'string' && p.methodology[k].trim()).map((k) => [k, p.methodology[k].trim()])),
      methodologyUrl: typeof p.methodologyURL === 'string' && /^https?:\/\//.test(p.methodologyURL) ? p.methodologyURL : null,
      page: p.slug ? `${DL.site}/protocol/${p.slug}` : null,
    }));
}
