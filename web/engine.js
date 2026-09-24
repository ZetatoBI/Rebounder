/* Rebounder engine: channel detection and backtesting.
   Bars are arrays: [time(sec), open, high, low, close, volume].
   Runs in the browser (window.RW) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  const T = 0, O = 1, H = 2, L = 3, C = 4;

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Count separate visits to a band: a new visit starts when the previous bar was outside it.
  function countVisits(bars, inBand) {
    let visits = 0, prev = false;
    for (const b of bars) {
      const now = inBand(b);
      if (now && !prev) visits++;
      prev = now;
    }
    return visits;
  }

  /* Find a horizontal-ish channel in a window of bars.
     Returns null when the window does not form a clean range under the rules. */
  function detectChannel(win, rules) {
    if (!win || win.length < 8) return null;
    const highs = win.map(b => b[H]).sort((a, b) => a - b);
    const lows = win.map(b => b[L]).sort((a, b) => a - b);
    const ceiling = quantile(highs, 0.9);
    const floor = quantile(lows, 0.1);
    const range = ceiling - floor;
    if (!(range > 0) || floor <= 0) return null;
    const widthPct = (range / floor) * 100;

    // Containment: nearly all closes sit inside the channel (small tolerance).
    const tol = range * 0.2;
    const inside = win.filter(b => b[C] >= floor - tol && b[C] <= ceiling + tol).length / win.length;

    // Flatness: the trend over the window is small compared with the channel height.
    const n = win.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { const y = win[i][C]; sx += i; sy += y; sxy += i * y; sxx += i * i; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const drift = Math.abs(slope * (n - 1));

    const band = range * 0.15;
    const floorTouches = countVisits(win, b => b[L] <= floor + band);
    const ceilTouches = countVisits(win, b => b[H] >= ceiling - band);

    const ch = {
      floor, ceiling, mid: (floor + ceiling) / 2, widthPct,
      floorTouches, ceilTouches, containment: inside, drift,
    };
    ch.valid =
      widthPct >= rules.minWidthPct && widthPct <= rules.maxWidthPct &&
      inside >= 0.9 && drift <= range * 0.5 &&
      floorTouches >= rules.minTouches && ceilTouches >= rules.minTouches;
    return ch;
  }

  // Where the price sits inside the channel: 0 = floor, 100 = ceiling.
  function positionPct(price, ch) {
    return ((price - ch.floor) / (ch.ceiling - ch.floor)) * 100;
  }

  function barsPerSession(timeframe) { return timeframe === '15m' ? 26 : 7; }

  function currentChannel(bars, rules, timeframe) {
    const w = rules.windowSessions * barsPerSession(timeframe);
    if (!bars || bars.length < w) return null;
    const win = bars.slice(-w);
    const ch = detectChannel(win, rules);
    if (!ch) return null;
    ch.price = bars[bars.length - 1][C];
    ch.position = positionPct(ch.price, ch);
    ch.window = win;
    return ch;
  }

  /* Backtest the channel rules on real historical bars.
     rules: windowSessions, minWidthPct, maxWidthPct, minTouches, zonePct,
            stopPct, exitAt ('mid' | 'ceilingZone'), exitZonePct, timeStopSessions,
            entry ('single' | 'ladder'), costBps, positionSize, skipEarnings
     earnings: array of unix seconds for earnings dates (optional) */
  function backtest(bars, rules, timeframe, earnings) {
    const bps = barsPerSession(timeframe);
    const W = rules.windowSessions * bps;
    const maxHold = rules.timeStopSessions * bps;
    const cost = (rules.costBps || 0) / 10000;
    const size = rules.positionSize || 10000;
    const earn = (earnings || []).slice().sort((a, b) => a - b);
    const trades = [];
    let i = W;

    function earningsBetween(t0, t1) {
      for (const e of earn) if (e >= t0 && e <= t1) return true;
      return false;
    }

    while (i < bars.length - 1) {
      const ch = detectChannel(bars.slice(i - W, i), rules);
      const bar = bars[i];
      const range = ch ? ch.ceiling - ch.floor : 0;
      const zoneTop = ch ? ch.floor + range * rules.zonePct / 100 : 0;
      if (!ch || !ch.valid || bar[L] > zoneTop) { i++; continue; }

      const horizonEnd = bars[Math.min(i + maxHold, bars.length - 1)][T];
      if (rules.skipEarnings && earningsBetween(bar[T] - 86400, horizonEnd + 86400)) { i++; continue; }

      // Levels are frozen at the moment of the signal.
      const stop = ch.floor * (1 - rules.stopPct / 100);
      const target = rules.exitAt === 'ceilingZone'
        ? ch.ceiling - range * (rules.exitZonePct || 20) / 100
        : ch.mid;
      const levels = rules.entry === 'ladder'
        ? [zoneTop, ch.floor + range * rules.zonePct / 200, ch.floor]
        : [zoneTop];
      const trancheSize = size / levels.length;
      const fills = [];

      function tryFills(b) {
        for (let k = fills.length; k < levels.length; k++) {
          if (b[L] <= levels[k]) fills.push(Math.min(b[O], levels[k]));
          else break;
        }
      }

      tryFills(bar);
      let exitPrice = null, exitIdx = null, reason = '';
      // A stop touched on the entry bar counts as a loss (conservative).
      if (bar[L] <= stop) { exitPrice = stop; exitIdx = i; reason = 'Stop'; }
      for (let j = i + 1; exitPrice === null && j < bars.length; j++) {
        const b = bars[j];
        if (b[O] <= stop) { exitPrice = b[O]; exitIdx = j; reason = 'Stop (gap)'; break; }
        tryFills(b);
        if (b[L] <= stop) { exitPrice = stop; exitIdx = j; reason = 'Stop'; break; }
        if (b[O] >= target) { exitPrice = b[O]; exitIdx = j; reason = 'Target'; break; }
        if (b[H] >= target) { exitPrice = target; exitIdx = j; reason = 'Target'; break; }
        if (j - i >= maxHold) { exitPrice = b[C]; exitIdx = j; reason = 'Time exit'; break; }
      }
      if (exitPrice === null) break; // open trade at the end of data is not counted

      let pnl = 0, invested = 0;
      for (const f of fills) {
        const shares = trancheSize / f;
        pnl += shares * (exitPrice - f) - trancheSize * cost - shares * exitPrice * cost;
        invested += trancheSize;
      }
      const avgFill = fills.reduce((a, f) => a + f, 0) / fills.length;
      trades.push({
        entryTime: bar[T], exitTime: bars[exitIdx][T], avgFill, exitPrice,
        tranches: fills.length, invested, pnl, pct: (pnl / invested) * 100, reason,
        floor: ch.floor, ceiling: ch.ceiling,
      });
      i = exitIdx + 1;
    }
    return summarize(trades, size);
  }

  function summarize(trades, size) {
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
    const sum = a => a.reduce((s, t) => s + t.pnl, 0);
    let eq = 0, peak = 0, maxDd = 0;
    const curve = [0];
    for (const t of trades) {
      eq += t.pnl; curve.push(eq);
      peak = Math.max(peak, eq); maxDd = Math.min(maxDd, eq - peak);
    }
    const avgWin = wins.length ? sum(wins) / wins.length : 0;
    const avgLoss = losses.length ? sum(losses) / losses.length : 0;
    return {
      trades, count: trades.length, wins: wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      net: eq, avgWin, avgLoss,
      expectancy: trades.length ? eq / trades.length : 0,
      worst: trades.length ? Math.min(...trades.map(t => t.pnl)) : 0,
      maxDrawdown: maxDd, curve,
      lossToWin: avgWin > 0 ? Math.abs(avgLoss) / avgWin : null,
      positionSize: size,
    };
  }

  const api = { detectChannel, currentChannel, backtest, positionPct, barsPerSession, quantile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RW = api;
})(typeof window !== 'undefined' ? window : globalThis);
