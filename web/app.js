/* Rebounder app v2. Vanilla JS, no build step. */
(function () {
  'use strict';
  const RW = window.RW, RWS = window.RWS;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const INLINE = window.__RW_INLINE__ || null;

  // ---------- persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rw2:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rw2:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('rw2:' + k); } catch (e) { /* ignore */ } },
  };
  const FILTER_DEFAULTS = { minCapB: 20, minDollarVolM: 250, peDiscount: 10, minOffHigh: 20, minUpside: 15, requireRising: false };
  const BT_DEFAULTS = { size: 10000, costBps: 5 };
  let ui = { strategy: 'rebound', tf: {}, group: {}, ...store.get('ui', {}) };
  let filters = { ...FILTER_DEFAULTS, ...store.get('filters', {}) };
  let bt = { ...BT_DEFAULTS, ...store.get('bt', {}) };
  let alerts = store.get('alerts', []);
  const seen = store.get('seen', {});
  const saveUi = () => store.set('ui', ui);

  const strat = () => RWS.byId[ui.strategy] || RWS.list[0];
  const tf = () => { const s = strat(), t = ui.tf[s.id]; return s.timeframes.includes(t) ? t : s.defaultTf; };
  const params = (s = strat(), t = tf()) => ({ ...s.defaults[t], ...store.get(`p:${s.id}:${t}`, {}) });
  function setParam(k, v) { const key = `p:${strat().id}:${tf()}`; const o = store.get(key, {}); o[k] = v; store.set(key, o); }

  // ---------- state ----------
  let data = null;
  const recent = {};
  const barsCache = {};
  let selected = null, tab = 'overview', view = 'stock';
  let results = [];
  const testCache = {};

  // ---------- formatting ----------
  const fmt = {
    price: v => v == null || !isFinite(v) ? 'n/a' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    x: v => v == null ? 'n/a' : v.toFixed(1) + '×',
    pct: (v, d = 1) => v == null || !isFinite(v) ? 'n/a' : v.toFixed(d) + '%',
    signed: (v, d = 1) => v == null || !isFinite(v) ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%',
    money: v => v == null || !isFinite(v) ? 'n/a' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString(),
    usd: v => '$' + Math.round(v).toLocaleString(),
    pf: v => v == null ? 'n/a' : v === Infinity ? 'No losses' : v.toFixed(2),
    big: v => v == null ? 'n/a' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : '$' + (v / 1e9).toFixed(0) + 'B',
    date: t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    dateTime: t => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }),
    clock: d => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  };
  function fact(v, kind) {
    if (kind === 'price') return fmt.price(v);
    if (kind === 'pct') return fmt.pct(v);
    if (kind === 'pos') return Math.round(v) + '%';
    if (kind === 'signed') return fmt.signed(v);
    if (kind === 'num0') return v == null || !isFinite(v) ? 'n/a' : Math.round(v).toString();
    return esc(v);
  }

  // ---------- tooltips ----------
  const TIPS = {
    groups: () => ({ title: 'Watchlist groups', body: strat().groups.map(g => `<p><b>${esc(g.label)}.</b> ${esc(g.tip)}</p>`).join('') + '<p>Numbers show how many stocks passing your filters are in each group. Greyed-out groups are empty right now.</p>' }),
    score: () => ({ title: 'Score', body: `<p>A 0 to 100 rating used to rank stocks inside each group. ${esc(strat().scoreHelp)}</p><p>It is a ranking aid, not a prediction.</p>` }),
    pass: () => ({ title: 'Filters', body: '<p>Size and liquidity filters always apply. Value and analyst filters apply when the strategy has them switched on. Change them under Rules and filters.</p>' }),
    market: () => ({ title: 'Market trend', body: '<p>Whether the S&P 500 (SPY) closed above its 200-day moving average. It is the most common test for a broad market uptrend.</p><p>Strategies with the market filter switched on only take new trades while this is up.</p>' }),
    fresh: () => freshnessTip(),
    tf: () => ({ title: 'Timeframe', body: `<p>The bar size used for the watchlist, the chart and the backtest. 15 min bars cover about 60 days of history, hourly about 2 years, daily up to 10 years.</p><p>Each strategy remembers its own timeframe and settings.</p>${strat().tfNote ? `<p>${esc(strat().tfNote)}</p>` : ''}` }),
    'f-minCapB': { title: 'Minimum market cap', body: '<p>Company value in billions of dollars. Large caps are harder to move and better covered by analysts.</p>' },
    'f-minDollarVolM': { title: 'Minimum daily dollar volume', body: '<p>Average shares traded per day times price, in millions. High volume means tight spreads, so fills in the backtest are more realistic.</p>' },
    'f-peDiscount': { title: 'Forward P/E discount', body: '<p>How much cheaper than its peer median the stock must be on forward P/E (price divided by next year\'s expected earnings). 10 means at least 10% cheaper.</p>' },
    'f-minOffHigh': { title: 'Below 52-week high', body: '<p>How far the price must be below its highest price of the past year. Finds stocks that have pulled back. Leave off for trend and momentum, which prefer stocks near their highs.</p>' },
    'f-minUpside': { title: 'Analyst upside', body: '<p>Upside from today\'s price to the recency-weighted analyst target. Each firm\'s latest target counts, with recent targets weighted more (45-day half-life).</p>' },
    'f-requireRising': { title: 'Rising targets only', body: '<p>Only stocks where analysts raised targets clearly more often than they cut them in the last 90 days.</p>' },
    'f-size': { title: 'Position size', body: '<p>Dollars put into each trade in the backtest. Results scale in proportion, so this only changes the dollar figures.</p>' },
    'f-costBps': { title: 'Costs per side', body: '<p>Commission plus spread and slippage, in basis points (1 bp = 0.01%) charged on both the buy and the sell. 5 bps is realistic for liquid large caps; raise it for 15 min strategies.</p>' },
    'm-net': { title: 'Net result', body: '<p>Total profit or loss from every trade after costs, with the position size you set. Trades still open at the end of the data are not counted.</p>' },
    'm-bh': { title: 'Buy and hold', body: '<p>What the same position size would have made by buying at the start of the test period and holding to the end. Note that buy and hold is always invested, while the strategy is only invested part of the time.</p>' },
    'm-win': { title: 'Win rate', body: '<p>Share of trades that made money after costs. On its own it says little: a 90% win rate still loses money if the losses are much bigger than the wins.</p>' },
    'm-pf': { title: 'Profit factor', body: '<p>Total dollars won divided by total dollars lost. Above 1 is profitable; 1.5 or more is solid; below 1 loses money. It is the most useful single number here.</p>' },
    'm-dd': { title: 'Deepest drawdown', body: '<p>The largest drop in cumulative results from a previous high, in dollars. It shows how painful the worst stretch would have felt.</p>' },
    'm-avgwin': { title: 'Average win and loss', body: '<p>Average dollar result of winning trades and of losing trades.</p>' },
    'm-exp': { title: 'Result per trade', body: '<p>Net result divided by the number of trades, also called expectancy. What an average trade was worth.</p>' },
    'm-breakeven': { title: 'Break-even win rate', body: '<p>The win rate needed to break even given the average win and loss sizes. The further your actual win rate is above this, the more margin of safety.</p>' },
    'm-exposure': { title: 'Time in market', body: '<p>Share of bars where a trade was open. Low exposure means capital was free for other uses most of the time.</p>' },
    'm-hold': { title: 'Average hold', body: '<p>Average calendar days from entry to exit.</p>' },
    hindsight: { title: 'Why test every stock', body: '<p>Today\'s filters use today\'s fundamentals. Testing only stocks that pass them now picks names with hindsight, which flatters results. Testing the whole universe is the honest check.</p>' },
    alerts: { title: 'Alerts', body: '<p>Alerts are stored in this browser and checked each time prices refresh while the page is open. Allow notifications to get a pop-up. Email alerts are planned.</p>' },
    peers: { title: 'Peer comparison', body: '<p>Median of the stocks in this app\'s universe from the same industry, or the same sector when fewer than 4 industry peers exist. Blue means cheaper than peers on that measure.</p>' },
  };
  function tipFor(key) {
    let t = TIPS[key];
    if (!t && key.startsWith('p-')) {
      const f = strat().fields.find(x => x.k === key.slice(2));
      t = f && { title: f.label, body: `<p>${esc(f.help)}</p>` };
    }
    return typeof t === 'function' ? t() : t;
  }
  const info = (key, label) => `<button type="button" class="info" data-tip="${key}" aria-label="About ${esc(label || 'this')}">i</button>`;

  const tipEl = $('#tip');
  let tipOwner = null, tipPinned = false, tipTimer = null;
  function openTip(btn, pinned) {
    const t = tipFor(btn.dataset.tip);
    if (!t) return;
    clearTimeout(tipTimer);
    tipEl.innerHTML = `<h4>${esc(t.title)}</h4>${t.body}`;
    tipEl.hidden = false;
    tipOwner = btn; tipPinned = pinned;
    $$('.info[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8 && r.top - th - 8 > 8) top = r.top - th - 8;
    tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
  }
  function closeTip() {
    clearTimeout(tipTimer);
    tipEl.hidden = true;
    if (tipOwner) tipOwner.setAttribute('aria-expanded', 'false');
    tipOwner = null; tipPinned = false;
  }
  const hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  document.addEventListener('pointerover', e => {
    if (!hoverCapable) return;
    const btn = e.target.closest('.info');
    if (btn && !tipPinned) { clearTimeout(tipTimer); tipTimer = setTimeout(() => openTip(btn, false), 120); }
    else if (e.target.closest('#tip')) clearTimeout(tipTimer);
  });
  document.addEventListener('pointerout', e => {
    if (!hoverCapable || tipPinned) return;
    const from = e.target.closest('.info, #tip');
    const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.info, #tip');
    if (from && from !== to && !(to && (to === tipEl || to === tipOwner))) {
      clearTimeout(tipTimer); tipTimer = setTimeout(closeTip, 180);
    }
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('.info');
    if (btn) { e.preventDefault(); e.stopPropagation(); if (tipOwner === btn && tipPinned) closeTip(); else openTip(btn, true); return; }
    if (!e.target.closest('#tip') && !tipEl.hidden) closeTip();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeTip(); closeRules(); } });
  window.addEventListener('scroll', () => { if (!tipEl.hidden) closeTip(); }, { passive: true, capture: true });

  // ---------- data loading ----------
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} could not be loaded (HTTP ${r.status}).`);
    return r.json();
  }
  async function loadScreen() { return INLINE ? INLINE.screen : getJSON('data/screen.json'); }
  async function loadRecent(t, force) {
    if (recent[t] && !force) return recent[t];
    recent[t] = INLINE ? INLINE.recent[t] : await getJSON(`data/recent/${t}.json`);
    return recent[t];
  }
  async function loadBars(t, tk) {
    const key = `${t}:${tk}`;
    if (barsCache[key]) return barsCache[key];
    if (INLINE) return (barsCache[key] = (INLINE.bars[t] || {})[tk] || []);
    return (barsCache[key] = await getJSON(`data/bars/${t}/${encodeURIComponent(tk)}.json`));
  }
  async function fullRegime() {
    try { return RW.makeRegime(await loadBars('1d', 'SPY')); } catch (e) { return () => null; }
  }
  const recentRegime = () => RW.makeRegime(recent['1d'] && recent['1d'].SPY);

  // ---------- screening ----------
  function upside(s) { const t = s.target && (s.target.weighted || s.target.mean); return t && s.price ? (t / s.price - 1) * 100 : null; }
  function peDiscount(s) { const pp = s.peers && s.peers.fwdPE; return s.fwdPE > 0 && pp ? (1 - s.fwdPE / pp) * 100 : null; }
  function filterFails(s, p) {
    const f = [];
    if (!(s.marketCap >= filters.minCapB * 1e9)) f.push('market cap');
    if (!(s.avgDollarVolume >= filters.minDollarVolM * 1e6)) f.push('trading volume');
    if (p.useValue) {
      if (!(peDiscount(s) >= filters.peDiscount)) f.push('valuation vs peers');
      if (!(s.offHighPct >= filters.minOffHigh)) f.push('distance from 52-week high');
    }
    if (p.useAnalyst) {
      if (!(upside(s) >= filters.minUpside)) f.push('analyst upside');
      if (filters.requireRising && !(s.target && s.target.trend90 === 'rising')) f.push('target revisions');
    }
    return f;
  }
  function stockCtx(st, s, t, p, extra) {
    return { tf: t, size: bt.size, costBps: bt.costBps, marketFilter: p.marketFilter, peDiscount: peDiscount(st), upside: upside(st), ...extra };
  }
  function evaluateAll() {
    if (!data) return;
    const s = strat(), t = tf(), p = params();
    const rec = recent[t] || {};
    const ranks = {};
    if (s.metric) {
      const vals = data.stocks.map(st => [st.ticker, s.metric(rec[st.ticker] || [], p)]).filter(x => isFinite(x[1])).sort((a, b) => b[1] - a[1]);
      vals.forEach(([tk], i) => { ranks[tk] = { rankPos: i + 1, rankN: vals.length, rankPct: vals.length > 1 ? (i / (vals.length - 1)) * 100 : 0 }; });
    }
    const regime = recentRegime();
    results = data.stocks.map(st => {
      const ctx = stockCtx(st, s, t, p, { regime, ...(ranks[st.ticker] || {}) });
      let ev;
      try { ev = s.evaluate(rec[st.ticker], p, ctx); } catch (e) { console.error(e); ev = { group: null, score: 0, headline: 'Could not evaluate' }; }
      return { s: st, fails: filterFails(st, p), ev, ctx };
    });
  }

  // ---------- header, strategy and timeframe ----------
  function renderHeader() {
    const s = strat(), t = tf();
    $('#strategy-seg').innerHTML = RWS.list.map(x =>
      `<button type="button" data-strategy="${x.id}" aria-pressed="${x.id === s.id}">${esc(x.short)}</button>`).join('');
    $('#strategy-line').innerHTML = `<b>${esc(s.name)}.</b> ${esc(s.tagline)}`;
    $('#tf-seg').innerHTML = tfButtons() + info('tf', 'timeframes');
  }
  function tfButtons() {
    const s = strat(), t = tf();
    return ['15m', '1h', '1d'].map(k => {
      const ok = s.timeframes.includes(k);
      return `<button type="button" data-tf="${k}" aria-pressed="${k === t}" ${ok ? '' : `disabled title="${esc(s.tfNote || 'Not available for this strategy')}"`}>${RW.TF[k].label}</button>`;
    }).join('');
  }
  document.addEventListener('click', e => {
    const sb = e.target.closest('[data-strategy]');
    if (sb) { switchStrategy(sb.dataset.strategy); return; }
    const tb = e.target.closest('[data-tf]');
    if (tb && !tb.disabled) switchTf(tb.dataset.tf);
  });
  async function switchStrategy(id) {
    if (id === ui.strategy) return;
    ui.strategy = id; saveUi();
    await applyChange();
    if (!seen[id]) { seen[id] = true; store.set('seen', seen); openExplainer(); }
  }
  async function switchTf(t) {
    if (t === tf()) return;
    ui.tf[strat().id] = t; saveUi();
    await applyChange();
  }
  async function applyChange() {
    renderHeader();
    closeTip();
    try { await loadRecent(tf()); } catch (e) { $('#watchlist').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    evaluateAll();
    renderWatchlist();
    if (!$('#rules').hidden) renderRules();
    if (view === 'test') renderTestAll();
    else if (selected) renderDetail();
    writeHash();
  }

  // ---------- watchlist ----------
  function renderWatchlist() {
    const el = $('#watchlist');
    if (!data) return;
    const s = strat();
    const passing = results.filter(r => !r.fails.length);
    const counts = Object.fromEntries(s.groups.map(g => [g.id, passing.filter(r => r.ev.group === g.id).length]));
    let g = ui.group[s.id];
    if (!counts[g]) g = (s.groups.find(x => counts[x.id]) || s.groups[0]).id;
    $('#groups').innerHTML = s.groups.map(x =>
      `<button type="button" role="tab" data-group="${x.id}" aria-selected="${x.id === g}" ${counts[x.id] ? '' : 'disabled'}>
        <span>${esc(x.label)}</span><span class="count">${counts[x.id]}</span></button>`).join('') + info('groups', 'watchlist groups');
    $$('#groups [data-group]').forEach(b => b.addEventListener('click', () => { ui.group[s.id] = b.dataset.group; saveUi(); renderWatchlist(); }));

    const rows = passing.filter(r => r.ev.group === g).sort((a, b) => b.ev.score - a.ev.score);
    const anything = Object.values(counts).some(Boolean);
    if (!anything) {
      el.innerHTML = `<p class="empty">No stocks passing your filters are in any group right now. Try another timeframe, or loosen the filters under Rules and filters.</p>`;
    } else {
      el.innerHTML = `<ul class="stock-list">${rows.map(row).join('')}</ul>`;
      $$('#watchlist button.stock').forEach(b => b.addEventListener('click', () => select(b.dataset.tk)));
    }
    const noData = results.filter(r => r.ev.noData).length;
    $('#side-foot').innerHTML = `
      <p>${passing.length} of ${results.length} stocks pass your filters ${info('pass', 'filters')}${noData ? `<br><span class="faint">${noData} without enough ${RW.TF[tf()].long} history yet</span>` : ''}</p>
      <button class="btn ghost wide" type="button" id="open-test" aria-pressed="${view === 'test'}">Test on all ${results.length} stocks</button>`;
    $('#open-test').addEventListener('click', () => { view = 'test'; renderTestAll(); renderWatchlist(); writeHash(); scrollMainIntoView(); });
  }
  function row(r) {
    const m = r.ev.meter;
    return `<li><button class="stock" data-tk="${esc(r.s.ticker)}" aria-current="${view === 'stock' && selected === r.s.ticker}">
      <span class="tk">${esc(r.s.ticker)}<span class="nm">${esc(r.s.name)}</span></span>
      <span class="px">${fmt.price(r.s.price)}</span>
      <span class="hl">${esc(r.ev.headline)}</span><span class="score" title="Score">${r.ev.score}</span>
      ${m ? `<span class="meter" aria-hidden="true"><span class="z-lo" style="width:${m.lo}%"></span><span class="z-hi" style="width:${m.hi}%"></span><span class="dot" style="left:${m.pos}%"></span></span>` : ''}
    </button></li>`;
  }
  function renderMarketChip() {
    const m = data && data.market, el = $('#market-chip');
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'market-chip ' + (m.above ? 'up' : 'down');
    el.innerHTML = `<i></i><span>S&P 500 ${m.above ? 'above' : 'below'} its 200-day avg (${fmt.signed(m.vsMaPct)})</span>${info('market', 'market trend')}`;
  }

  // ---------- rules drawer ----------
  function openRules() { renderRules(); $('#rules').hidden = false; $('#rules-scrim').hidden = false; $('#open-rules').setAttribute('aria-expanded', 'true'); $('#close-rules').focus(); }
  function closeRules() { if ($('#rules').hidden) return; $('#rules').hidden = true; $('#rules-scrim').hidden = true; $('#open-rules').setAttribute('aria-expanded', 'false'); closeTip(); }
  $('#open-rules').addEventListener('click', openRules);
  $('#close-rules').addEventListener('click', closeRules);
  $('#rules-scrim').addEventListener('click', closeRules);

  function fieldRow(f, value, prefix) {
    const id = `${prefix}-${f.k}`;
    let input;
    if (f.type === 'check') input = `<input type="checkbox" id="${id}" data-${prefix}="${f.k}" ${value ? 'checked' : ''}>`;
    else if (f.type === 'seg') input = `<span class="seg mini" role="group" aria-label="${esc(f.label)}">${f.options.map(([v, l]) =>
      `<button type="button" data-${prefix}="${f.k}" data-v="${v}" aria-pressed="${String(value) === String(v)}">${esc(l)}</button>`).join('')}</span>`;
    else input = `<input type="number" inputmode="decimal" id="${id}" data-${prefix}="${f.k}" value="${value}" step="${f.step || 1}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}>`;
    const tipKey = prefix === 'p' ? `p-${f.k}` : `f-${f.k}`;
    return `<div class="field ${f.type === 'seg' ? 'stack' : ''}"><label for="${id}">${esc(f.label)}</label>${info(tipKey, f.label)}${input}</div>`;
  }
  const FILTER_FIELDS = {
    size: [{ k: 'minCapB', label: 'Minimum market cap ($B)', step: 1, min: 0 }, { k: 'minDollarVolM', label: 'Minimum daily dollar volume ($M)', step: 10, min: 0 }],
    value: [{ k: 'peDiscount', label: 'Forward P/E below peer median by (%)', step: 1 }, { k: 'minOffHigh', label: 'Below 52-week high by at least (%)', step: 1, min: 0 }],
    analyst: [{ k: 'minUpside', label: 'Analyst upside at least (%)', step: 1 }, { k: 'requireRising', label: 'Only if targets are rising', type: 'check' }],
  };
  function renderRules() {
    const s = strat(), t = tf(), p = params();
    const groupsOrder = [];
    s.fields.forEach(f => { if (!groupsOrder.includes(f.group)) groupsOrder.push(f.group); });
    const stratHtml = groupsOrder.map(gname => {
      const fs = s.fields.filter(f => f.group === gname && (!f.show || f.show(p)));
      return fs.length ? `<div class="gate"><h4>${esc(gname)}</h4>${fs.map(f => fieldRow(f, p[f.k], 'p')).join('')}</div>` : '';
    }).join('');
    const off = on => on ? '' : ' is-off';
    $('#rules-body').innerHTML = `
      <section>
        <h3>${esc(s.name)} <small>${RW.TF[t].label} bars</small></h3>
        <p class="note">Saved separately for each strategy and timeframe. The recommended values are research-based starting points.</p>
        ${stratHtml}
        <button class="btn ghost" type="button" id="reset-strategy">Reset to recommended ${RW.TF[t].label.toLowerCase()} settings</button>
      </section>
      <section>
        <h3>Filters <small>watchlist only</small></h3>
        <div class="gate"><h4>Size and liquidity</h4>${FILTER_FIELDS.size.map(f => fieldRow(f, filters[f.k], 'f')).join('')}</div>
        <div class="gate${off(p.useValue)}"><h4>Value ${p.useValue ? '' : '<span class="off-tag">off for this strategy</span>'}</h4>${FILTER_FIELDS.value.map(f => fieldRow(f, filters[f.k], 'f')).join('')}</div>
        <div class="gate${off(p.useAnalyst)}"><h4>Analysts ${p.useAnalyst ? '' : '<span class="off-tag">off for this strategy</span>'}</h4>${FILTER_FIELDS.analyst.map(f => fieldRow({ type: 'num', ...f }, filters[f.k], 'f')).join('')}</div>
        <button class="btn ghost" type="button" id="reset-filters">Reset filters</button>
      </section>
      <section>
        <h3>Backtest</h3>
        ${fieldRow({ k: 'size', label: 'Position size per trade ($)', step: 1000, min: 100 }, bt.size, 'b')}
        ${fieldRow({ k: 'costBps', label: 'Costs per side (bps)', step: 1, min: 0 }, bt.costBps, 'b')}
      </section>`;
    const body = $('#rules-body');
    const changed = () => { evaluateAll(); renderWatchlist(); if (view === 'test') renderTestAll(); else if (selected) renderDetail(); };
    body.querySelectorAll('[data-p]').forEach(el => {
      const k = el.dataset.p, f = s.fields.find(x => x.k === k);
      const handler = () => {
        let v;
        if (el.tagName === 'BUTTON') v = f.options.find(o => String(o[0]) === el.dataset.v)[0];
        else if (el.type === 'checkbox') v = el.checked;
        else { v = Number(el.value); if (!isFinite(v)) return; if (f.min != null) v = Math.max(f.min, v); if (f.max != null) v = Math.min(f.max, v); }
        setParam(k, v);
        renderRules(); changed();
      };
      el.addEventListener(el.tagName === 'BUTTON' ? 'click' : 'change', handler);
    });
    body.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => {
      filters[el.dataset.f] = el.type === 'checkbox' ? el.checked : Number(el.value);
      store.set('filters', filters); changed();
    }));
    body.querySelectorAll('[data-b]').forEach(el => el.addEventListener('change', () => {
      const v = Number(el.value); if (!(v >= 0)) return;
      bt[el.dataset.b] = v; store.set('bt', bt); changed();
    }));
    $('#reset-strategy').addEventListener('click', () => { store.del(`p:${s.id}:${t}`); renderRules(); changed(); });
    $('#reset-filters').addEventListener('click', () => { filters = { ...FILTER_DEFAULTS }; store.set('filters', filters); renderRules(); changed(); });
  }

  // ---------- explainer ----------
  function openExplainer() {
    const s = strat(), x = s.explain, p = params();
    const list = a => `<ul>${a.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    $('#explainer-body').innerHTML = `
      <div class="ex-head"><h2 id="ex-title">${esc(s.name)}</h2><button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
      <p class="ex-lead">${esc(x.what)}</p>
      <h3>How it works</h3>${list(x.how)}
      <h3>Settings that matter</h3>${list(x.settings)}
      <h3>Reading the results</h3>${list(x.read)}
      <p class="note">Currently on ${RW.TF[tf()].long} bars${s.timeframes.length > 1 ? `; also available on ${s.timeframes.filter(k => k !== tf()).map(k => RW.TF[k].long).join(' and ')}` : ''}. ${p.marketFilter ? 'The market filter is on.' : 'The market filter is off.'} Every setting has an i button with more detail under Rules and filters.</p>
      <div class="ex-foot"><button class="btn" type="button" data-close>Got it</button></div>`;
    const dlg = $('#explainer');
    $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  $('#open-explainer').addEventListener('click', openExplainer);
  $('#explainer').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  // ---------- detail ----------
  function select(tk) {
    selected = tk; view = 'stock';
    renderWatchlist(); renderDetail(); writeHash();
    scrollMainIntoView();
  }
  function scrollMainIntoView() { if (window.matchMedia('(max-width: 900px)').matches) $('#main').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  const current = () => results.find(r => r.s.ticker === selected);
  const groupLabel = g => (strat().groups.find(x => x.id === g) || {}).label;

  function renderDetail() {
    const r = current();
    if (!r) { $('#main').innerHTML = '<p class="empty">Pick a stock from the watchlist.</p>'; return; }
    const s = r.s, gl = groupLabel(r.ev.group);
    $('#main').innerHTML = `
      <div class="detail-head">
        <div><h2>${esc(s.ticker)}<span>${esc(s.name)}</span></h2>
          <div class="badges">${gl ? `<span class="badge">${esc(gl)}</span>` : '<span class="badge muted">Not active in this strategy</span>'}
          <span class="badge score-badge">Score ${r.ev.score}${info('score', 'score')}</span></div></div>
        <div class="price">${fmt.price(s.price)}<small>${esc(r.ev.headline)}</small></div>
      </div>
      ${r.fails.length ? `<p class="callout">Outside your filters on ${esc(r.fails.join(', '))}.</p>` : ''}
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="overview" aria-selected="${tab === 'overview'}">Overview</button>
        <button role="tab" data-tab="backtest" aria-selected="${tab === 'backtest'}">Backtest</button>
      </div>
      <div id="tab-body"></div>`;
    $$('#main [data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; renderDetail(); }));
    if (tab === 'overview') renderOverview(r); else renderBacktest(r);
  }

  function renderOverview(r) {
    const s = r.s, st = strat(), p = params(), t = tf();
    const bars = (recent[t] || {})[s.ticker] || [];
    const peer = s.peers || {}, tg = s.target || {};
    const facts = r.ev.noData ? [] : st.facts(r.ev, p);
    const ratios = [
      ['Forward P/E', s.fwdPE, peer.fwdPE, fmt.x, true], ['EV / EBITDA', s.evEbitda, peer.evEbitda, fmt.x, true],
      ['Price / sales', s.ps, peer.ps, fmt.x, true], ['Free cash flow yield', s.fcfYield, peer.fcfYield, v => fmt.pct(v), false],
      ['Dividend yield', s.divYield, peer.divYield, v => fmt.pct(v, 2), false],
    ];
    const rel = (v, pv, low) => v == null || pv == null ? '' : (low ? v < pv : v > pv) ? 'rel-good' : 'rel-bad';
    const relT = (v, pv) => v == null || !pv ? 'n/a' : fmt.signed((v / pv - 1) * 100, 0);
    $('#tab-body').innerHTML = `
      <div class="card chart-card">
        <div class="card-head"><h3>${RW.TF[t].label} chart</h3><div class="seg mini" role="group" aria-label="Timeframe">${tfButtons()}</div></div>
        ${facts.length ? `<div class="facts">${facts.map(([l, v, k, tip]) => `<span>${esc(l)} <b>${fact(v, k)}</b>${tip ? ` <span class="faint">(${esc(tip)})</span>` : ''}</span>`).join('')}</div>` : ''}
        ${bars.length ? `<div class="chart-wrap ${st.id === 'meanrev' ? 'tall' : ''}"><canvas id="candles" role="img" aria-label="${RW.TF[t].long} candles for ${esc(s.ticker)} with ${esc(st.name)} levels"></canvas></div><div class="chart-legend" id="legend"></div>`
        : `<p class="empty">No ${RW.TF[t].long} bars for ${esc(s.ticker)} yet.</p>`}
      </div>
      <div class="grid-2">
        <div class="card">
          <h3>Valuation vs ${esc(peer.level || 'peer')} peers <span class="h-sub">(${esc(peer.name || 'n/a')})</span> ${info('peers', 'peer comparison')}</h3>
          <table class="ratios">
            <thead><tr><th scope="col">Ratio</th><th scope="col">${esc(s.ticker)}</th><th scope="col">Peers</th><th scope="col">Diff</th></tr></thead>
            <tbody>${ratios.map(([l, v, pv, f, low]) => `<tr><td>${l}</td><td>${f(v)}</td><td>${f(pv)}</td><td class="${rel(v, pv, low)}">${relT(v, pv)}</td></tr>`).join('')}</tbody>
          </table>
          <p class="note">Median of ${peer.n || 0} stocks. Fundamentals as of ${esc(data.meta.fundamentalsDate || 'n/a')}.</p>
        </div>
        <div class="card">
          <h3>Analysts and events</h3>
          <dl class="kv">
            <dt>Recency-weighted target</dt><dd>${fmt.price(tg.weighted)} <span class="faint">(${fmt.signed(upside(s))})</span></dd>
            <dt>Consensus target</dt><dd>${fmt.price(tg.mean)}</dd>
            <dt>Target changes, 90 days</dt><dd>${tg.raised90 == null ? 'n/a' : `${tg.raised90} up, ${tg.lowered90} down`}</dd>
            <dt>Below 52-week high</dt><dd>${fmt.pct(s.offHighPct)}</dd>
            <dt>Market cap</dt><dd>${fmt.big(s.marketCap)}</dd>
            <dt>Next earnings</dt><dd>${s.nextEarnings ? fmt.date(s.nextEarnings) : 'n/a'}</dd>
          </dl>
        </div>
      </div>
      ${s.ai ? `<div class="card"><h3>AI summary</h3><p class="flat">${esc(s.ai)}</p><p class="note">Generated ${esc(s.aiDate || '')} from the figures above. Descriptive only.</p></div>` : ''}
      ${alertsCard(r)}`;
    wireAlerts(r);
    if (bars.length) drawCandles(bars, r);
  }

  // ---------- alerts ----------
  function alertsCard(r) {
    const s = r.s, st = strat(), mine = alerts.filter(a => a.ticker === s.ticker);
    const channelForm = st.id === 'rebound' ? `
      <form class="alert-form" id="al-channel"><span>Within</span><input id="al-pct" type="number" min="0" max="100" step="1" value="10" aria-label="Percent of channel height">
      <select id="al-side" aria-label="Channel edge"><option value="floor">% above the floor</option><option value="ceiling">% below the ceiling</option></select>
      <button class="btn small" type="submit">Add</button></form>` : '';
    return `<div class="card"><h3>Alerts ${info('alerts', 'alerts')}</h3>
      <form class="alert-form" id="al-group"><span>When ${esc(s.ticker)} moves into</span>
        <select id="al-g" aria-label="Group">${st.groups.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</select>
        <button class="btn small" type="submit">Add</button></form>
      ${channelForm}
      <ul class="alerts">${mine.map(a => `<li class="${alertHit(a) ? 'hit' : ''}"><span>${esc(alertText(a))}${alertHit(a) ? ' · reached' : ''}</span><button type="button" data-del="${a.id}" aria-label="Remove alert">✕</button></li>`).join('')}</ul>
    </div>`;
  }
  function alertText(a) {
    const st = RWS.byId[a.strategy], tl = RW.TF[a.tf].label.toLowerCase();
    if (a.kind === 'channel') return `Within ${a.pct}% ${a.side === 'floor' ? 'above the channel floor' : 'below the channel ceiling'} (${tl})`;
    return `${(st.groups.find(g => g.id === a.group) || {}).label} in ${st.short} (${tl})`;
  }
  function evalFor(a) {
    const st = RWS.byId[a.strategy], rec = recent[a.tf], stock = data && data.stocks.find(x => x.ticker === a.ticker);
    if (!st || !rec || !stock || !rec[a.ticker]) return null;
    const p = params(st, a.tf);
    try { return st.evaluate(rec[a.ticker], p, stockCtx(stock, st, a.tf, p, { regime: recentRegime() })); } catch (e) { return null; }
  }
  function alertHit(a) {
    const ev = evalFor(a);
    if (!ev) return false;
    if (a.kind === 'group') return ev.group === a.group;
    const ch = ev.ch;
    if (!ch || !ch.valid) return false;
    const h = ch.ceiling - ch.floor, price = ch.floor + h * ch.position / 100;
    return a.side === 'floor' ? price <= ch.floor + h * a.pct / 100 : price >= ch.ceiling - h * a.pct / 100;
  }
  function wireAlerts(r) {
    const add = a => {
      alerts.push({ id: Date.now(), ticker: r.s.ticker, strategy: strat().id, tf: tf(), ...a });
      store.set('alerts', alerts);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      renderDetail();
    };
    $('#al-group').addEventListener('submit', e => { e.preventDefault(); add({ kind: 'group', group: $('#al-g').value }); });
    const ch = $('#al-channel');
    if (ch) ch.addEventListener('submit', e => { e.preventDefault(); add({ kind: 'channel', side: $('#al-side').value, pct: Math.max(0, Math.min(100, Number($('#al-pct').value) || 0)) }); });
    $$('#tab-body [data-del]').forEach(b => b.addEventListener('click', () => { alerts = alerts.filter(a => String(a.id) !== b.dataset.del); store.set('alerts', alerts); renderDetail(); }));
  }
  async function checkAlerts() {
    if (!data || !alerts.length) return;
    const fired = store.get('fired', []);
    for (const a of alerts) {
      try { await loadRecent(a.tf); } catch (e) { continue; }
      const key = `${a.id}:${data.meta.generated}`;
      if (alertHit(a) && !fired.includes(key)) {
        fired.push(key);
        if ('Notification' in window && Notification.permission === 'granted') new Notification(`${a.ticker}: alert reached`, { body: alertText(a) });
      }
    }
    store.set('fired', fired.slice(-300));
  }

  // ---------- charts ----------
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const colorOf = c => ({ blue: css('--blue-soft'), orange: css('--orange'), loss: css('--loss') }[c] || c);

  function drawCandles(bars, r) {
    const canvas = $('#candles'); if (!canvas) return;
    const st = strat(), p = params(), t = tf();
    const ev = r.ev.noData ? null : r.ev;
    const ov = ev ? st.overlay(bars, p, r.ctx, ev) : { from: Math.max(0, bars.length - 120) };
    let sim = ev && ev.sim;
    if (!sim) { try { sim = RW.simulate(bars, st, p, { ...r.ctx, skipEarnings: false }); } catch (e) { sim = null; } }
    const start = Math.max(0, Math.min(ov.showFrom != null ? ov.showFrom : ov.from, bars.length - 20));
    const vis = bars.slice(start);
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const panelH = ov.panel ? 86 : 0, padL = 6, padR = 64, padT = 10, padB = 24, gap = ov.panel ? 14 : 0;
    const priceB = h - padB - panelH - gap;
    let lo = Math.min(...vis.map(b => b[3])), hi = Math.max(...vis.map(b => b[2]));
    (ov.levels || []).forEach(l => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    (ov.series || []).forEach(sr => sr.values.slice(start).forEach(v => { if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    const py = (hi - lo) * 0.06; lo -= py; hi += py;
    const y = v => padT + (hi - v) / (hi - lo) * (priceB - padT);
    const cw = (w - padL - padR) / vis.length;
    const x = i => padL + (i - start + 0.5) * cw;
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';

    // grid
    ctx.strokeStyle = 'rgba(163,182,209,0.08)'; ctx.lineWidth = 1; ctx.fillStyle = css('--faint');
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(fmt.price(v), w - padR + 6, yy + 4);
    }
    // time labels
    let lastKey = null, lastX = -99;
    vis.forEach((b, k) => {
      const d = new Date(b[0] * 1000);
      const key = t === '1d' ? d.getFullYear() * 12 + d.getMonth() : d.toDateString();
      if (key !== lastKey) {
        const xx = padL + k * cw;
        if (lastKey !== null) { ctx.strokeStyle = 'rgba(163,182,209,0.1)'; ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, priceB); ctx.stroke(); }
        if (xx - lastX > 46) {
          ctx.fillStyle = css('--faint');
          ctx.fillText(t === '1d' ? d.toLocaleDateString(undefined, d.getMonth() === 0 ? { year: 'numeric' } : { month: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), xx + 3, h - 7);
          lastX = xx;
        }
        lastKey = key;
      }
    });
    // zones and levels (drawn over the measured window only)
    const x0 = padL + Math.max(0, ov.from - start) * cw, x1 = w - padR;
    (ov.zones || []).forEach(z => { ctx.fillStyle = z.color; ctx.fillRect(x0, y(z.b), x1 - x0, y(z.a) - y(z.b)); });
    (ov.levels || []).forEach(l => {
      ctx.strokeStyle = colorOf(l.color); ctx.lineWidth = 1.5; ctx.setLineDash(l.dash ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x0, y(l.v)); ctx.lineTo(x1, y(l.v)); ctx.stroke(); ctx.setLineDash([]);
    });
    // indicator lines
    (ov.series || []).forEach(sr => {
      ctx.strokeStyle = colorOf(sr.color); ctx.lineWidth = 1.5; ctx.setLineDash(sr.dash ? [4, 4] : []);
      ctx.beginPath(); let on = false;
      for (let i = start; i < bars.length; i++) { const v = sr.values[i]; if (!isFinite(v)) { on = false; continue; } on ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); on = true; }
      ctx.stroke(); ctx.setLineDash([]);
    });
    // candles
    const bodyW = Math.max(1, Math.min(9, cw * 0.62));
    vis.forEach((b, k) => {
      const i = start + k, up = b[4] >= b[1], color = up ? '#DCE8F8' : '#6F8AB0', xx = Math.round(x(i)) + 0.5;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, y(b[2])); ctx.lineTo(xx, y(b[3])); ctx.stroke();
      const top = y(Math.max(b[1], b[4])), bh = Math.max(1, y(Math.min(b[1], b[4])) - top);
      if (up) { ctx.fillStyle = css('--panel'); ctx.fillRect(xx - bodyW / 2, top, bodyW, bh); ctx.strokeRect(xx - bodyW / 2, top, bodyW, bh); }
      else ctx.fillRect(xx - bodyW / 2, top, bodyW, bh);
    });
    // trade markers from the rules applied to these bars
    const tri = (xx, yy, upward, color) => { ctx.fillStyle = color; ctx.beginPath(); if (upward) { ctx.moveTo(xx, yy); ctx.lineTo(xx - 5, yy + 8); ctx.lineTo(xx + 5, yy + 8); } else { ctx.moveTo(xx, yy); ctx.lineTo(xx - 5, yy - 8); ctx.lineTo(xx + 5, yy - 8); } ctx.fill(); };
    let nIn = 0, nOut = 0;
    if (sim) {
      const all = sim.trades.concat(sim.open ? [{ entryIdx: sim.open.entryIdx, open: true }] : []);
      all.forEach(tr => {
        if (tr.entryIdx >= start) { tri(x(tr.entryIdx), y(bars[tr.entryIdx][3]) + 4, true, css('--orange')); nIn++; }
        if (!tr.open && tr.exitIdx >= start) { tri(x(tr.exitIdx), y(bars[tr.exitIdx][2]) - 4, false, tr.pnl > 0 ? css('--blue-soft') : css('--loss')); nOut++; }
      });
    }
    // last price tag
    const lastC = bars[bars.length - 1][4];
    ctx.fillStyle = css('--text'); ctx.fillRect(w - padR + 2, y(lastC) - 9, padR - 4, 18);
    ctx.fillStyle = css('--ground'); ctx.fillText(fmt.price(lastC), w - padR + 6, y(lastC) + 4);
    // lower panel (RSI)
    if (ov.panel) {
      const pt = priceB + gap, pb = h - padB, pv = v => pb - (v - ov.panel.min) / (ov.panel.max - ov.panel.min) * (pb - pt);
      ctx.strokeStyle = 'rgba(163,182,209,0.18)'; ctx.strokeRect(padL + 0.5, pt + 0.5, w - padL - padR - 1, pb - pt - 1);
      ov.panel.lines.forEach(v => { ctx.strokeStyle = css('--orange'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(padL, pv(v)); ctx.lineTo(w - padR, pv(v)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = css('--faint'); ctx.fillText(String(v), w - padR + 6, pv(v) + 4); });
      ctx.strokeStyle = css('--blue-soft'); ctx.lineWidth = 1.5; ctx.beginPath(); let on = false;
      for (let i = start; i < bars.length; i++) { const v = ov.panel.values[i]; if (!isFinite(v)) { on = false; continue; } on ? ctx.lineTo(x(i), pv(v)) : ctx.moveTo(x(i), pv(v)); on = true; }
      ctx.stroke(); ctx.fillStyle = css('--faint'); ctx.fillText(ov.panel.label, padL + 6, pt + 14);
    }
    const leg = [];
    (ov.series || []).forEach(sr => leg.push(`<span><i style="background:${colorOf(sr.color)}"></i>${esc(sr.label)}</span>`));
    (ov.levels || []).filter(l => l.label !== 'Mid').forEach(l => leg.push(`<span><i style="background:${colorOf(l.color)}"></i>${esc(l.label)}</span>`));
    if (st.id === 'rebound' && ov.zones) leg.push('<span><i class="blk" style="background:rgba(242,154,74,0.5)"></i>Entry zone</span><span><i class="blk" style="background:rgba(125,180,246,0.35)"></i>Exit zone</span>');
    if (nIn) leg.push('<span><b class="mk up">▲</b>Rule entry</span>');
    if (nOut) leg.push('<span><b class="mk dn">▼</b>Rule exit (blue win, red loss)</span>');
    const lg = $('#legend'); if (lg) lg.innerHTML = leg.join('');
  }

  function drawCurve(res, bars) {
    const canvas = $('#curve'); if (!canvas || !bars.length) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const t0 = res.from, t1 = res.to, size = res.positionSize;
    const first = bars.find(b => b[0] >= t0) || bars[0], base = first[1];
    const step = Math.max(1, Math.floor(bars.length / 400));
    const bh = [];
    for (let i = 0; i < bars.length; i += step) if (bars[i][0] >= t0) bh.push({ t: bars[i][0], v: size * (bars[i][4] / base - 1) });
    const pts = res.curve.concat([{ t: t1, v: res.net }]);
    const all = bh.map(p => p.v).concat(pts.map(p => p.v), [0]);
    const lo = Math.min(...all), hi = Math.max(...all), pad = 10, padR = 70;
    const y = v => pad + (hi - v) / ((hi - lo) || 1) * (h - pad * 2);
    const x = tt => ((tt - t0) / ((t1 - t0) || 1)) * (w - padR);
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
    ctx.strokeStyle = 'rgba(163,182,209,0.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = css('--faint'); ctx.fillText('$0', w - padR + 6, y(0) + 4);
    ctx.strokeStyle = 'rgba(163,182,209,0.55)'; ctx.lineWidth = 1.2; ctx.beginPath();
    bh.forEach((p, i) => i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))); ctx.stroke();
    ctx.strokeStyle = res.net >= 0 ? css('--blue-soft') : css('--loss'); ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { if (!i) ctx.moveTo(x(p.t), y(p.v)); else { ctx.lineTo(x(p.t), y(pts[i - 1].v)); ctx.lineTo(x(p.t), y(p.v)); } }); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(fmt.money(res.net), w - padR + 6, y(res.net) + 4);
    ctx.fillStyle = css('--muted'); const bl = bh.length ? bh[bh.length - 1].v : 0;
    if (Math.abs(y(bl) - y(res.net)) > 14) ctx.fillText(fmt.money(bl), w - padR + 6, y(bl) + 4);
  }

  // ---------- backtest ----------
  function btCtx(r, p, regime) {
    const st = strat();
    return { ...r.ctx, earnings: r.s.earnings || [], skipEarnings: !!p.skipEarnings, holdDays: st.holdDays(p), regime, marketFilter: !!p.marketFilter };
  }
  function verdict(res) {
    if (!res.count) return '';
    let v;
    if (res.net <= 0) v = 'These rules lost money on this stock over the test period.';
    else {
      v = res.profitFactor >= 1.5 ? 'Profitable with a healthy profit factor' : 'Profitable, but with a thin margin';
      v += res.net >= res.buyHold ? ', and ahead of simply holding the stock.' : `, though simply holding the stock made more (${fmt.money(res.buyHold)}).`;
    }
    if (res.count < 20) v += ' With fewer than 20 trades, treat this as anecdotal.';
    return v;
  }
  async function renderBacktest(r) {
    const s = r.s, st = strat(), t = tf(), p = params();
    $('#tab-body').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Testing ${esc(st.name)} rules</h3><div class="seg mini" role="group" aria-label="Timeframe">${tfButtons()}</div></div>
        <p class="flat muted">${RW.TF[t].label} bars, ${RW.TF[t].history} of history. ${fmt.usd(bt.size)} per trade, ${bt.costBps} bps costs per side.${p.marketFilter ? ' Market filter on.' : ''}${p.skipEarnings ? ' Skipping trades near earnings.' : ''}
        <button class="linkish" type="button" id="bt-edit">Change rules</button></p>
      </div>
      <div id="bt-result" class="card"><p class="note">Running on ${esc(s.ticker)} price history.</p></div>`;
    $('#bt-edit').addEventListener('click', openRules);
    let bars, regime;
    try { [bars, regime] = await Promise.all([loadBars(t, s.ticker), p.marketFilter ? fullRegime() : Promise.resolve(null)]); }
    catch (e) { $('#bt-result').innerHTML = `<p>${esc(e.message)} Run the data pipeline, then reload.</p>`; return; }
    if (selected !== s.ticker || tab !== 'backtest' || view !== 'stock') return;
    const res = RW.backtest(bars, st, p, btCtx(r, p, regime));
    const el = $('#bt-result');
    const span = res.from ? `${fmt.date(res.from)} to ${fmt.date(res.to)}` : 'no data';
    if (!res.count) {
      el.innerHTML = `<h3>No trades</h3><p class="flat">The rules found no trades in ${esc(s.ticker)}'s ${RW.TF[t].long} history (${span}). Try a different timeframe or loosen the rules.</p>`;
      return;
    }
    const be = res.avgWin > 0 ? Math.abs(res.avgLoss) / (res.avgWin + Math.abs(res.avgLoss)) * 100 : null;
    const tile = (label, tipKey, value, cls, sub) => `<div class="tile"><small>${label} ${info(tipKey, label)}</small><b class="${cls || ''}">${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    const mini = (label, tipKey, value, cls) => `<div class="stat"><small>${label}${tipKey ? ' ' + info(tipKey, label) : ''}</small><b class="${cls || ''}">${value}</b></div>`;
    el.innerHTML = `
      <p class="verdict">${esc(verdict(res))}</p>
      <div class="tiles">
        ${tile('Net result', 'm-net', fmt.money(res.net), res.net >= 0 ? 'pos' : 'neg', `Buy and hold ${fmt.money(res.buyHold)} ${info('m-bh', 'buy and hold')}`)}
        ${tile('Win rate', 'm-win', fmt.pct(res.winRate, 0), '', `${res.count} trades`)}
        ${tile('Profit factor', 'm-pf', fmt.pf(res.profitFactor), res.profitFactor >= 1 ? 'pos' : 'neg', 'Above 1 is profitable')}
        ${tile('Deepest drawdown', 'm-dd', fmt.money(res.maxDrawdown), 'neg', '')}
      </div>
      <div class="curve-wrap"><canvas id="curve" role="img" aria-label="Cumulative result of the rules compared with buy and hold"></canvas></div>
      <div class="chart-legend"><span><i style="background:var(--blue-soft)"></i>These rules</span><span><i style="background:rgba(163,182,209,0.55)"></i>Buy and hold</span><span>${span}</span></div>
      <details class="more"><summary>More statistics</summary>
        <div class="stats">
          ${mini('Average win', 'm-avgwin', fmt.money(res.avgWin), 'pos')}${mini('Average loss', 'm-avgwin', fmt.money(res.avgLoss), 'neg')}
          ${mini('Result per trade', 'm-exp', fmt.money(res.expectancy))}${mini('Break-even win rate', 'm-breakeven', be == null ? 'n/a' : fmt.pct(be, 0))}
          ${mini('Best trade', '', fmt.money(res.best), 'pos')}${mini('Worst trade', '', fmt.money(res.worst), 'neg')}
          ${mini('Average hold', 'm-hold', res.avgHoldDays < 1 ? Math.round(res.avgHoldDays * 24) + ' hours' : res.avgHoldDays.toFixed(1) + ' days')}${mini('Time in market', 'm-exposure', fmt.pct(res.exposure, 0))}
        </div>
      </details>
      <details class="more"><summary>Trade log (${res.count})</summary>
        <div class="table-scroll"><table class="trades">
          <thead><tr><th scope="col">Entered</th><th scope="col">Avg price</th>${st.id === 'rebound' ? '<th scope="col">Thirds</th>' : ''}<th scope="col">Exit</th><th scope="col">Why</th><th scope="col">Result</th></tr></thead>
          <tbody>${res.trades.slice().reverse().map(x => `<tr><td>${fmt.dateTime(x.entryTime)}</td><td>${fmt.price(x.avgFill)}</td>${st.id === 'rebound' ? `<td>${x.tranches}</td>` : ''}<td>${fmt.price(x.exitPrice)}</td><td>${x.reason}</td><td class="${x.pnl > 0 ? 'pos' : 'neg'}">${fmt.money(x.pnl)} <span class="faint">${fmt.signed(x.pct)}</span></td></tr>`).join('')}</tbody>
        </table></div>
      </details>
      ${res.open ? `<p class="note">A trade opened ${fmt.dateTime(res.open.entryTime)} is still open and not counted.</p>` : ''}
      <p class="note">Hypothetical: your rules applied to ${esc(s.ticker)}'s actual prices${data.meta.demo ? ' (demo prices here, so these results mean nothing)' : ''}. Signals use completed bars; fills assume the price was available. Value and analyst filters are not applied because they use today's figures. Past results do not predict future results.</p>`;
    drawCurve(res, bars);
  }

  // ---------- test on all stocks ----------
  let testRun = 0;
  async function renderTestAll() {
    const st = strat(), t = tf(), p = params();
    const only = !!ui.testOnlyPassing;
    const key = JSON.stringify([st.id, t, p, bt, only, filters]);
    const main = $('#main');
    main.innerHTML = `
      <div class="detail-head"><div><h2>All stocks<span>${esc(st.name)}, ${RW.TF[t].label.toLowerCase()} bars</span></h2></div></div>
      <div class="card">
        <p class="flat muted">Runs your current rules on every stock's full ${RW.TF[t].long} history and adds up the results. This is the honest way to judge a strategy: one stock can look great or terrible by luck.</p>
        <div class="row-controls">
          <label class="check"><input type="checkbox" id="only-pass" ${only ? 'checked' : ''}> Only stocks that pass today's filters</label>${info('hindsight', 'hindsight')}
          <div class="seg mini" role="group" aria-label="Timeframe">${tfButtons()}</div>
        </div>
      </div>
      <div class="card" id="test-result"><p class="note" id="test-progress">Loading price history…</p></div>`;
    $('#only-pass').addEventListener('change', e => { ui.testOnlyPassing = e.target.checked; saveUi(); renderTestAll(); });
    if (testCache[key]) { showTest(testCache[key]); return; }
    const run = ++testRun;
    const pool = results.filter(r => !only || !r.fails.length);
    const regime = p.marketFilter ? await fullRegime() : null;
    const out = [];
    let done = 0;
    const queue = pool.slice();
    async function worker() {
      while (queue.length) {
        const r = queue.shift();
        try {
          const bars = await loadBars(t, r.s.ticker);
          const res = RW.backtest(bars, st, p, btCtx(r, p, regime));
          out.push({ tk: r.s.ticker, name: r.s.name, res });
        } catch (e) { /* missing history: skip */ }
        done++;
        if (run !== testRun) return;
        const pr = $('#test-progress'); if (pr) pr.textContent = `Testing ${done} of ${pool.length} stocks…`;
        await new Promise(res => setTimeout(res, 0));
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (run !== testRun || view !== 'test') return;
    testCache[key] = out;
    showTest(out);
  }
  function showTest(out) {
    const el = $('#test-result'); if (!el) return;
    const traded = out.filter(o => o.res.count);
    if (!traded.length) { el.innerHTML = '<p class="flat">No trades on any stock with these rules. Try another timeframe or loosen the rules.</p>'; return; }
    const trades = traded.reduce((a, o) => a + o.res.count, 0);
    const wins = traded.reduce((a, o) => a + o.res.wins, 0);
    const gw = traded.reduce((a, o) => a + o.res.grossWin, 0), gl = traded.reduce((a, o) => a + o.res.grossLoss, 0);
    const avgPct = traded.reduce((a, o) => a + o.res.avgPct * o.res.count, 0) / trades;
    const ahead = traded.filter(o => o.res.net > 0).length, beat = traded.filter(o => o.res.net > o.res.buyHold).length;
    const pf = gl > 0 ? gw / gl : Infinity;
    const net = gw - gl;
    const v = pf >= 1.3 && ahead / traded.length >= 0.6 ? 'The rules made money broadly across the universe.'
      : pf >= 1 ? 'Slightly profitable overall, but results vary a lot from stock to stock.' : 'The rules lost money overall across the universe.';
    const sortKey = ui.testSort || 'net';
    const sorted = traded.slice().sort((a, b) => sortKey === 'tk' ? a.tk.localeCompare(b.tk) : sortKey === 'vs' ? (b.res.net - b.res.buyHold) - (a.res.net - a.res.buyHold) : b.res[sortKey] - a.res[sortKey]);
    const tile = (label, tipKey, value, cls, sub) => `<div class="tile"><small>${label}${tipKey ? ' ' + info(tipKey, label) : ''}</small><b class="${cls || ''}">${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    el.innerHTML = `
      <p class="verdict">${v} ${beat < traded.length / 2 ? 'Most stocks did better with buy and hold, which is common for rules that are only invested part of the time.' : ''}</p>
      <div class="tiles">
        ${tile('Stocks ahead', '', `${ahead} of ${traded.length}`, ahead / traded.length >= 0.5 ? 'pos' : 'neg', `${beat} beat buy and hold`)}
        ${tile('Profit factor', 'm-pf', fmt.pf(pf), pf >= 1 ? 'pos' : 'neg', `All ${trades.toLocaleString()} trades pooled`)}
        ${tile('Win rate', 'm-win', fmt.pct(wins / trades * 100, 0), '', '')}
        ${tile('Average trade', 'm-exp', fmt.signed(avgPct, 2), avgPct >= 0 ? 'pos' : 'neg', `Net ${fmt.money(net)}`)}
      </div>
      <div class="table-scroll tall"><table class="trades sortable">
        <thead><tr>
          <th scope="col"><button type="button" data-sort="tk">Stock</button></th><th scope="col"><button type="button" data-sort="count">Trades</button></th>
          <th scope="col"><button type="button" data-sort="winRate">Win rate</button></th><th scope="col"><button type="button" data-sort="profitFactor">Profit factor</button></th>
          <th scope="col"><button type="button" data-sort="net">Net</button></th><th scope="col"><button type="button" data-sort="vs">Vs buy and hold</button></th></tr></thead>
        <tbody>${sorted.map(o => `<tr data-open="${esc(o.tk)}" tabindex="0"><td><b>${esc(o.tk)}</b></td><td>${o.res.count}</td><td>${fmt.pct(o.res.winRate, 0)}</td><td>${fmt.pf(o.res.profitFactor)}</td>
          <td class="${o.res.net >= 0 ? 'pos' : 'neg'}">${fmt.money(o.res.net)}</td><td class="${o.res.net >= o.res.buyHold ? 'pos' : 'neg'}">${fmt.money(o.res.net - o.res.buyHold)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="note">${out.length - traded.length ? `${out.length - traded.length} stocks had no trades. ` : ''}Each trade uses ${fmt.usd(bt.size)}; figures are hypothetical. Click a stock to open its backtest.</p>`;
    $$('[data-sort]', el).forEach(b => { if (b.dataset.sort === sortKey) b.setAttribute('aria-sort', 'descending'); b.addEventListener('click', () => { ui.testSort = b.dataset.sort; saveUi(); showTest(out); }); });
    $$('[data-open]', el).forEach(tr => {
      const go = () => { tab = 'backtest'; select(tr.dataset.open); };
      tr.addEventListener('click', go); tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }

  // ---------- freshness ----------
  let loadedAt = null;
  function freshnessTip() {
    if (!data) return { title: 'Data', body: '<p>Loading.</p>' };
    const m = data.meta;
    return {
      title: 'Data freshness',
      body: `<p>Prices as of <b>${m.pricesAsOf ? fmt.clock(new Date(m.pricesAsOf * 1000)) : 'n/a'}</b> (latest bar).</p>
        <p>Company data and analyst targets updated <b>${m.fundamentalsUpdated ? fmt.clock(new Date(m.fundamentalsUpdated)) : esc(m.fundamentalsDate || 'n/a')}</b>.</p>
        <p>Loaded in your browser at ${loadedAt ? fmt.clock(loadedAt) : 'n/a'}; the page checks for new data every 10 minutes.</p>
        <p>${esc(m.schedule || '')}</p><p class="faint">Source: ${esc(m.source)}</p>`,
    };
  }
  function renderFreshness() {
    const m = data.meta, gen = new Date(m.generated);
    const stale = Date.now() - gen.getTime() > 4 * 86400 * 1000;
    $('#freshness').innerHTML = `<span class="${stale ? 'stale' : ''}">Updated ${esc(fmt.clock(gen))}</span>${info('fresh', 'data freshness')}`;
    $('#schedule-note').textContent = m.schedule || '';
    $('#demo-banner').hidden = !m.demo;
  }

  // ---------- url ----------
  function writeHash() {
    const parts = [strat().id, tf()];
    if (view === 'test') parts.push('all'); else if (selected) parts.push(selected);
    history.replaceState(null, '', '#' + parts.join('/'));
  }
  function readHash() {
    const [sid, t, tk] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (sid && RWS.byId[sid]) { ui.strategy = sid; if (t && RWS.byId[sid].timeframes.includes(t)) ui.tf[sid] = t; }
    if (tk === 'all') view = 'test'; else if (tk) selected = tk.toUpperCase();
  }

  // ---------- boot ----------
  async function refresh(first) {
    let fresh;
    try { fresh = await loadScreen(); }
    catch (e) {
      $('#freshness').textContent = 'Data unavailable';
      $('#watchlist').innerHTML = `<p class="empty">${esc(e.message)} Run the data pipeline to create it.</p>`;
      return;
    }
    const changed = !data || fresh.meta.generated !== data.meta.generated;
    data = fresh; loadedAt = new Date();
    if (changed && !first) for (const k of Object.keys(recent)) delete recent[k];
    if (changed) for (const k of Object.keys(barsCache)) delete barsCache[k];
    if (changed) for (const k of Object.keys(testCache)) delete testCache[k];
    renderFreshness(); renderMarketChip();
    try { await Promise.all([loadRecent(tf()), loadRecent('1d')]); }
    catch (e) { $('#watchlist').innerHTML = `<p class="empty">${esc(e.message)} Run the data pipeline to create it.</p>`; return; }
    evaluateAll();
    renderWatchlist();
    if (first) {
      if (view === 'test') renderTestAll();
      else if (selected && results.some(r => r.s.ticker === selected)) renderDetail();
      else {
        const firstBtn = $('#watchlist button.stock');
        if (firstBtn && window.matchMedia('(min-width: 901px)').matches) select(firstBtn.dataset.tk);
      }
      if (!seen[strat().id]) { seen[strat().id] = true; store.set('seen', seen); openExplainer(); }
    } else if (changed && view === 'stock' && selected && tab === 'overview') renderDetail();
    checkAlerts();
  }

  readHash();
  renderHeader();
  refresh(true);
  if (!INLINE) setInterval(() => refresh(false), 10 * 60 * 1000);
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === 'stock' && selected && tab === 'overview') renderDetail(); }, 150); });
})();
