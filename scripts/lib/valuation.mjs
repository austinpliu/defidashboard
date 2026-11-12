// Valuation ratios for one protocol's token: what the market pays for a year of fees, of
// revenue, and of the revenue that reaches token holders. Pure functions, unit-tested.
//
// Every ratio is "value ÷ (last 30 days × 365 ÷ 30)". A ratio is null (shown as a dash) when
// either side is missing or the 30-day figure is zero: a token with no revenue has no
// price-to-revenue ratio, and the site says "no revenue" instead of inventing one.
import { derivedRecord } from './sources.mjs';
import { roundSmart, num } from './util.mjs';

export const annualize = (x30) => (num(x30) === null ? null : (num(x30) * 365) / 30);
export const ratioOf = (a, b) => (num(a) !== null && num(b) !== null && num(b) > 0 ? roundSmart(num(a) / num(b)) : null);
export const shareOf = (part, whole) => (num(part) !== null && num(whole) !== null && num(whole) > 0 ? roundSmart((num(part) / num(whole)) * 100) : null);

/**
 * fees30 / rev30 / hold30: DefiLlama 30-day totals (null when DefiLlama has none).
 * mcap / fdv: CoinGecko, from the price snapshot. tvl: DefiLlama.
 * Returns { key: { value, src } } where src names a "Calculated" source record.
 */
export function valuationRatios({ fees30, rev30, hold30, mcap, fdv, tvl }) {
  const aF = annualize(fees30);
  const aR = annualize(rev30);
  const aH = annualize(hold30);
  return {
    annualizedFees: { value: roundSmart(aF), src: 'calc-annual-fees' },
    annualizedRevenue: { value: roundSmart(aR), src: 'calc-annual-revenue' },
    annualizedHoldersRevenue: { value: roundSmart(aH), src: 'calc-annual-holders' },
    mcapToFees: { value: ratioOf(mcap, aF), src: 'calc-mcap-fees' },
    mcapToRevenue: { value: ratioOf(mcap, aR), src: 'calc-mcap-revenue' },
    mcapToHoldersRevenue: { value: ratioOf(mcap, aH), src: 'calc-mcap-holders' },
    fdvToFees: { value: ratioOf(fdv, aF), src: 'calc-fdv-fees' },
    fdvToRevenue: { value: ratioOf(fdv, aR), src: 'calc-fdv-revenue' },
    fdvToHoldersRevenue: { value: ratioOf(fdv, aH), src: 'calc-fdv-holders' },
    mcapToTvl: { value: ratioOf(mcap, tvl), src: 'calc-mcap-tvl' },
    // how much of what users pay the protocol keeps, and how much of that reaches holders
    revenueShare: { value: shareOf(rev30, fees30), src: 'calc-revenue-share' },
    holdersShare: { value: shareOf(hold30, rev30), src: 'calc-holders-share' },
    // market cap as a share of FDV: how much of the eventual supply is already priced in as circulating
    mcapToFdv: { value: shareOf(mcap, fdv), src: 'calc-mcap-fdv' },
  };
}

/** The "Calculated" source records for the ratios above. mSrc: where market cap and FDV came from. */
export function valuationSources(mSrc = 'cg-coin') {
  return {
    'calc-annual-fees': derivedRecord({ label: 'Annualized fees', from: ['dl-fees'], formula: 'Last 30 days of fees × 365 ÷ 30' }),
    'calc-annual-revenue': derivedRecord({ label: 'Annualized revenue', from: ['dl-revenue'], formula: 'Last 30 days of revenue × 365 ÷ 30' }),
    'calc-annual-holders': derivedRecord({ label: 'Annualized holders revenue', from: ['dl-holders-revenue'], formula: 'Last 30 days of holders revenue × 365 ÷ 30' }),
    'calc-mcap-fees': derivedRecord({ label: 'Market cap ÷ annualized fees', from: [mSrc, 'dl-fees'], formula: 'CoinGecko market cap ÷ (30-day fees × 365 ÷ 30)' }),
    'calc-mcap-revenue': derivedRecord({ label: 'Market cap ÷ annualized revenue', from: [mSrc, 'dl-revenue'], formula: 'CoinGecko market cap ÷ (30-day revenue × 365 ÷ 30)' }),
    'calc-mcap-holders': derivedRecord({ label: 'Market cap ÷ annualized holders revenue', from: [mSrc, 'dl-holders-revenue'], formula: 'CoinGecko market cap ÷ (30-day holders revenue × 365 ÷ 30)' }),
    'calc-fdv-fees': derivedRecord({ label: 'Fully diluted value ÷ annualized fees', from: [mSrc, 'dl-fees'], formula: 'CoinGecko FDV ÷ (30-day fees × 365 ÷ 30)' }),
    'calc-fdv-revenue': derivedRecord({ label: 'Fully diluted value ÷ annualized revenue', from: [mSrc, 'dl-revenue'], formula: 'CoinGecko FDV ÷ (30-day revenue × 365 ÷ 30)' }),
    'calc-fdv-holders': derivedRecord({ label: 'Fully diluted value ÷ annualized holders revenue', from: [mSrc, 'dl-holders-revenue'], formula: 'CoinGecko FDV ÷ (30-day holders revenue × 365 ÷ 30)' }),
    'calc-mcap-tvl': derivedRecord({ label: 'Market cap ÷ TVL', from: [mSrc, 'dl-protocol'], formula: 'CoinGecko market cap ÷ DefiLlama TVL' }),
    'calc-revenue-share': derivedRecord({ label: 'Revenue as % of fees', from: ['dl-fees', 'dl-revenue'], formula: '30-day revenue ÷ 30-day fees × 100' }),
    'calc-holders-share': derivedRecord({ label: 'Holders revenue as % of revenue', from: ['dl-revenue', 'dl-holders-revenue'], formula: '30-day holders revenue ÷ 30-day revenue × 100' }),
    'calc-mcap-fdv': derivedRecord({ label: 'Market cap as % of FDV', from: [mSrc], formula: 'CoinGecko market cap ÷ CoinGecko FDV × 100' }),
  };
}
