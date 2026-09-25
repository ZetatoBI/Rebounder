/* Rebounder engine: indicators, channel detection, trade simulation and stats.
   Bars are arrays: [time(sec), open, high, low, close, volume].
   Runs in the browser (window.RW) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  const T = 0, O = 1, H = 2, L = 3, C = 4;
  const DAY = 86400;

  const TF = {
    '15m': { key: '15m', label: '15 min', long: '15-minute', perDay: 26, history: 'about 60 days' },
    '1h': { key: '1h', label: 'Hourly', long: 'hourly', perDay: 7, history: 'about 2 years' },
    '1d': { key: '1d', label: 'Daily', long: 'daily', perDay: 1, history: 'up to 10 years' },
  };

  // ---------- indicators (arrays aligned with bars, NaN until enough data) ----------
  function closes(bars) { return bars.map(b => b[C]); }

  function sma(v, n) {
    const out = new Array(v.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= n) s -= v[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  // Wilder's RSI
  function rsi(v, n) {
    const out = new Array(v.length).fill(NaN);
    if (v.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  // Wilder's average true range
  function atr(bars, n) {
    const out = new Array(bars.length).fill(NaN);
    if (bars.length <= n) return out;
    const tr = bars.map((b, i) => i === 0 ? b[H] - b[L]
      : Math.max(b[H] - b[L], Math.abs(b[H] - bars[i - 1][C]), Math.abs(b[L] - bars[i - 1][C])));
    let a = 0;
    for (let i = 1; i <= n; i++) a += tr[i];
    a /= n; out[n] = a;
    for (let i = n + 1; i < bars.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }

  // Highest high / lowest low of the n bars BEFORE bar i (so bar i can break it).
  function priorHigh(bars, n) {
    const out = new Array(bars.length).fill(NaN);
    for (let i = n; i < bars.length; i++) { let m = -Infinity; for (let k = i - n; k < i; k++) m = Math.max(m, bars[k][H]); out[i] = m; }
    return out;
  }
  function priorLow(bars, n) {
    const out = new Array(bars.length).fill(NaN);
    for (let i = n; i < bars.length; i++) { let m = Infinity; for (let k = i - n; k < i; k++) m = Math.min(m, bars[k][L]); out[i] = m; }
    return out;
  }

  // ---------- channel ----------
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function countVisits(bars, inBand) {
    let visits = 0, prev = false;
    for (const b of bars) { const now = inBand(b); if (now && !prev) visits++; prev = now; }
    return visits;
  }

  /* Horizontal channel from highs (ceiling) and lows (floor).
     edgeTrim = % of the most extreme wicks ignored on each side (0 = the absolute
     highest high and lowest low). */
  function detectChannel(win, r) {
    if (!win || win.length < 8) return null;
    const trim = Math.max(0, Math.min(20, r.edgeTrim || 0)) / 100;
    const highs = win.map(b => b[H]).sort((a, b) => a - b);
    const lows = win.map(b => b[L]).sort((a, b) => a - b);
    const ceiling = quantile(highs, 1 - trim);
    const floor = quantile(lows, trim);
    const range = ceiling - floor;
    if (!(range > 0) || floor <= 0) return null;
    const widthPct = (range / floor) * 100;

    const tol = range * 0.15;
    const containment = win.filter(b => b[C] >= floor - tol && b[C] <= ceiling + tol).length / win.length;

    const n = win.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { const y = win[i][C]; sx += i; sy += y; sxy += i * y; sxx += i * i; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const drift = Math.abs(slope * (n - 1));

    const band = range * 0.15;
    const floorTouches = countVisits(win, b => b[L] <= floor + band);
    const ceilTouches = countVisits(win, b => b[H] >= ceiling - band);

    const ch = { floor, ceiling, mid: (floor + ceiling) / 2, widthPct, floorTouches, ceilTouches, containment, drift };
    ch.why = [];
    if (widthPct < r.minWidthPct) ch.why.push('narrower than your minimum width');
    if (widthPct > r.maxWidthPct) ch.why.push('wider than your maximum width');
    if (containment < 0.9) ch.why.push('too many closes outside the range');
    if (drift > range * 0.5) ch.why.push('trending rather than flat');
    if (floorTouches < r.minTouches || ceilTouches < r.minTouches) ch.why.push('edges not tested often enough');
    ch.valid = ch.why.length === 0;
    return ch;
  }

  function positionPct(price, ch) { return ((price - ch.floor) / (ch.ceiling - ch.floor)) * 100; }

  // ---------- market regime ----------
  /* From daily index bars, returns fn(t, sameDayOk) -> true (index above its moving
     average as of the latest completed day), false, or null (unknown). */
  function makeRegime(dailyBars, len) {
    len = len || 200;
    if (!dailyBars || dailyBars.length < len + 1) return () => null;
    const ma = sma(closes(dailyBars), len);
    const days = dailyBars.map((b, i) => [b[T], isNaN(ma[i]) ? null : b[C] > ma[i]]);
    return function (t, sameDayOk) {
      let lo = 0, hi = days.length - 1, ans = -1;
      const limit = sameDayOk ? t : t - 20 * 3600; // intraday: use the prior completed day
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid][0] <= limit) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans < 0 ? null : days[ans][1];
    };
  }

  // ---------- simulation ----------
  /* Generic long-only simulator. A strategy supplies:
       prepare(bars, p, ctx) -> ind (with ind.start = first usable index)
       entry(i, bars, ind, p, ctx) -> null | { fills:[{px, usd}], pending?:[{level, usd}], stop?, target?, limitEntry? }
       manage(j, pos, bars, ind, p, ctx) -> null | { price, reason }   (called each bar while open, including the entry bar)
     ctx: { size, costBps, earnings, skipEarnings, holdDays, regime, marketFilter, tf } */
  function simulate(bars, strat, p, ctx) {
    const ind = strat.prepare(bars, p, ctx);
    const trades = [];
    let pos = null;
    const earn = (ctx.earnings || []).slice().sort((a, b) => a - b);
    const nearEarnings = (t0, t1) => earn.some(e => e >= t0 && e <= t1);
    const start = Math.max(1, ind.start || 1);

    for (let i = start; i < bars.length; i++) {
      const b = bars[i];
      if (!pos) {
        if (ctx.marketFilter && ctx.regime && ctx.regime(b[T], ctx.tf === '1d') === false) continue;
        const en = strat.entry(i, bars, ind, p, ctx);
        if (!en) continue;
        if (ctx.skipEarnings && ctx.holdDays && nearEarnings(b[T] - DAY, b[T] + ctx.holdDays * DAY * 1.45)) continue;
        pos = { ...en, entryIdx: i, entryTime: b[T], fills: en.fills.slice(), pending: (en.pending || []).slice() };
      }
      const ex = strat.manage(i, pos, bars, ind, p, ctx);
      if (ex) { trades.push(closeTrade(pos, ex, i, bars, ctx)); pos = null; }
    }
    return { trades, open: pos, ind, start };
  }

  function closeTrade(pos, ex, j, bars, ctx) {
    const cost = (ctx.costBps || 0) / 10000;
    let pnl = 0, invested = 0, shares = 0;
    for (const f of pos.fills) {
      const sh = f.usd / f.px;
      shares += sh;
      pnl += sh * (ex.price - f.px) - f.usd * cost - sh * ex.price * cost;
      invested += f.usd;
    }
    return {
      entryTime: pos.entryTime, exitTime: bars[j][T], entryIdx: pos.entryIdx, exitIdx: j,
      avgFill: invested / shares, exitPrice: ex.price, tranches: pos.fills.length,
      invested, pnl, pct: (pnl / invested) * 100, reason: ex.reason,
    };
  }

  function summarize(sim, bars, ctx) {
    const trades = sim.trades;
    const size = ctx.size || 10000;
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
    const sum = a => a.reduce((s, t) => s + t.pnl, 0);
    let eq = 0, peak = 0, maxDd = 0, held = 0;
    const first = bars[sim.start], last = bars[bars.length - 1];
    const curve = [{ t: first ? first[T] : 0, v: 0 }];
    for (const t of trades) {
      eq += t.pnl; curve.push({ t: t.exitTime, v: eq });
      peak = Math.max(peak, eq); maxDd = Math.min(maxDd, eq - peak);
      held += t.exitIdx - t.entryIdx + 1;
    }
    const grossWin = sum(wins), grossLoss = -sum(losses);
    const cost = (ctx.costBps || 0) / 10000;
    const bh = first && last ? size * (last[C] / first[O] - 1) - size * cost * 2 : 0;
    const years = first && last ? Math.max((last[T] - first[T]) / (365.25 * DAY), 1 / 365) : 1;
    return {
      trades, count: trades.length, wins: wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      net: eq, netPct: (eq / size) * 100,
      grossWin, grossLoss,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      expectancy: trades.length ? eq / trades.length : 0,
      avgPct: trades.length ? trades.reduce((s, t) => s + t.pct, 0) / trades.length : 0,
      worst: trades.length ? Math.min(...trades.map(t => t.pnl)) : 0,
      best: trades.length ? Math.max(...trades.map(t => t.pnl)) : 0,
      maxDrawdown: maxDd,
      exposure: bars.length - sim.start > 0 ? (held / (bars.length - sim.start)) * 100 : 0,
      avgHoldDays: trades.length ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / DAY, 0) / trades.length : 0,
      perYear: trades.length / years, years,
      buyHold: bh, buyHoldPct: (bh / size) * 100,
      curve, open: sim.open, positionSize: size,
      from: first ? first[T] : null, to: last ? last[T] : null,
    };
  }

  function backtest(bars, strat, p, ctx) {
    if (!bars || bars.length < 30) return summarize({ trades: [], open: null, start: 0 }, bars || [], ctx);
    return summarize(simulate(bars, strat, p, ctx), bars, ctx);
  }

  // Shared exit helper for fixed stops and targets. A gap through a level fills at the open.
  function stopTargetExit(j, pos, bars) {
    const b = bars[j];
    const after = j > pos.entryIdx;
    if (pos.stop != null && after && b[O] <= pos.stop) return { price: b[O], reason: 'Stop (gap)' };
    if (pos.stop != null && b[L] <= pos.stop) return { price: pos.stop, reason: 'Stop' };
    if (pos.target != null && after && b[O] >= pos.target) return { price: b[O], reason: 'Target' };
    if (pos.target != null && after && b[H] >= pos.target) return { price: pos.target, reason: 'Target' };
    return null;
  }

  const api = {
    TF, DAY, sma, rsi, atr, priorHigh, priorLow, closes, quantile,
    detectChannel, positionPct, makeRegime, simulate, summarize, backtest, stopTargetExit,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RW = api;
})(typeof window !== 'undefined' ? window : globalThis);
