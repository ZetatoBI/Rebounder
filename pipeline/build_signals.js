/* Rebounder signals: runs the four strategies with their DEFAULT settings on every stock and writes
   web/data/signals.json: which positions the rules hold right now, and trades they closed recently.

   It loads web/engine.js and web/strategies.js, the same code the app runs in the browser, so these
   signals are exactly what a visitor sees with the default settings. Nothing here is a recommendation:
   it is a public, rule-based record of what the default rules do, the same for everyone.

   Usage: node pipeline/build_signals.js      (after build_data.py has written web/data/)
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'web', 'data');
const RW = require(path.join(ROOT, 'web', 'engine.js'));
global.RW = RW;                                   // strategies.js looks for RW on the global object
const RWS = require(path.join(ROOT, 'web', 'strategies.js'));

// Must match FILTER_DEFAULTS and BT_DEFAULTS in web/app.js. If you change the app's defaults, change these too.
const FILTER_DEFAULTS = { minCapB: 20, minDollarVolM: 250, peDiscount: 10, minOffHigh: 20, minUpside: 15, requireRising: false };
const BT_DEFAULTS = { size: 10000, costBps: 5 };
const VERSION = 1;
const HISTORY_DAYS = { '1d': 3 * 365, '1h': 730, '15m': 60 };  // enough warm-up that today's state is stable
const CLOSED_WINDOW_DAYS = 45;                                   // closed trades kept in the file
const DAY = 86400;

const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function loadBars(tf, ticker) {
  const full = read(path.join(DATA, 'bars', tf, `${ticker}.json`));
  if (!full || !full.length) return [];
  const cutoff = full[full.length - 1][0] - HISTORY_DAYS[tf] * DAY;
  return full.filter(b => b[0] >= cutoff);
}

// ---------- entry reference prices a person could realistically get ----------
const nyDay = t => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/* Volume-weighted average price of the New York trading day containing time t, from 15-minute bars.
   Falls back to that day's typical price (high + low + close) / 3 from daily bars when 15-minute
   history no longer covers the day. */
function dayVwap(ticker, t, daily) {
  const day = nyDay(t);
  const q = (read(path.join(DATA, 'bars', '15m', `${ticker}.json`)) || []).filter(b => nyDay(b[0]) === day);
  let pv = 0, v = 0;
  for (const b of q) { const vol = b[5] || 0; pv += ((b[2] + b[3] + b[4]) / 3) * vol; v += vol; }
  const d = daily.find(b => nyDay(b[0]) === day);
  // Sanity check: a VWAP outside the day's own high-low range means the intraday data is off.
  if (v > 0 && (!d || (pv / v >= d[3] * 0.995 && pv / v <= d[2] * 1.005))) return { px: pv / v, kind: 'vwap' };
  return d ? { px: (d[2] + d[3] + d[4]) / 3, kind: 'dayavg' } : null;
}

// ---------- filters and context, mirroring web/app.js ----------
const upside = s => { const t = s.target && (s.target.weighted || s.target.mean); return t && s.price ? (t / s.price - 1) * 100 : null; };
const peDiscount = s => { const pp = s.peers && s.peers.fwdPE; return s.fwdPE > 0 && pp ? (1 - s.fwdPE / pp) * 100 : null; };
function passes(s, p) {
  const f = FILTER_DEFAULTS;
  if (!(s.marketCap >= f.minCapB * 1e9) || !(s.avgDollarVolume >= f.minDollarVolM * 1e6)) return false;
  if (p.useValue && (!(peDiscount(s) >= f.peDiscount) || !(s.offHighPct >= f.minOffHigh))) return false;
  if (p.useAnalyst && !(upside(s) >= f.minUpside)) return false;
  return true;
}

const EXIT_RULE = {
  rebound: p => `Target at the channel ${p.exitMode === 'top' ? 'exit zone' : 'midline'}, stop ${p.stopPct}% below the floor, or ${p.holdDays} trading days`,
  meanrev: p => `Close back above the ${p.exitLen}-bar average, or ${p.holdDays} trading days`,
  trend: p => `Close below the ${p.exitLen}-bar low, with a stop ${p.stopAtr} ATRs below entry`,
  momentum: p => `Monthly check: momentum no longer in the top ${p.topPct}% or below the ${p.trendLen}-day average`,
};

function tradeRow(st, ticker, stock, tr, bars, daily) {
  const ladder = st.id === 'rebound';
  let ref = ladder ? { px: tr.avgFill, kind: 'ladder' } : dayVwap(ticker, tr.entryTime, daily);
  if (!ref) ref = { px: tr.avgFill, kind: 'open' };
  return {
    t: ticker, name: stock.name || ticker, sector: stock.sector || '',
    entryTime: tr.entryTime, entryRef: round(ref.px), entryKind: ref.kind, ruleFill: round(tr.avgFill),
    exitTime: tr.exitTime, exit: round(tr.exitPrice), reason: tr.reason,
    ret: round((tr.exitPrice / ref.px - 1) * 100, 2),
  };
}

function openRow(st, p, ticker, stock, pos, bars, daily) {
  const last = bars[bars.length - 1];
  const shares = pos.fills.reduce((a, f) => a + f.usd / f.px, 0);
  const invested = pos.fills.reduce((a, f) => a + f.usd, 0);
  const avgFill = invested / shares;
  const ladder = st.id === 'rebound';
  let ref = ladder ? { px: avgFill, kind: 'ladder' } : dayVwap(ticker, pos.entryTime, daily);
  if (!ref) ref = { px: avgFill, kind: 'open' };
  const px = last[4];
  const row = {
    t: ticker, name: stock.name || ticker, sector: stock.sector || '',
    entryTime: pos.entryTime, entryRef: round(ref.px), entryKind: ref.kind, ruleFill: round(avgFill),
    last: round(px), lastTime: last[0], ret: round((px / ref.px - 1) * 100, 2),
    stop: round(pos.stop), target: round(pos.target),
    toStop: pos.stop ? round((px / pos.stop - 1) * 100, 2) : null,
    toTarget: pos.target ? round((pos.target / px - 1) * 100, 2) : null,
  };
  if (ladder) {
    row.filled = pos.fills.length;
    row.of = pos.fills.length + (pos.pending || []).length;
    row.nextBuy = pos.pending && pos.pending.length ? round(pos.pending[0].level) : null;
    row.toNextBuy = row.nextBuy ? round((row.nextBuy / px - 1) * 100, 2) : null;
  }
  if (st.id === 'trend' && pos.peak) row.peak = round(pos.peak);
  return row;
}

// ---------- momentum: the ranked, monthly strategy (the backtest in the app uses the absolute rule only) ----------
function momentumBook(st, p, stocks, dailyOf, regime) {
  const tickers = stocks.filter(s => passes(s, p) && (dailyOf[s.ticker] || []).length > 300).map(s => s.ticker);
  if (!tickers.length) return { open: [], closed: [] };
  const ind = Object.fromEntries(tickers.map(t => [t, st.prepare(dailyOf[t], p)]));
  const ref = dailyOf[tickers.reduce((a, t) => (dailyOf[t].length > dailyOf[a].length ? t : a), tickers[0])];
  const idxOf = Object.fromEntries(tickers.map(t => [t, new Map(dailyOf[t].map((b, i) => [nyDay(b[0]), i]))]));
  const held = new Map(), closed = [];
  for (let r = 1; r < ref.length; r++) {
    if (!st.isRebal(r, ref)) continue;
    const day = nyDay(ref[r][0]);
    const riskOff = p.marketFilter && regime(ref[r][0], true) === false;
    const scored = [];
    for (const t of tickers) {
      const i = idxOf[t].get(day);
      if (i == null || i < 1) continue;
      const k = i - 1, m = st.mom(k, ind[t], p);
      if (isFinite(m) && k >= ind[t].start) scored.push({ t, i, m, ok: st.qualifies(k, ind[t], p) });
    }
    scored.sort((a, b) => b.m - a.m);
    const cut = Math.max(1, Math.round(scored.length * p.topPct / 100));
    const leaders = new Set(riskOff ? [] : scored.slice(0, cut).filter(x => x.ok).map(x => x.t));
    const at = Object.fromEntries(scored.map(x => [x.t, x.i]));
    for (const [t, pos] of [...held]) {
      if (leaders.has(t) || at[t] == null) continue;
      const b = dailyOf[t][at[t]];
      closed.push({ ...pos, exitTime: b[0], exitPrice: b[1], reason: riskOff ? 'Market filter' : 'Monthly check' });
      held.delete(t);
    }
    for (const t of leaders) {
      if (held.has(t)) continue;
      const b = dailyOf[t][at[t]];
      held.set(t, { t, entryTime: b[0], entryIdx: at[t], avgFill: b[1], fills: [{ px: b[1], usd: BT_DEFAULTS.size }], pending: [] });
    }
  }
  return { open: [...held.values()], closed };
}

function main() {
  const screen = read(path.join(DATA, 'screen.json'));
  if (!screen || !screen.stocks) { console.error('No screen.json: run build_data.py first.'); process.exit(1); }
  const stocks = screen.stocks;
  const spy = loadBars('1d', 'SPY');
  const regime = RW.makeRegime(spy);
  const dailyOf = {};
  for (const s of stocks) dailyOf[s.ticker] = loadBars('1d', s.ticker);

  const out = [];
  let latest = 0;
  for (const st of RWS.list) {
    const tf = st.defaultTf, p = { ...st.defaults[tf] };
    const t0 = Date.now();
    const open = [], closed = [];
    const since = Date.now() / 1000 - CLOSED_WINDOW_DAYS * DAY;
    if (st.id === 'momentum') {
      const book = momentumBook(st, p, stocks, dailyOf, regime);
      for (const pos of book.open) {
        const s = stocks.find(x => x.ticker === pos.t);
        open.push(openRow(st, p, pos.t, s, pos, dailyOf[pos.t], dailyOf[pos.t]));
      }
      for (const tr of book.closed.filter(x => x.exitTime >= since)) {
        const s = stocks.find(x => x.ticker === tr.t);
        closed.push(tradeRow(st, tr.t, s, tr, dailyOf[tr.t], dailyOf[tr.t]));
      }
    } else {
      for (const s of stocks) {
        if (!passes(s, p)) continue;
        const bars = tf === '1d' ? dailyOf[s.ticker] : loadBars(tf, s.ticker);
        if (!bars || bars.length < 60) continue;
        latest = Math.max(latest, bars[bars.length - 1][0]);
        const ctx = { tf, size: BT_DEFAULTS.size, costBps: BT_DEFAULTS.costBps, marketFilter: p.marketFilter,
                      peDiscount: peDiscount(s), upside: upside(s), regime,
                      earnings: s.earnings || [], skipEarnings: p.skipEarnings, holdDays: st.holdDays(p) };
        let sim;
        try { sim = RW.simulate(bars, st, p, ctx); } catch (e) { console.error(`  ${st.id} ${s.ticker}: ${e.message}`); continue; }
        if (sim.open) open.push(openRow(st, p, s.ticker, s, sim.open, bars, dailyOf[s.ticker]));
        for (const tr of sim.trades.filter(x => x.exitTime >= since)) closed.push(tradeRow(st, s.ticker, s, tr, bars, dailyOf[s.ticker]));
      }
    }
    open.sort((a, b) => b.entryTime - a.entryTime);
    closed.sort((a, b) => b.exitTime - a.exitTime);
    out.push({
      id: st.id, name: st.name, short: st.short, tagline: st.tagline,
      tf, tfLabel: RW.TF[tf].long, exitRule: EXIT_RULE[st.id](p),
      usesValue: !!p.useValue, usesAnalyst: !!p.useAnalyst, marketFilter: !!p.marketFilter,
      open, closed,
    });
    console.log(`${st.short}: ${open.length} open, ${closed.length} closed in the last ${CLOSED_WINDOW_DAYS} days (${Date.now() - t0} ms)`);
  }

  const file = path.join(DATA, 'signals.json');
  fs.writeFileSync(file, JSON.stringify({
    meta: {
      version: VERSION, generated: new Date().toISOString().slice(0, 16) + 'Z',
      pricesAsOf: latest || null, demo: !!(screen.meta && screen.meta.demo),
      source: (screen.meta && screen.meta.source) || null,
      filters: FILTER_DEFAULTS, size: BT_DEFAULTS.size, costBps: BT_DEFAULTS.costBps,
      note: 'Default settings for every strategy. Rule-based and hypothetical; not a recommendation.',
    },
    strategies: out,
  }));
  console.log(`Wrote ${file}`);
}

main();
