/* Rebounder strategies. Each one defines its rules (for backtests and the
   watchlist), sensible defaults for every timeframe it supports, the settings a
   user can change with plain-language help, and an explainer. */
(function (root) {
  'use strict';
  const RW = root.RW || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const T = 0, O = 1, H = 2, L = 3, C = 4;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const perDay = tf => RW.TF[tf].perDay;
  const last = a => a[a.length - 1];

  // Settings shared by several strategies
  const F = {
    holdDays: { k: 'holdDays', label: 'Time exit (trading days)', type: 'num', step: 1, min: 1, group: 'Exit',
      help: 'If neither the target nor the stop is hit within this many trading days, the trade closes at the market. Stops capital from sitting in a setup that stopped working.' },
    skipEarnings: { k: 'skipEarnings', label: 'Skip trades near earnings', type: 'check', group: 'Filters',
      help: 'Ignores setups where an earnings report could land during the trade. Earnings gaps are the main way short-term setups blow up, so this trades fewer times but more safely.' },
    marketFilter: { k: 'marketFilter', label: 'Only when the S&P 500 is above its 200-day average', type: 'check', group: 'Filters',
      help: 'A market-trend filter. New trades are only taken while the S&P 500 is above its 200-day moving average. Most long-only strategies lose much of their money during market downtrends, so this usually cuts drawdowns at the cost of some missed trades.' },
    useValue: { k: 'useValue', label: 'Apply value filters', type: 'check', group: 'Filters',
      help: 'Only shows stocks that are cheap against their peers and well below their 52-week high, using the thresholds under Filters. Backtests cannot apply this filter because it uses today\'s fundamentals.' },
    useAnalyst: { k: 'useAnalyst', label: 'Apply analyst filters', type: 'check', group: 'Filters',
      help: 'Only shows stocks whose recency-weighted analyst target is far enough above the price, using the thresholds under Filters. Like the value filter, it applies to the watchlist only.' },
    trendLen: { k: 'trendLen', label: 'Trend average (bars)', type: 'num', step: 10, min: 20, group: 'Setup',
      help: 'The long moving average that defines an uptrend. 200 bars on daily charts is the classic 200-day average. Price above it counts as an uptrend.' },
  };

  // ============================== Channel rebound ==============================
  const rebound = {
    id: 'rebound', name: 'Channel rebound', short: 'Rebound',
    tagline: 'Fairly valued large caps trading sideways, near the floor of their range.',
    timeframes: ['15m', '1h', '1d'], defaultTf: '1h',
    defaults: {
      '15m': { lookbackDays: 3, minWidthPct: 1.5, maxWidthPct: 6, minTouches: 2, edgeTrim: 5, entryZonePct: 15, entry: 'ladder', exitMode: 'mid', exitZonePct: 20, stopPct: 2, holdDays: 5, skipEarnings: true, marketFilter: false, useValue: true, useAnalyst: true },
      '1h': { lookbackDays: 10, minWidthPct: 3, maxWidthPct: 10, minTouches: 2, edgeTrim: 5, entryZonePct: 15, entry: 'ladder', exitMode: 'mid', exitZonePct: 20, stopPct: 3, holdDays: 10, skipEarnings: true, marketFilter: false, useValue: true, useAnalyst: true },
      '1d': { lookbackDays: 60, minWidthPct: 6, maxWidthPct: 20, minTouches: 2, edgeTrim: 5, entryZonePct: 15, entry: 'ladder', exitMode: 'mid', exitZonePct: 20, stopPct: 5, holdDays: 30, skipEarnings: true, marketFilter: false, useValue: true, useAnalyst: true },
    },
    fields: [
      { k: 'lookbackDays', label: 'Channel look-back (trading days)', type: 'num', step: 1, min: 1, group: 'Channel',
        help: 'How many recent trading days the channel is measured over. Short windows find tight intraday ranges; long windows find ranges that have held for weeks or months.' },
      { k: 'minWidthPct', label: 'Minimum channel width (%)', type: 'num', step: 0.5, min: 0, group: 'Channel',
        help: 'Channel height as a % of the floor price. Too narrow and costs eat the move from floor to target.' },
      { k: 'maxWidthPct', label: 'Maximum channel width (%)', type: 'num', step: 0.5, min: 0, group: 'Channel',
        help: 'Wider than this is treated as volatility rather than a range.' },
      { k: 'minTouches', label: 'Touches of each side, at least', type: 'num', step: 1, min: 1, group: 'Channel',
        help: 'How many separate times price must have visited both the floor and the ceiling. More touches means a better-tested range but fewer matches.' },
      { k: 'edgeTrim', label: 'Channel edges', type: 'seg', group: 'Channel', options: [[0, 'Exact high and low'], [5, 'Ignore 5% of wicks'], [10, 'Ignore 10%']],
        help: 'The ceiling is drawn from bar highs and the floor from bar lows. "Exact" uses the single highest high and lowest low, so one spike can stretch the channel. Ignoring the most extreme 5% of wicks gives edges that price actually trades against.' },
      { k: 'entryZonePct', label: 'Entry zone: bottom % of channel', type: 'num', step: 1, min: 1, max: 50, group: 'Entry',
        help: 'The part of the channel, measured up from the floor, where the rules start buying. 15 means the bottom 15% of the channel height.' },
      { k: 'entry', label: 'Position building', type: 'seg', group: 'Entry', options: [['single', 'All at once'], ['ladder', 'In thirds']],
        help: 'All at once buys the full position at the top of the entry zone. In thirds buys one third at the top of the zone, one in the middle of it and one at the floor, and only if price gets there. Thirds give a better average price but a smaller position when price bounces early.' },
      { k: 'exitMode', label: 'Take profit at', type: 'seg', group: 'Exit', options: [['mid', 'Midline'], ['top', 'Exit zone']],
        help: 'Midline exits halfway up the channel, which is reached more often. Exit zone waits for the top part of the channel: bigger wins, fewer of them.' },
      { k: 'exitZonePct', label: 'Exit zone: top % of channel', type: 'num', step: 1, min: 1, max: 50, group: 'Exit',
        help: 'Measured down from the ceiling. 20 means profits are taken once price reaches the top 20% of the channel. Also defines the "Near the top" group in the watchlist.' },
      { k: 'stopPct', label: 'Stop below the floor (%)', type: 'num', step: 0.5, min: 0.5, group: 'Exit',
        help: 'If price breaks this far below the channel floor, the range is considered broken and the trade closes at a loss.' },
      F.holdDays, F.skipEarnings, F.marketFilter, F.useValue, F.useAnalyst,
    ],
    groups: [
      { id: 'entry', label: 'In entry zone', tip: 'Trading in a valid channel, inside your entry zone near the floor.' },
      { id: 'channel', label: 'In a channel', tip: 'Trading in a valid channel, between your entry and exit zones.' },
      { id: 'top', label: 'Near the top', tip: 'In a valid channel, inside your exit zone near the ceiling.' },
      { id: 'none', label: 'No channel', tip: 'Passes your filters but is not trading in a clean range right now.' },
    ],
    holdDays: p => p.holdDays,

    prepare(bars, p, ctx) { const W = Math.max(8, Math.round(p.lookbackDays * perDay(ctx.tf))); return { W, start: W }; },
    entry(i, bars, ind, p, ctx) {
      const ch = RW.detectChannel(bars.slice(i - ind.W, i), p);
      if (!ch || !ch.valid) return null;
      const b = bars[i], range = ch.ceiling - ch.floor;
      const zoneTop = ch.floor + range * p.entryZonePct / 100;
      if (b[L] > zoneTop) return null;
      const levels = p.entry === 'ladder' ? [zoneTop, ch.floor + range * p.entryZonePct / 200, ch.floor] : [zoneTop];
      const usd = (ctx.size || 10000) / levels.length;
      const fills = [], pending = [];
      for (const lv of levels) {
        if (!pending.length && b[L] <= lv) fills.push({ px: Math.min(b[O], lv), usd });
        else pending.push({ level: lv, usd });
      }
      return {
        fills, pending, stop: ch.floor * (1 - p.stopPct / 100),
        target: p.exitMode === 'top' ? ch.ceiling - range * p.exitZonePct / 100 : ch.mid,
        maxBars: p.holdDays * perDay(ctx.tf),
      };
    },
    manage(j, pos, bars) {
      const b = bars[j], after = j > pos.entryIdx;
      if (after && b[O] <= pos.stop) return { price: b[O], reason: 'Stop (gap)' };
      if (after) while (pos.pending.length && b[L] <= pos.pending[0].level) { const q = pos.pending.shift(); pos.fills.push({ px: Math.min(b[O], q.level), usd: q.usd }); }
      if (b[L] <= pos.stop) return { price: pos.stop, reason: 'Stop' };
      if (!after) return null;
      if (b[O] >= pos.target) return { price: b[O], reason: 'Target' };
      if (b[H] >= pos.target) return { price: pos.target, reason: 'Target' };
      if (j - pos.entryIdx >= pos.maxBars) return { price: b[C], reason: 'Time exit' };
      return null;
    },

    evaluate(bars, p, ctx) {
      const W = Math.max(8, Math.round(p.lookbackDays * perDay(ctx.tf)));
      if (!bars || bars.length < W) return { group: 'none', score: 0, headline: 'Not enough recent bars', noData: true };
      const win = bars.slice(-W);
      const ch = RW.detectChannel(win, p);
      const price = last(bars)[C];
      if (ch) ch.position = RW.positionPct(price, ch);
      if (!ch || !ch.valid) return { group: 'none', score: 0, headline: 'No clean channel right now', ch, W };
      const group = ch.position <= p.entryZonePct ? 'entry' : ch.position >= 100 - p.exitZonePct ? 'top' : 'channel';
      const posScore = 100 - clamp(ch.position, 0, 100);
      const valScore = clamp((ctx.peDiscount || 0) * 2.5, 0, 100);
      const upScore = clamp((ctx.upside || 0) * 2.5, 0, 100);
      return {
        group, ch, W,
        score: Math.round(posScore * 0.5 + valScore * 0.25 + upScore * 0.25),
        headline: `${Math.round(ch.position)}% up a ${ch.widthPct.toFixed(1)}% channel`,
        meter: { pos: clamp(ch.position, 0, 100), lo: p.entryZonePct, hi: p.exitZonePct },
      };
    },
    scoreHelp: 'Half from how close price is to the floor, a quarter from the valuation discount to peers, a quarter from analyst upside.',

    overlay(bars, p, ctx, ev) {
      if (!ev.ch) return { from: Math.max(0, bars.length - (ev.W || 60)) };
      const ch = ev.ch, range = ch.ceiling - ch.floor;
      if (!ch.valid) return {
        from: bars.length - ev.W, showFrom: Math.max(0, bars.length - Math.round(ev.W * 1.35)),
        levels: [{ v: ch.ceiling, color: 'rgba(163,182,209,0.5)', dash: true, label: 'Measured high' }, { v: ch.floor, color: 'rgba(163,182,209,0.5)', dash: true, label: 'Measured low' }],
      };
      return {
        from: bars.length - ev.W, showFrom: Math.max(0, bars.length - Math.round(ev.W * 1.35)),
        zones: [
          { a: ch.floor, b: ch.floor + range * p.entryZonePct / 100, color: 'rgba(242,154,74,0.22)' },
          { a: ch.ceiling - range * p.exitZonePct / 100, b: ch.ceiling, color: 'rgba(125,180,246,0.14)' },
        ],
        levels: [
          { v: ch.ceiling, color: 'blue', label: 'Ceiling' },
          { v: ch.mid, color: 'blue', dash: true, label: 'Mid' },
          { v: ch.floor, color: 'orange', label: 'Floor' },
          { v: ch.floor * (1 - p.stopPct / 100), color: 'loss', dash: true, label: 'Stop' },
        ],
      };
    },
    facts(ev, p) {
      if (!ev.ch) return [];
      const ch = ev.ch;
      if (!ch.valid) return [['Measured range', `${ch.floor.toFixed(2)} to ${ch.ceiling.toFixed(2)}, ${ch.widthPct.toFixed(1)}% wide`, 'text'], ['Not a channel', ch.why.join(', '), 'text']];
      return [
        ['Floor', ch.floor, 'price'], ['Ceiling', ch.ceiling, 'price'], ['Width', ch.widthPct, 'pct'],
        ['Position', ch.position, 'pos', `0% is the floor, 100% the ceiling. Touches: ${ch.floorTouches} at the floor, ${ch.ceilTouches} at the ceiling.`],
      ];
    },

    explain: {
      what: 'Looks for large, fairly valued stocks that are moving sideways in a well-defined range, and highlights them when price drops into the bottom of that range.',
      how: [
        'A channel is measured over your look-back: the ceiling from bar highs, the floor from bar lows.',
        'It only counts as a channel if it is flat, the right width, and both edges have been tested several times.',
        'The rules buy in the entry zone near the floor, take profit at the midline or the exit zone near the top, and stop out if price breaks below the floor.',
        'By default the watchlist also requires a valuation discount to peers and analyst upside, so you are looking at quality names that are temporarily out of favour.',
      ],
      settings: [
        'Timeframe matters most. 15 min finds tight intraday ranges, daily finds ranges that have held for months.',
        'Entry zone and exit zone set where buying and profit taking start, as a % of the channel height.',
        'Stop below the floor decides how much room a trade gets before the range is considered broken.',
      ],
      read: [
        'This style usually shows a high win rate with small wins and occasional larger losses when a range breaks. Judge it by profit factor and net result, not win rate.',
        'Compare the net result with buy and hold. If simply holding the stock did better, the rules are not adding value on that stock.',
        'Use "Test on all stocks" to see whether the rules work broadly or only on a few names.',
      ],
    },
  };

  // ============================== Mean reversion ==============================
  const meanrev = {
    id: 'meanrev', name: 'Mean reversion (RSI 2)', short: 'Mean reversion',
    tagline: 'Short, sharp pullbacks in stocks that are still in a long-term uptrend.',
    timeframes: ['1d', '1h', '15m'], defaultTf: '1d',
    defaults: {
      '1d': { trendLen: 200, rsiLen: 2, entryRsi: 10, exitMode: 'sma', exitLen: 5, exitRsi: 70, stopAtr: 0, holdDays: 10, skipEarnings: true, marketFilter: false, useValue: false, useAnalyst: false },
      '1h': { trendLen: 200, rsiLen: 2, entryRsi: 10, exitMode: 'sma', exitLen: 5, exitRsi: 70, stopAtr: 0, holdDays: 3, skipEarnings: true, marketFilter: false, useValue: false, useAnalyst: false },
      '15m': { trendLen: 200, rsiLen: 2, entryRsi: 5, exitMode: 'sma', exitLen: 5, exitRsi: 70, stopAtr: 0, holdDays: 1, skipEarnings: true, marketFilter: false, useValue: false, useAnalyst: false },
    },
    fields: [
      F.trendLen,
      { k: 'rsiLen', label: 'RSI length (bars)', type: 'num', step: 1, min: 2, group: 'Setup',
        help: 'RSI measures how one-sided recent moves were, from 0 (all down) to 100 (all up). A 2-bar RSI reacts to just the last couple of bars, which is what makes it good at spotting short pullbacks.' },
      { k: 'entryRsi', label: 'Enter when RSI is below', type: 'num', step: 1, min: 1, max: 50, group: 'Entry',
        help: 'How oversold the stock must be. 10 is the classic setting; 5 is stricter with fewer, deeper pullbacks.' },
      { k: 'exitMode', label: 'Exit when', type: 'seg', group: 'Exit', options: [['sma', 'Close above short average'], ['rsi', 'RSI recovers']],
        help: 'Close above short average exits once price closes back above its short moving average, meaning the pullback is over. RSI recovers exits when RSI rises above your level.' },
      { k: 'exitLen', label: 'Short average (bars)', type: 'num', step: 1, min: 2, group: 'Exit', show: p => p.exitMode === 'sma',
        help: 'The short moving average used for the exit. 5 bars is the standard.' },
      { k: 'exitRsi', label: 'Exit when RSI is above', type: 'num', step: 1, min: 30, max: 95, group: 'Exit', show: p => p.exitMode === 'rsi',
        help: 'The RSI level that counts as recovered.' },
      { k: 'stopAtr', label: 'Stop, in ATRs below entry (0 = none)', type: 'num', step: 0.5, min: 0, group: 'Exit',
        help: 'ATR is the stock\'s average bar-to-bar range. A stop of 3 ATRs gives normal noise room. Research on this strategy found stops tend to lower returns, because the best trades often dip further first, so the default relies on the time exit instead.' },
      F.holdDays, F.skipEarnings, F.marketFilter, F.useValue, F.useAnalyst,
    ],
    groups: [
      { id: 'active', label: 'Rule active', tip: 'Above its trend average with RSI below your entry level at the last close, or in a trade the rules have not exited yet.' },
      { id: 'setup', label: 'Pulling back', tip: 'Above its trend average with RSI below 30: getting close to your entry level.' },
      { id: 'up', label: 'In an uptrend', tip: 'Above its trend average, not pulling back yet.' },
    ],
    holdDays: p => p.holdDays,

    prepare(bars, p) {
      const c = RW.closes(bars);
      return { c, ma: RW.sma(c, p.trendLen), r: RW.rsi(c, p.rsiLen), ex: RW.sma(c, p.exitLen), a: RW.atr(bars, 14), start: p.trendLen + 1 };
    },
    signalAt(k, ind, p) { return ind.c[k] > ind.ma[k] && ind.r[k] < p.entryRsi; },
    entry(i, bars, ind, p, ctx) {
      if (!this.signalAt(i - 1, ind, p)) return null;
      const px = bars[i][O];
      return { fills: [{ px, usd: ctx.size || 10000 }], stop: p.stopAtr > 0 ? px - p.stopAtr * ind.a[i - 1] : null, maxBars: p.holdDays * perDay(ctx.tf) };
    },
    manage(j, pos, bars, ind, p) {
      if (j > pos.entryIdx) {
        const k = j - 1;
        const done = p.exitMode === 'rsi' ? ind.r[k] > p.exitRsi : ind.c[k] > ind.ex[k];
        if (done) return { price: bars[j][O], reason: 'Exit rule' };
        if (j - pos.entryIdx >= pos.maxBars) return { price: bars[j][O], reason: 'Time exit' };
      }
      return RW.stopTargetExit(j, pos, bars);
    },

    evaluate(bars, p, ctx) {
      if (!bars || bars.length < p.trendLen + 5) return { group: null, score: 0, headline: 'Not enough recent bars', noData: true };
      const sim = RW.simulate(bars, this, p, { ...ctx, skipEarnings: false });
      const ind = sim.ind, k = bars.length - 1;
      const rsi = ind.r[k], above = ind.c[k] > ind.ma[k];
      const signal = this.signalAt(k, ind, p);
      const group = sim.open || signal ? 'active' : above && rsi < 30 ? 'setup' : above ? 'up' : null;
      return {
        group, sim, ind, rsi, open: sim.open,
        score: Math.round(clamp(100 - rsi, 0, 100)),
        headline: sim.open ? `Trade open since ${new Date(sim.open.entryTime * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, RSI ${rsi.toFixed(0)}`
          : signal ? `Oversold: RSI ${rsi.toFixed(0)}` : `RSI ${rsi.toFixed(0)}, ${((ind.c[k] / ind.ma[k] - 1) * 100).toFixed(1)}% vs trend avg`,
        meter: { pos: clamp(rsi, 0, 100), lo: p.entryRsi, hi: 100 - (p.exitMode === 'rsi' ? p.exitRsi : 70), invert: false },
      };
    },
    scoreHelp: '100 minus the current RSI: the more oversold, the higher it ranks.',
    overlay(bars, p, ctx, ev) {
      const ind = ev.ind;
      return {
        from: Math.max(0, bars.length - 120),
        series: [
          { values: ind.ma, color: 'blue', label: `Trend avg (${p.trendLen})` },
          ...(p.exitMode === 'sma' ? [{ values: ind.ex, color: 'orange', dash: true, label: `Exit avg (${p.exitLen})` }] : []),
        ],
        panel: { values: ind.r, label: `RSI ${p.rsiLen}`, min: 0, max: 100, lines: [p.entryRsi, ...(p.exitMode === 'rsi' ? [p.exitRsi] : [])] },
      };
    },
    facts(ev, p) {
      const ind = ev.ind, k = ind.c.length - 1;
      return [
        ['RSI', ev.rsi, 'num0', `Entry below ${p.entryRsi}.`],
        ['Trend avg', ind.ma[k], 'price'],
        ['Vs trend avg', (ind.c[k] / ind.ma[k] - 1) * 100, 'signed'],
        ...(p.exitMode === 'sma' ? [['Exit avg', ind.ex[k], 'price']] : []),
      ];
    },
    explain: {
      what: 'Buys short, sharp dips in stocks that are still in a long-term uptrend, and sells as soon as they bounce. Based on Larry Connors\' RSI(2) strategy, one of the most tested short-term rules for large US stocks.',
      how: [
        'Only stocks above their 200-bar trend average qualify, so you are buying dips, not falling knives.',
        'When the 2-bar RSI closes below 10, the stock is deeply oversold for the short term. The rules buy at the next open.',
        'The trade closes at the next open after price closes back above its 5-bar average, or after the time exit.',
      ],
      settings: [
        'Enter when RSI is below: lower means fewer but deeper pullbacks.',
        'Designed for daily bars. Hourly works; 15 min is noisy and costs matter much more.',
        'The stop is off by default on purpose. Try the market filter first if drawdowns look too deep.',
      ],
      read: [
        'Expect a high win rate (often 65 to 75%), short holds and small average wins. The risk is an occasional large loss when a dip keeps falling.',
        'The strategy is in the market only a small part of the time, so compare net result with buy and hold knowing your money was free most of the time.',
        'It has worked better on broad, liquid stocks than on single names, so check "Test on all stocks".',
      ],
    },
  };

  // ============================== Trend following ==============================
  const trend = {
    id: 'trend', name: 'Trend following (breakout)', short: 'Trend',
    tagline: 'Stocks breaking out to new highs in an established uptrend, held until the trend ends.',
    timeframes: ['1d', '1h', '15m'], defaultTf: '1d',
    defaults: {
      '1d': { entryLen: 50, trendLen: 200, exitMode: 'channel', exitLen: 20, trailAtr: 3, stopAtr: 2, marketFilter: true, useValue: false, useAnalyst: false },
      '1h': { entryLen: 70, trendLen: 200, exitMode: 'channel', exitLen: 35, trailAtr: 3, stopAtr: 2, marketFilter: true, useValue: false, useAnalyst: false },
      '15m': { entryLen: 52, trendLen: 200, exitMode: 'channel', exitLen: 26, trailAtr: 3, stopAtr: 2, marketFilter: false, useValue: false, useAnalyst: false },
    },
    fields: [
      { k: 'entryLen', label: 'Breakout above the high of the last (bars)', type: 'num', step: 5, min: 5, group: 'Entry',
        help: 'A breakout is a close above the highest high of this many previous bars. 50 daily bars is roughly a 10-week high. Longer means fewer, stronger breakouts.' },
      F.trendLen,
      { k: 'exitMode', label: 'Exit when', type: 'seg', group: 'Exit', options: [['channel', 'Close below recent low'], ['atr', 'Trailing ATR stop']],
        help: 'Close below recent low exits when price closes under the lowest low of your exit window (the classic Turtle Traders rule). Trailing ATR stop exits when price closes a set number of ATRs below its highest close since entry.' },
      { k: 'exitLen', label: 'Recent low window (bars)', type: 'num', step: 5, min: 5, group: 'Exit', show: p => p.exitMode === 'channel',
        help: 'Shorter exits sooner and protects more profit, but gets shaken out of trends more often.' },
      { k: 'trailAtr', label: 'Trailing stop (ATRs)', type: 'num', step: 0.5, min: 1, group: 'Exit', show: p => p.exitMode === 'atr',
        help: 'ATR is the stock\'s average bar range. 3 ATRs is a common trailing distance.' },
      { k: 'stopAtr', label: 'Initial stop (ATRs below entry)', type: 'num', step: 0.5, min: 0.5, group: 'Exit',
        help: 'Protects against breakouts that fail straight away. 2 ATRs is the Turtle Traders\' original setting.' },
      F.marketFilter, F.useValue, F.useAnalyst,
    ],
    groups: [
      { id: 'new', label: 'New breakout', tip: 'Broke out within the last 5 bars (or at the last close) and the exit rule has not triggered.' },
      { id: 'riding', label: 'Riding a trend', tip: 'Broke out earlier and the trend is still intact under your exit rule.' },
      { id: 'near', label: 'Near a breakout', tip: 'Above its trend average and within 3% of the breakout level.' },
    ],
    holdDays: () => null,

    prepare(bars, p) {
      const c = RW.closes(bars);
      return { c, hi: RW.priorHigh(bars, p.entryLen), lo: RW.priorLow(bars, p.exitLen), ma: RW.sma(c, p.trendLen), a: RW.atr(bars, 20), start: Math.max(p.trendLen, p.entryLen, p.exitLen, 21) + 1 };
    },
    signalAt(k, ind) { return ind.c[k] > ind.hi[k] && ind.c[k] > ind.ma[k]; },
    entry(i, bars, ind, p, ctx) {
      if (!this.signalAt(i - 1, ind, p)) return null;
      const px = bars[i][O];
      return { fills: [{ px, usd: ctx.size || 10000 }], stop: px - p.stopAtr * ind.a[i - 1], peak: ind.c[i - 1] };
    },
    manage(j, pos, bars, ind, p) {
      if (j > pos.entryIdx) {
        const k = j - 1;
        pos.peak = Math.max(pos.peak, ind.c[k]);
        const out = p.exitMode === 'atr' ? ind.c[k] < pos.peak - p.trailAtr * ind.a[k] : ind.c[k] < ind.lo[k];
        if (out) return { price: bars[j][O], reason: 'Trend exit' };
      }
      return RW.stopTargetExit(j, pos, bars);
    },

    evaluate(bars, p, ctx) {
      if (!bars || bars.length < Math.max(p.trendLen, p.entryLen) + 5) return { group: null, score: 0, headline: 'Not enough recent bars', noData: true };
      const sim = RW.simulate(bars, this, p, ctx);
      const ind = sim.ind, k = bars.length - 1;
      const signal = this.signalAt(k, ind, p);
      const lvl = Math.max(...bars.slice(-p.entryLen).map(b => b[H]));
      const dist = (lvl / ind.c[k] - 1) * 100;
      const vsMa = (ind.c[k] / ind.ma[k] - 1) * 100;
      let group = null;
      if (signal || (sim.open && k - sim.open.entryIdx < 5)) group = 'new';
      else if (sim.open) group = 'riding';
      else if (vsMa > 0 && dist <= 3) group = 'near';
      const gain = sim.open ? (ind.c[k] / sim.open.fills[0].px - 1) * 100 : null;
      return {
        group, sim, ind, open: sim.open, breakout: lvl, dist, vsMa, gain,
        score: Math.round(clamp(40 + vsMa * 2 - (group === 'near' ? dist * 10 : 0), 0, 100)),
        headline: sim.open ? `Since ${new Date(sim.open.entryTime * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${gain >= 0 ? '+' : '−'}${Math.abs(gain).toFixed(0)}%`
          : signal ? 'Breakout at the last close'
          : `${dist.toFixed(1)}% below breakout level`,
      };
    },
    scoreHelp: 'Trend strength: how far price is above its trend average, reduced for stocks that still need to climb to reach the breakout level.',
    overlay(bars, p, ctx, ev) {
      const ind = ev.ind;
      return {
        from: Math.max(0, bars.length - 140),
        series: [
          { values: ind.ma, color: 'blue', label: `Trend avg (${p.trendLen})` },
          { values: ind.hi, color: 'orange', label: `Breakout level (${p.entryLen})` },
          ...(p.exitMode === 'channel' ? [{ values: ind.lo, color: 'loss', dash: true, label: `Exit level (${p.exitLen})` }] : []),
        ],
      };
    },
    facts(ev, p) {
      const ind = ev.ind, k = ind.c.length - 1;
      return [
        ['Breakout level', ev.breakout, 'price'],
        ['Vs trend avg', ev.vsMa, 'signed'],
        ...(p.exitMode === 'channel' ? [['Exit level', ind.lo[k], 'price']] : []),
        ...(ev.open ? [['Since breakout', ev.gain, 'signed']] : []),
      ];
    },
    explain: {
      what: 'Buys stocks as they break out to new highs while in an uptrend, and holds them for as long as the trend lasts. The logic behind the Turtle Traders and most trend-following funds.',
      how: [
        'A stock qualifies when it is above its 200-bar trend average.',
        'The rules buy at the next open after a close above the highest high of the last 50 bars.',
        'The trade is held until price closes below the lowest low of the last 20 bars (or a trailing ATR stop), with an initial stop 2 ATRs below entry for breakouts that fail at once.',
        'By default new trades are only taken while the S&P 500 is in an uptrend.',
      ],
      settings: [
        'Breakout window: longer means fewer, more significant breakouts.',
        'Exit window or trailing stop: tighter locks in profit sooner but gets stopped out of more trends that would have continued.',
        'Daily bars are the natural fit. Hourly and 15 min trends are shorter and costs weigh more.',
      ],
      read: [
        'Expect a low win rate, often 30 to 45%. That is normal: many small losses from false breakouts are paid for by a few large winners.',
        'Profit factor above 1.5 and a best trade far larger than the worst are signs it is working as intended.',
        'Trend following shines in strong trending markets and gives back in choppy ones. Compare with buy and hold and look at the deepest drawdown.',
      ],
    },
  };

  // ============================== Momentum ==============================
  const momentum = {
    id: 'momentum', name: 'Momentum (12 minus 1 month)', short: 'Momentum',
    tagline: 'The strongest performers of the past year, checked once a month.',
    timeframes: ['1d'], defaultTf: '1d',
    tfNote: 'Momentum is measured over months and checked once a month, so it uses daily bars only.',
    defaults: {
      '1d': { lookbackMonths: 12, skipMonths: 1, trendLen: 200, topPct: 25, marketFilter: true, useValue: false, useAnalyst: false },
    },
    fields: [
      { k: 'lookbackMonths', label: 'Momentum look-back (months)', type: 'num', step: 1, min: 3, max: 12, group: 'Setup',
        help: 'Momentum is the price change over this many months. 12 months is the most studied setting; 6 months reacts faster. The app keeps about 15 months of daily bars for the watchlist, so 12 is the maximum.' },
      { k: 'skipMonths', label: 'Skip the most recent (months)', type: 'num', step: 1, min: 0, max: 2, group: 'Setup',
        help: 'The last month is left out because very recent winners tend to pull back briefly before momentum continues. This is the standard "12 minus 1" measure from academic research.' },
      F.trendLen,
      { k: 'topPct', label: 'Leaders: top % of the universe', type: 'num', step: 5, min: 5, max: 100, group: 'Setup',
        help: 'Stocks are ranked by momentum against every other stock in the app. Those in this top slice are shown as leaders. Ranking needs the whole universe at once, so backtests use the absolute rule only (see How it works).' },
      F.marketFilter, F.useValue, F.useAnalyst,
    ],
    groups: [
      { id: 'leader', label: 'Top momentum', tip: 'Positive momentum, above the trend average, and ranked in your top slice of the universe.' },
      { id: 'positive', label: 'Positive momentum', tip: 'Positive momentum and above the trend average, but outside your top slice.' },
      { id: 'fading', label: 'Losing momentum', tip: 'Held under the monthly rule but no longer qualifies. The rules would exit at the next monthly check.' },
    ],
    holdDays: () => null,

    months(p) { return { lb: Math.round(p.lookbackMonths * 21), sk: Math.round(p.skipMonths * 21) }; },
    prepare(bars, p) {
      const c = RW.closes(bars);
      const { lb } = this.months(p);
      return { c, ma: RW.sma(c, p.trendLen), start: Math.max(lb, p.trendLen) + 2 };
    },
    mom(k, ind, p) { const { lb, sk } = this.months(p); return k - lb >= 0 ? ind.c[k - sk] / ind.c[k - lb] - 1 : NaN; },
    qualifies(k, ind, p) { return this.mom(k, ind, p) > 0 && ind.c[k] > ind.ma[k]; },
    isRebal(i, bars) { return new Date(bars[i][T] * 1000).getUTCMonth() !== new Date(bars[i - 1][T] * 1000).getUTCMonth(); },
    entry(i, bars, ind, p, ctx) {
      if (!this.isRebal(i, bars) || !this.qualifies(i - 1, ind, p)) return null;
      return { fills: [{ px: bars[i][O], usd: ctx.size || 10000 }] };
    },
    manage(j, pos, bars, ind, p, ctx) {
      if (j > pos.entryIdx && this.isRebal(j, bars)) {
        const riskOff = p.marketFilter && ctx.regime && ctx.regime(bars[j][T], true) === false;
        if (riskOff || !this.qualifies(j - 1, ind, p)) return { price: bars[j][O], reason: riskOff ? 'Market filter' : 'Monthly check' };
      }
      return null;
    },
    metric(bars, p) {
      const ind = this.prepare(bars, p);
      return bars.length ? this.mom(bars.length - 1, ind, p) : NaN;
    },

    evaluate(bars, p, ctx) {
      const { lb } = this.months(p);
      if (!bars || bars.length < Math.max(lb, p.trendLen) + 3) return { group: null, score: 0, headline: 'Not enough history', noData: true };
      const sim = RW.simulate(bars, this, p, ctx);
      const ind = sim.ind, k = bars.length - 1;
      const m = this.mom(k, ind, p) * 100;
      const q = this.qualifies(k, ind, p);
      const rank = ctx.rankPct == null ? 100 : ctx.rankPct;
      const group = q && rank <= p.topPct ? 'leader' : q ? 'positive' : sim.open ? 'fading' : null;
      return {
        group, sim, ind, open: sim.open, mom: m, rank, rankN: ctx.rankN, rankPos: ctx.rankPos,
        score: Math.round(100 - rank),
        headline: `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(0)}% momentum${ctx.rankPos ? `, #${ctx.rankPos} of ${ctx.rankN}` : ''}`,
      };
    },
    scoreHelp: 'Momentum rank against the whole universe: 100 is the strongest stock, 0 the weakest.',
    overlay(bars, p, ctx, ev) {
      return { from: Math.max(0, bars.length - 260), series: [{ values: ev.ind.ma, color: 'blue', label: `Trend avg (${p.trendLen})` }] };
    },
    facts(ev) {
      return [
        ['Momentum', ev.mom, 'signed', 'Price change over the look-back, excluding the most recent month(s).'],
        ['Rank', ev.rankPos ? `${ev.rankPos} of ${ev.rankN}` : 'n/a', 'text'],
        ['Vs trend avg', (last(ev.ind.c) / last(ev.ind.ma) - 1) * 100, 'signed'],
      ];
    },
    explain: {
      what: 'Holds the stocks that have risen the most over the past year, excluding the last month, and re-checks once a month. Momentum is one of the most persistent patterns documented in stock markets over the last 30 years.',
      how: [
        'Momentum is the price change from 12 months ago to 1 month ago.',
        'On the first trading day of each month, a stock is held if its momentum is positive and it is above its 200-day average; otherwise it is sold.',
        'The watchlist also ranks every stock against the others and highlights the top slice, which is how momentum funds pick stocks.',
        'The backtest can only test one stock at a time, so it uses the absolute rule (positive momentum plus trend) without the ranking.',
      ],
      settings: [
        'Look-back: 12 months is the most studied; 6 months turns over faster.',
        'Leaders: top % controls how selective the ranking is.',
        'The market filter moves to cash when the S&P 500 is below its 200-day average, which avoids most of momentum\'s worst crashes.',
      ],
      read: [
        'Trades are long, often months, and few. Look at net result against buy and hold and at the deepest drawdown.',
        'Momentum tends to lag at turning points and can drop sharply when markets rebound from a crash.',
        'The ranking is the heart of the strategy, so use "Test on all stocks" and look at how many stocks came out ahead rather than at any single stock.',
      ],
    },
  };

  const STRATEGIES = [rebound, meanrev, trend, momentum];
  const api = { list: STRATEGIES, byId: Object.fromEntries(STRATEGIES.map(s => [s.id, s])) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RWS = api;
})(typeof window !== 'undefined' ? window : globalThis);
