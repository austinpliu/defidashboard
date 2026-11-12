// Runs the whole data script offline against SYNTHETIC stub responses
// (tests/fixtures/stub-fetch.mjs) and checks the files it writes.
// Output goes to a temporary folder — never to site/data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('pipeline writes every file with sources and handles failures honestly', () => {
  const out = mkdtempSync(join(tmpdir(), 'defi-dash-test-'));
  try {
    execFileSync(process.execPath, ['--import', './tests/fixtures/stub-fetch.mjs', 'scripts/fetch-data.mjs'], {
      cwd: ROOT,
      env: { ...process.env, DATA_OUT_DIR: out, WATCHLIST_FILE: 'tests/fixtures/watchlist.test.json', HTTP_NO_PACING: '1', PROBE: '0', UNLOCKS_REPO_PROBE: '0', UNLOCKS_FILE: 'tests/fixtures/unlocks.test.json' },
      stdio: 'pipe',
    });
    const read = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
    for (const f of ['market.json', 'catalysts.json', 'index.json', 'meta.json', 'screener.json', 'coins.json', 'predictions.json', 'fundamentals.json', 'protocols/alpha.json', 'tokens/alpha-token.json']) {
      assert.ok(existsSync(join(out, f)), `${f} written`);
    }
    const market = read('market.json');
    for (const k of ['tvl', 'stablecoins', 'dexVolume', 'fees']) {
      const h = market.headline[k];
      assert.ok(Number.isFinite(h.value), `${k} has a value`);
      assert.ok(market.sources[h.src]?.api?.startsWith('https://'), `${k} cites an API endpoint`);
      assert.ok(market.sources[h.src]?.fetchedAt, `${k} has fetchedAt`);
    }
    assert.equal(market.topFees.list[0].name, 'Beta');
    assert.ok(market.topFees.list.every((p) => p.name !== 'Ethereum'), 'chains are not ranked as protocols');

    const alpha = read('protocols/alpha.json');
    assert.equal(alpha.about.description, 'alpha is a synthetic test protocol. It exists only in tests.');
    assert.ok(alpha.tvl.series.length > 100);
    assert.ok(alpha.hacks.unavailable, 'Pro-only hacks endpoint is reported as unavailable, not faked');
    assert.ok(alpha.sources['dl-emissions'].error, "DefiLlama's paid unlock endpoint is still reported honestly");
    assert.equal(alpha.unlocks.status, 'scheduled', 'hand-checked unlocks.json fills in when DefiLlama is paid-only');
    const tokA = read('tokens/alpha-token.json');
    assert.equal(tokA.unlocks.events.length, 12, 'twelve monthly tranches ahead');
    assert.equal(tokA.unlocks.events[0].tokens, 160000, 'share of supply × CoinGecko max supply');
    assert.equal(tokA.unlocks.events[0].precision, 'month', 'no invented day of the month');
    assert.ok(tokA.sources[tokA.unlocks.src].manual, 'marked as manually sourced');
    assert.equal(alpha.governance.proposals.length, 3);
    assert.ok(alpha.derived.mcapToFees.value > 0);
    assert.equal(alpha.sources['calc-mcap-fees'].derived, true);

    // one price snapshot: the token page, the index, the protocol page and the coin list agree
    assert.equal(tokA.market.src, 'cg-snapshot', 'tracked tokens take their price from the shared snapshot');
    assert.equal(tokA.market.price, 101, 'snapshot price, not the per-token request (100) or the market list (500)');
    assert.ok(tokA.sources['cg-snapshot'].api.includes('ids='), 'the snapshot cites its exact endpoint');
    assert.ok(tokA.sources['cg-snapshot'].fetchedAt, 'and its fetch time');
    assert.equal(tokA.market.change30d, 9);
    assert.equal(tokA.market.change1y, 48);
    assert.ok(Number.isFinite(tokA.market.change90d), '90-day change is calculated from the snapshot price and the daily history');
    assert.equal(alpha.token.market.price, 101, 'the protocol page shows the same price');
    assert.equal(alpha.token.market.marketCap, tokA.market.marketCap);
    assert.deepEqual(alpha.sources['calc-mcap-fees'].from, ['cg-snapshot', 'dl-fees'], 'ratios cite the snapshot they were calculated from');
    assert.equal(alpha.derived.mcapToFees.value, Number((tokA.market.marketCap / ((alpha.fees.total30d * 365) / 30)).toFixed(2)));
    const idx = read('index.json');
    const idxA = idx.protocols.find((p) => p.slug === 'alpha');
    assert.equal(idxA.price, 101);
    assert.equal(idxA.fdv, tokA.market.fdv);
    assert.equal(idxA.priceFromSnapshot, true);
    assert.ok(idx.priceSnapshot?.api.includes('ids='), 'the index names the one request all prices came from');

    const missing = read('tokens/missing-coin.json');
    assert.equal(missing.market.src, 'dl-coin', 'falls back to DefiLlama price when CoinGecko fails');
    assert.ok(missing.market.partial);

    const meta = read('meta.json');
    assert.ok(meta.problems.some((p) => p.message.includes('missing-coin') && p.hint.includes('right-id')), 'suggests the right CoinGecko id');
    assert.ok(meta.problems.some((p) => p.message.includes('Broken Feed')), 'reports broken feeds');
    assert.ok(meta.problems.some((p) => p.message.includes('"bad-entry" skipped')), 'rejects malformed unlocks.json entries');

    const coins = read('coins.json');
    assert.deepEqual(coins.rows.map((r) => r.id), ['big-coin', 'alpha-token', 'defi-only'], 'union of both lists, by rank');
    assert.equal(coins.rows.find((r) => r.id === 'alpha-token').tracked, true);
    assert.equal(coins.rows.find((r) => r.id === 'alpha-token').price, 101, 'a tracked token shows the snapshot price in the coin list too');
    assert.equal(coins.rows.find((r) => r.id === 'alpha-token').snapshot, true);
    assert.equal(coins.rows.find((r) => r.id === 'big-coin').snapshot, undefined, 'other coins keep the list’s own numbers');
    assert.ok(coins.sources['cg-snapshot']?.api.includes('ids='));
    assert.equal(idx.protocols.find((p) => p.tokenId === 'missing-coin').priceFromSnapshot, false, 'a token the snapshot lacks keeps its own request');
    assert.equal(coins.rows.find((r) => r.id === 'big-coin').defi, false);
    assert.ok(coins.sources['cg-markets'].api.includes('/coins/markets'));
    const pred = read('predictions.json');
    assert.deepEqual(pred.events.map((e) => e.id), ['2', '1'], 'crypto events only, busiest first');
    assert.deepEqual(pred.events[0].leaders.map((l) => l.label), ['$2k–$4k', '<$2k'], 'closed sub-markets are ignored');
    assert.equal(pred.events[1].leaders[0].probability, 62);
    assert.ok(pred.sources['pm-events'].ok);

    const cat = read('catalysts.json');
    assert.ok(cat.items.some((i) => i.type === 'governance-vote' && i.status === 'open'));
    assert.ok(cat.items.every((i) => i.url && i.src && cat.sources[i.src]), 'every catalyst has a link and a source');
    assert.equal(cat.items.filter((i) => i.type === 'unlock').length, 6, 'Catalysts shows the next 6 months of tranches, one item per month');
    assert.ok(cat.unavailable.some((u) => u.reason.includes('Unconfirmed')), 'tokens without a schedule are listed as unconfirmed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
