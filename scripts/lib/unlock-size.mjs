// How big an unlock is, in terms a reader can weigh: dollars at today's price, share of the
// supply already circulating, and days of trading volume. Pure functions, unit-tested.
//
// The token amounts come from the hand-checked unlocks.json (each project's own docs); these
// figures are calculated from them and the price snapshot. An unlock with no published amount
// gets no size: the site says "not published" rather than estimating one.
import { derivedRecord } from './sources.mjs';
import { roundSmart, num } from './util.mjs';

/** tokens → { usd, pctCirculating, daysOfVolume }, each null when an input is missing. */
export function unlockSize(tokens, { price, circulating, volume24h } = {}) {
  const t = num(tokens);
  if (t === null || t <= 0) return { usd: null, pctCirculating: null, daysOfVolume: null };
  const p = num(price);
  const usd = p !== null && p > 0 ? t * p : null;
  const circ = num(circulating);
  const vol = num(volume24h);
  return {
    usd: roundSmart(usd),
    pctCirculating: circ !== null && circ > 0 ? roundSmart((t / circ) * 100) : null,
    daysOfVolume: usd !== null && vol !== null && vol > 0 ? roundSmart(usd / vol) : null,
  };
}

/**
 * Add sizes to a token's unlock data (as built by buildTokenUnlocks) and summarise what is
 * ahead. Returns a new object; `u` is not changed.
 */
export function sizeTokenUnlocks(u, market = {}, supply = {}, now = Date.now()) {
  if (!u) return u;
  const ctx = { price: market.price, circulating: supply.circulating, volume24h: market.volume24h };
  const events = (u.events || []).map((e) => ({ ...e, ...unlockSize(e.tokens, ctx) }));
  const schedules = (u.schedules || []).map((s) => {
    const perMonth = s.type === 'monthly' ? s.tokensPerPeriod : s.tokensPerMonth;
    const z = unlockSize(perMonth, ctx);
    return { ...s, usdPerMonth: z.usd, pctCirculatingPerMonth: z.pctCirculating };
  });
  // the next 12 months: dated releases with a published amount, plus how many have none
  const ahead = events.filter((e) => e.ts * 1000 > now && e.ts * 1000 <= now + 365 * 86400e3 && e.kind !== 'vesting-end');
  const known = ahead.filter((e) => e.tokens != null);
  const tokens12 = known.reduce((s, e) => s + e.tokens, 0);
  const next = ahead[0] || null;
  return {
    ...u,
    events,
    schedules,
    next: next ? { ts: next.ts, precision: next.precision, label: next.label, tokens: next.tokens, share: next.share, usd: next.usd, pctCirculating: next.pctCirculating, daysOfVolume: next.daysOfVolume, sourceUrl: next.source?.url || null } : null,
    next12m: { events: ahead.length, unknown: ahead.length - known.length, ...(known.length ? { tokens: roundSmart(tokens12), ...unlockSize(tokens12, ctx) } : { tokens: null, usd: null, pctCirculating: null, daysOfVolume: null }) },
    // vesting that releases continuously (no dated tranches): the docs' total spread evenly over the window
    vesting: schedules.filter((s) => s.ongoing && s.type === 'linear' && s.tokensPerMonth != null).map((s) => ({ label: s.label, end: s.end, tokensPerMonth: roundSmart(s.tokensPerMonth), usdPerMonth: s.usdPerMonth, pctCirculatingPerMonth: s.pctCirculatingPerMonth, sourceUrl: s.source?.url || null })),
    sizedAt: ctx.price != null ? { price: num(ctx.price), circulating: num(ctx.circulating), volume24h: num(ctx.volume24h) } : null,
  };
}

/** "≈ $13.2M at today's price · 1.2% of circulating supply · 0.1 days of trading volume" */
export function sizeText(z) {
  if (!z || z.usd == null) return '';
  const money = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`);
  const parts = [`about ${money(z.usd)} at today’s price`];
  if (z.pctCirculating != null) parts.push(`${Number(z.pctCirculating.toPrecision(2))}% of circulating supply`);
  if (z.daysOfVolume != null) parts.push(`${z.daysOfVolume >= 10 ? Math.round(z.daysOfVolume) : Number(z.daysOfVolume.toPrecision(2))} day${z.daysOfVolume === 1 ? '' : 's'} of trading volume`);
  return parts.join(' · ');
}

export const unlockSizeSource = (unlockSrc, marketSrc) => derivedRecord({
  label: 'Unlock size',
  from: [unlockSrc, marketSrc].filter(Boolean),
  formula: 'Value: tokens × the price snapshot. Share: tokens ÷ circulating supply. Days of volume: value ÷ 24-hour trading volume',
});
