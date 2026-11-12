// News + protocol blog/forum feeds (RSS/Atom). Only headline, date, a short
// snippet and the link are kept; the link always goes to the original article.
import { parseFeed } from './rss.mjs';
import { sourceRecord } from './sources.mjs';
import { truncate, mentions, slugify } from './util.mjs';

// Words that suggest an item is about a launch or an upgrade. Used only to
// label items; the label is shown as "type: launch / upgrade (keyword match)".
const LAUNCH_RE = /\b(launch(es|ed|ing)?|upgrade[sd]?|mainnet|migrat(e|es|ed|ion)|deploy(s|ed|ment)?|goes live|is live|now live|went live|introduc(es|ing)|unveil(s|ed)?|release[sd]?)\b/i;
const DEFI_RE = /\b(DeFi|stablecoins?|TVL|DEX|lending|tokeni[sz]ed|RWA|real[- ]world assets?|yield|perps?|perpetuals?)\b/i;

export async function fetchFeed(http, feed) {
  const res = await http.text(feed.url, { label: `Feed: ${feed.name}`, retries: 1, timeoutMs: 30000 });
  const source = sourceRecord({ name: feed.name, label: feed.type === 'governance-forum' ? 'Governance forum (RSS)' : feed.type === 'blog' ? 'Protocol blog (RSS)' : 'News (RSS)', page: siteOf(feed.url), res });
  if (!res.ok) return { items: [], source };
  try {
    const parsed = parseFeed(res.data);
    return { items: parsed.items, source: { ...source, feedTitle: parsed.title, itemCount: parsed.items.length } };
  } catch (e) {
    return { items: [], source: { ...source, ok: false, error: `Could not parse feed: ${e.message}` } };
  }
}

function siteOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return url;
  }
}

// Words in a title that suggest a change to what reaches token holders or to token supply.
// Used only to tag items "token economics (keyword match)" so they can be filtered.
const TOKENOMICS_RE = /\b(buy-?backs?|fee[- ]switch|burn(s|ed|ing)?|tokenomics|emissions?|revenue[- ]shar(e|ing)|fee[- ]shar(e|ing)|staking rewards?|vesting|unlock(s|ed|ing)?|token supply|treasury diversification)\b/i;

/**
 * "launch / upgrade" only when the launch is this protocol's: either the item comes from the
 * protocol's own blog or forum, or the protocol is named in the headline itself. A headline about
 * someone else's launch that merely mentions the protocol further down stays plain news.
 */
export function classify(title, baseType, { named = true } = {}) {
  return LAUNCH_RE.test(title) && named ? 'launch-upgrade' : baseType;
}

export function topicsOf(title) {
  return TOKENOMICS_RE.test(title || '') ? ['token-economics'] : [];
}

/**
 * Turn raw feed items into catalyst/news items.
 * protocols: [{ slug, name, symbol, keywords }]
 */
export function feedItems({ items, feed, srcKey, protocols, maxAgeDays = 30, ownerSlug = null }) {
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  const out = [];
  for (const it of items) {
    if (!it.date || Date.parse(it.date) < cutoff) continue;
    if (!/^https?:\/\//i.test(it.link || '')) continue; // never pass on javascript: or other odd links
    const text = `${it.title} ${it.summary || ''}`;
    const kw = (p) => (p.keywords?.length ? p.keywords : [p.name]);
    let matched = protocols.filter((p) => mentions(text, kw(p)));
    // where each protocol was found: in the headline, or only in the summary below it
    const inTitle = new Set(matched.filter((p) => mentions(it.title, kw(p))).map((p) => p.slug));
    if (ownerSlug) {
      const owner = protocols.find((p) => p.slug === ownerSlug);
      if (owner && !matched.includes(owner)) matched = [owner, ...matched];
      if (owner) inTitle.add(owner.slug); // an item from a protocol's own feed is about that protocol
    }
    const baseType = feed.type || 'news';
    const passing = matched.filter((p) => !inTitle.has(p.slug)).map((p) => p.slug);
    out.push({
      id: `${slugify(feed.name)}-${slugify(it.link).slice(-60)}`,
      date: it.date,
      type: classify(it.title, baseType, { named: inTitle.size > 0 }),
      // protocols named only in the summary, not the headline: the item mentions them in passing
      passing,
      topics: topicsOf(it.title),
      baseType,
      status: 'past',
      protocols: matched.map((p) => p.slug),
      symbols: matched.map((p) => p.symbol).filter(Boolean),
      title: truncate(it.title, 180),
      summary: truncate(it.summary, 240),
      url: it.link,
      sourceName: feed.name,
      src: srcKey,
      defi: DEFI_RE.test(text),
    });
  }
  return out;
}
