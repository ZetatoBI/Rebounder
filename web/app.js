/* Rebounder app. Vanilla JS, no build step. */
(function () {
  'use strict';
  const RW = window.RW;
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- settings ----------
  const DEFAULT_CRITERIA = {
    minCapB: 20, minDollarVolM: 250,
    peDiscount: 10, minOffHigh: 20,
    minUpside: 15, requireRising: false,
    windowSessions: 3, minWidthPct: 2, maxWidthPct: 6, minTouches: 2, zonePct: 15,
  };
  const DEFAULT_BT = {
    timeframe: '1h', entry: 'ladder', stopPct: 3, exitAt: 'mid', exitZonePct: 20,
    timeStopSessions: 5, skipEarnings: true, costBps: 5, positionSize: 10000,
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rw:' + k); return v ? { ...d, ...JSON.parse(v) } : { ...d }; } catch (e) { return { ...d }; } },
    getArr(k) { try { return JSON.parse(localStorage.getItem('rw:' + k) || '[]'); } catch (e) { return []; } },
    set(k, v) { try { localStorage.setItem('rw:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  let criteria = store.get('criteria', DEFAULT_CRITERIA);
  let btSettings = store.get('bt', DEFAULT_BT);
  let alerts = store.getArr('alerts');

  let data = null;
  let selected = null;
  let tab = 'overview';
  const barsCache = {};

  // ---------- formatting ----------
  const fmt = {
    price: v => v == null ? 'n/a' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    x: v => v == null ? 'n/a' : v.toFixed(1) + '×',
    pct: (v, d = 1) => v == null ? 'n/a' : v.toFixed(d) + '%',
    signedPct: v => v == null ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%',
    money: v => (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString(),
    big: v => v == null ? 'n/a' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : '$' + (v / 1e9).toFixed(0) + 'B',
    date: t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }),
    dateTime: t => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  };

  // ---------- screening ----------
  function upside(s) {
    const t = s.target && (s.target.weighted || s.target.mean);
    return t && s.price ? (t / s.price - 1) * 100 : null;
  }
  function channelRules() {
    return { windowSessions: criteria.windowSessions, minWidthPct: criteria.minWidthPct, maxWidthPct: criteria.maxWidthPct, minTouches: criteria.minTouches };
  }
  function evaluate(s) {
    const fails = [];
    if (!(s.marketCap >= criteria.minCapB * 1e9)) fails.push('market cap');
    if (!(s.avgDollarVolume >= criteria.minDollarVolM * 1e6)) fails.push('trading volume');
    const peerPE = s.peers && s.peers.fwdPE;
    if (!(s.fwdPE > 0 && peerPE && s.fwdPE <= peerPE * (1 - criteria.peDiscount / 100))) fails.push('valuation vs peers');
    if (!(s.offHighPct >= criteria.minOffHigh)) fails.push('distance from 52-week high');
    const up = upside(s);
    if (!(up >= criteria.minUpside)) fails.push('analyst upside');
    if (criteria.requireRising && !(s.target && s.target.trend90 === 'rising')) fails.push('target revisions');
    const ch = RW.currentChannel(s.recent, channelRules(), '15m');
    return { s, fails, up, ch, inChannel: !!(ch && ch.valid), inZone: !!(ch && ch.valid && ch.position <= criteria.zonePct) };
  }

  // ---------- watchlist ----------
  function renderWatchlist() {
    const el = $('#watchlist');
    if (!data) { el.innerHTML = ''; return; }
    const results = data.stocks.map(evaluate);
    const passing = results.filter(r => r.fails.length === 0);
    const zone = passing.filter(r => r.inZone).sort((a, b) => a.ch.position - b.ch.position);
    const channel = passing.filter(r => r.inChannel && !r.inZone).sort((a, b) => a.ch.position - b.ch.position);
    const noRange = passing.filter(r => !r.inChannel);

    const row = r => {
      const pos = r.inChannel ? Math.max(0, Math.min(100, r.ch.position)) : null;
      return `<li><button class="stock ${r.inZone ? 'zone' : ''}" data-tk="${esc(r.s.ticker)}" aria-current="${selected === r.s.ticker}">
        <span class="tk">${esc(r.s.ticker)}<span class="nm">${esc(r.s.name)}</span></span>
        <span class="px">${fmt.price(r.s.price)}</span>
        ${pos == null ? '' : `<span class="meter" aria-hidden="true"><span class="zonefill" style="width:${criteria.zonePct}%"></span><span class="dot" style="left:${pos}%"></span></span>`}
        <span class="meta"><span>${r.inChannel ? `${Math.round(r.ch.position)}% up, width ${fmt.pct(r.ch.widthPct)}` : 'No clean channel right now'}</span><span>Upside ${fmt.signedPct(r.up)}</span></span>
      </button></li>`;
    };

    let html = '';
    html += `<div class="group-title"><span>In the lower zone</span><span>${zone.length}</span></div>`;
    html += zone.length ? `<ul class="stock-list">${zone.map(row).join('')}</ul>` : `<p class="empty">No matches are near a channel floor right now. Prices refresh hourly.</p>`;
    html += `<div class="group-title"><span>Inside a channel</span><span>${channel.length}</span></div>`;
    html += channel.length ? `<ul class="stock-list">${channel.map(row).join('')}</ul>` : `<p class="empty">None of your matches are trading in a clean range.</p>`;
    html += `<div class="group-title"><span>Match your criteria, no clean channel</span><span>${noRange.length}</span></div>`;
    html += noRange.length ? `<ul class="stock-list">${noRange.map(row).join('')}</ul>` : '';
    html += `<p class="muted-list">${passing.length} of ${results.length} stocks pass your criteria.</p>`;
    el.innerHTML = html;
    el.querySelectorAll('button.stock').forEach(b => b.addEventListener('click', () => select(b.dataset.tk)));
  }

  // ---------- criteria form ----------
  const CRITERIA_FIELDS = [
    ['Size and liquidity', [
      ['minCapB', 'Minimum market cap ($B)', 'number', 1],
      ['minDollarVolM', 'Minimum daily dollar volume ($M)', 'number', 10],
    ]],
    ['Value', [
      ['peDiscount', 'Forward P/E below peer median by (%)', 'number', 1],
      ['minOffHigh', 'At least this far below 52-week high (%)', 'number', 1],
    ]],
    ['Analysts', [
      ['minUpside', 'Recency-weighted target upside at least (%)', 'number', 1],
      ['requireRising', 'Only if targets were raised more than cut in 90 days', 'checkbox'],
    ]],
    ['Channel, 15-minute bars', [
      ['windowSessions', 'Look-back (sessions)', 'number', 1],
      ['minWidthPct', 'Minimum width (%)', 'number', 0.1],
      ['maxWidthPct', 'Maximum width (%)', 'number', 0.1],
      ['minTouches', 'Touches of each side, at least', 'number', 1],
      ['zonePct', 'Lower zone, bottom part of channel (%)', 'number', 1],
    ]],
  ];
  function renderCriteria() {
    $('#criteria-body').innerHTML = CRITERIA_FIELDS.map(([title, fields]) => `
      <div class="gate"><h3>${title}</h3>${fields.map(([k, label, type, step]) => `
        <label class="field"><span>${label}</span>${type === 'checkbox'
          ? `<input type="checkbox" data-k="${k}" ${criteria[k] ? 'checked' : ''}>`
          : `<input type="number" inputmode="decimal" step="${step}" data-k="${k}" value="${criteria[k]}">`}</label>`).join('')}
      </div>`).join('') + `<div class="gate"><button class="btn ghost" id="reset-criteria" type="button">Reset to defaults</button></div>`;
    $('#criteria-body').querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      criteria[k] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
      store.set('criteria', criteria);
      renderWatchlist();
      if (selected) renderDetail();
    }));
    $('#reset-criteria').addEventListener('click', () => {
      criteria = { ...DEFAULT_CRITERIA }; store.set('criteria', criteria);
      renderCriteria(); renderWatchlist(); if (selected) renderDetail();
    });
  }

  // ---------- detail ----------
  async function loadBars(tk) {
    if (barsCache[tk]) return barsCache[tk];
    if (window.__RW_INLINE__ && window.__RW_INLINE__.bars[tk]) return (barsCache[tk] = window.__RW_INLINE__.bars[tk]);
    const r = await fetch(`data/bars/${encodeURIComponent(tk)}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Price history for ${tk} is missing (HTTP ${r.status}).`);
    return (barsCache[tk] = await r.json());
  }

  function select(tk) {
    selected = tk;
    renderWatchlist();
    renderDetail();
    if (window.matchMedia('(max-width: 900px)').matches) $('#main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function relClass(stockV, peerV, lowerIsCheaper) {
    if (stockV == null || peerV == null) return '';
    const cheaper = lowerIsCheaper ? stockV < peerV : stockV > peerV;
    return cheaper ? 'rel-good' : 'rel-bad';
  }
  function relText(stockV, peerV) {
    if (stockV == null || !peerV) return 'n/a';
    const d = (stockV / peerV - 1) * 100;
    return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(0) + '%';
  }

  function renderDetail() {
    const s = data.stocks.find(x => x.ticker === selected);
    if (!s) return;
    const r = evaluate(s);
    const p = s.peers || {};
    const t = s.target || {};
    const main = $('#main');
    const posText = r.inChannel ? `${Math.round(r.ch.position)}% up the channel` : 'No clean channel right now';
    main.innerHTML = `
      <div class="detail-head">
        <h2>${esc(s.ticker)}<span>${esc(s.name)}</span></h2>
        <div class="price">${fmt.price(s.price)}<small>${posText}</small></div>
      </div>
      ${r.fails.length ? `<p class="empty">Outside your criteria on: ${esc(r.fails.join(', '))}.</p>` : ''}
      <div class="tabs" role="tablist">
        <button role="tab" id="tab-overview" aria-selected="${tab === 'overview'}">Overview</button>
        <button role="tab" id="tab-backtest" aria-selected="${tab === 'backtest'}">Backtest</button>
      </div>
      <div id="tab-body"></div>`;
    $('#tab-overview').addEventListener('click', () => { tab = 'overview'; renderDetail(); });
    $('#tab-backtest').addEventListener('click', () => { tab = 'backtest'; renderDetail(); });
    if (tab === 'overview') renderOverview(s, r, p, t); else renderBacktest(s);
  }

  function renderOverview(s, r, p, t) {
    const ch = r.ch;
    const rows = [
      ['Forward P/E', s.fwdPE, p.fwdPE, fmt.x, true],
      ['EV / EBITDA', s.evEbitda, p.evEbitda, fmt.x, true],
      ['Price / sales', s.ps, p.ps, fmt.x, true],
      ['Free cash flow yield', s.fcfYield, p.fcfYield, v => fmt.pct(v), false],
      ['Dividend yield', s.divYield, p.divYield, v => fmt.pct(v, 2), false],
    ];
    const tAlerts = alerts.filter(a => a.ticker === s.ticker);
    $('#tab-body').innerHTML = `
      <div class="card chart-card">
        <div class="channel-facts">
          ${ch ? `<span>Floor <b>${fmt.price(ch.floor)}</b></span><span>Midline <b>${fmt.price(ch.mid)}</b></span><span>Ceiling <b>${fmt.price(ch.ceiling)}</b></span>
          <span>Width <b>${fmt.pct(ch.widthPct)}</b></span><span>Touches <b>${ch.floorTouches} floor, ${ch.ceilTouches} ceiling</b></span>
          <span>${ch.valid ? 'Meets your channel rules' : 'Does not meet your channel rules'}</span>` : '<span>Not enough recent bars to measure a channel.</span>'}
        </div>
        <div class="chart-wrap"><canvas id="candles" role="img" aria-label="15-minute candles for the last ${criteria.windowSessions + 2} sessions with the measured channel"></canvas></div>
        <div class="chart-legend">
          <span><i style="background:var(--blue-soft)"></i>Ceiling and midline</span>
          <span><i style="background:var(--orange)"></i>Floor and your lower zone</span>
          ${tAlerts.length ? '<span><i style="background:#E8D27A"></i>Your alert levels</span>' : ''}
          <span>15-minute candles, measured over the last ${criteria.windowSessions} sessions</span>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>Valuation against ${esc(p.level || 'peer')} peers</h3>
          <table class="ratios">
            <thead><tr><th scope="col">Ratio</th><th scope="col">${esc(s.ticker)}</th><th scope="col">Peer median</th><th scope="col">Difference</th></tr></thead>
            <tbody>${rows.map(([label, v, pv, f, lowCheap]) => `
              <tr><td>${label}</td><td>${f(v)}</td><td>${f(pv)}</td><td class="${relClass(v, pv, lowCheap)}">${relText(v, pv)}</td></tr>`).join('')}
            </tbody>
          </table>
          <p class="note">Peers: ${esc(p.name || 'n/a')}, median of ${p.n || 0} stocks in this app's universe. Blue means cheaper than peers on that measure. Fundamentals as of ${esc(data.meta.fundamentalsDate || 'n/a')}.</p>
        </div>

        <div class="card">
          <h3>Analysts and events</h3>
          <dl class="kv">
            <dt>Consensus target</dt><dd>${fmt.price(t.mean)}</dd>
            <dt>Recency-weighted target</dt><dd>${fmt.price(t.weighted)}</dd>
            <dt>Upside to weighted target</dt><dd>${fmt.signedPct(r.up)}</dd>
            <dt>Target changes, last 90 days</dt><dd>${t.raised90 == null ? 'n/a' : `${t.raised90} raised, ${t.lowered90} cut`}</dd>
            <dt>Analysts covering</dt><dd>${t.n ?? 'n/a'}</dd>
            <dt>Below 52-week high</dt><dd>${fmt.pct(s.offHighPct)}</dd>
            <dt>Market cap</dt><dd>${fmt.big(s.marketCap)}</dd>
            <dt>Next earnings</dt><dd>${s.nextEarnings ? fmt.date(s.nextEarnings) : 'n/a'}</dd>
          </dl>
          <p class="note">Recent targets count more: each firm's latest target, weighted by age with a 45-day half-life.</p>
        </div>
      </div>

      ${s.ai ? `<div class="card" style="margin-top:14px"><h3>AI summary</h3><p style="margin:0">${esc(s.ai)}</p><p class="note">Generated ${esc(s.aiDate || '')} from the figures above. Descriptive only.</p></div>` : ''}

      <div class="card" style="margin-top:14px">
        <h3>Price alerts</h3>
        <form class="alert-form" id="alert-form">
          <label for="al-pct">Notify me within</label>
          <input id="al-pct" type="number" min="0" max="100" step="1" value="10">
          <label for="al-side" class="visually-hidden">Channel boundary</label>
          <select id="al-side"><option value="floor">% above the floor</option><option value="ceiling">% below the ceiling</option></select>
          <button class="btn" type="submit">Add alert</button>
        </form>
        <ul class="alerts" id="alert-list">${tAlerts.map(a => alertRow(a, ch)).join('')}</ul>
        <p class="note">The % is measured across the channel's height, and levels move as the channel updates. Alerts are checked each time prices refresh while this page is open. Email alerts are planned.</p>
      </div>`;

    $('#alert-form').addEventListener('submit', e => {
      e.preventDefault();
      const pct = Math.max(0, Math.min(100, Number($('#al-pct').value)));
      alerts.push({ id: Date.now(), ticker: s.ticker, side: $('#al-side').value, pct });
      store.set('alerts', alerts);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      renderDetail();
    });
    $('#alert-list').querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => {
      alerts = alerts.filter(a => String(a.id) !== b.dataset.del); store.set('alerts', alerts); renderDetail();
    }));

    drawCandles(s, ch, tAlerts);
  }

  function alertLevel(a, ch) {
    if (!ch) return null;
    const h = ch.ceiling - ch.floor;
    return a.side === 'floor' ? ch.floor + h * a.pct / 100 : ch.ceiling - h * a.pct / 100;
  }
  function alertHit(a, ch) {
    if (!ch) return false;
    const lvl = alertLevel(a, ch);
    return a.side === 'floor' ? ch.price <= lvl : ch.price >= lvl;
  }
  function alertRow(a, ch) {
    const lvl = alertLevel(a, ch);
    const hit = alertHit(a, ch);
    return `<li class="${hit ? 'hit' : ''}"><span>Within ${a.pct}% ${a.side === 'floor' ? 'above the floor' : 'below the ceiling'}${lvl ? `, now ${fmt.price(lvl)}` : ''}${hit ? '. Reached' : ''}</span>
      <button type="button" data-del="${a.id}" aria-label="Remove alert">✕</button></li>`;
  }
  function checkAlerts() {
    if (!data) return;
    const fired = store.getArr('fired');
    for (const a of alerts) {
      const s = data.stocks.find(x => x.ticker === a.ticker);
      if (!s) continue;
      const ch = RW.currentChannel(s.recent, channelRules(), '15m');
      const key = `${a.id}:${data.meta.generated}`;
      if (alertHit(a, ch) && !fired.includes(key)) {
        fired.push(key);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`${a.ticker} reached your alert`, { body: `Price ${fmt.price(ch.price)}, within ${a.pct}% ${a.side === 'floor' ? 'above the channel floor' : 'below the channel ceiling'}.` });
        }
      }
    }
    store.set('fired', fired.slice(-200));
  }

  // ---------- candle chart ----------
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawCandles(s, ch, tAlerts) {
    const canvas = $('#candles');
    if (!canvas) return;
    const per = RW.barsPerSession('15m');
    const bars = (s.recent || []).slice(-(criteria.windowSessions + 2) * per);
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!bars.length) return;
    const padL = 8, padR = 62, padT = 12, padB = 26;
    let lo = Math.min(...bars.map(b => b[3])), hi = Math.max(...bars.map(b => b[2]));
    if (ch) { lo = Math.min(lo, ch.floor); hi = Math.max(hi, ch.ceiling); }
    const levels = (tAlerts || []).map(a => alertLevel(a, ch)).filter(Boolean);
    levels.forEach(l => { lo = Math.min(lo, l); hi = Math.max(hi, l); });
    const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
    const y = v => padT + (hi - v) / (hi - lo) * (h - padT - padB);
    const cw = (w - padL - padR) / bars.length;
    const x = i => padL + i * cw + cw / 2;

    // grid and price labels
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillStyle = css('--faint'); ctx.strokeStyle = 'rgba(163,182,209,0.08)'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(fmt.price(v), w - padR + 6, yy + 4);
    }
    // session separators and date labels
    let lastDay = null;
    bars.forEach((b, i) => {
      const d = new Date(b[0] * 1000).toDateString();
      if (d !== lastDay) {
        if (lastDay !== null) { ctx.strokeStyle = 'rgba(163,182,209,0.14)'; ctx.beginPath(); ctx.moveTo(padL + i * cw, padT); ctx.lineTo(padL + i * cw, h - padB); ctx.stroke(); }
        ctx.fillStyle = css('--faint');
        ctx.fillText(new Date(b[0] * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), padL + i * cw + 4, h - 8);
        lastDay = d;
      }
    });

    if (ch) {
      const winStart = bars.length - criteria.windowSessions * per;
      const x0 = padL + Math.max(0, winStart) * cw, x1 = w - padR;
      const zoneTop = ch.floor + (ch.ceiling - ch.floor) * criteria.zonePct / 100;
      ctx.fillStyle = 'rgba(242,154,74,0.24)';
      ctx.fillRect(x0, y(zoneTop), x1 - x0, y(ch.floor) - y(zoneTop));
      const line = (v, color, dash) => { ctx.strokeStyle = color; ctx.setLineDash(dash || []); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x0, y(v)); ctx.lineTo(x1, y(v)); ctx.stroke(); ctx.setLineDash([]); };
      line(ch.ceiling, css('--blue-soft'));
      line(ch.mid, 'rgba(125,180,246,0.6)', [4, 4]);
      line(ch.floor, css('--orange'));
    }
    levels.forEach(l => {
      ctx.strokeStyle = '#E8D27A'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y(l)); ctx.lineTo(w - padR, y(l)); ctx.stroke(); ctx.setLineDash([]);
    });

    // candles: rising hollow and light, falling filled and darker
    const bodyW = Math.max(1, Math.min(9, cw * 0.62));
    bars.forEach((b, i) => {
      const up = b[4] >= b[1];
      const color = up ? '#DCE8F8' : '#6F8AB0';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      const xx = Math.round(x(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, y(b[2])); ctx.lineTo(xx, y(b[3])); ctx.stroke();
      const top = y(Math.max(b[1], b[4])), bot = y(Math.min(b[1], b[4]));
      const bh = Math.max(1, bot - top);
      if (up) { ctx.fillStyle = css('--panel'); ctx.fillRect(xx - bodyW / 2, top, bodyW, bh); ctx.strokeRect(xx - bodyW / 2, top, bodyW, bh); }
      else ctx.fillRect(xx - bodyW / 2, top, bodyW, bh);
    });
    // last price tag
    const last = bars[bars.length - 1][4];
    ctx.fillStyle = css('--text');
    ctx.fillRect(w - padR + 2, y(last) - 9, padR - 4, 18);
    ctx.fillStyle = css('--ground');
    ctx.fillText(fmt.price(last), w - padR + 6, y(last) + 4);
  }

  // ---------- backtest ----------
  function seg(key, options) {
    return `<span class="seg" role="group">${options.map(([v, label]) =>
      `<button type="button" data-seg="${key}" data-v="${v}" aria-pressed="${String(btSettings[key]) === String(v)}">${label}</button>`).join('')}</span>`;
  }
  async function renderBacktest(s) {
    const body = $('#tab-body');
    body.innerHTML = `
      <div class="card">
        <h3>Your rules</h3>
        <div class="bt-controls">
          <div class="field"><span>History</span>${seg('timeframe', [['1h', 'Hourly, 2 yrs'], ['15m', '15 min, 60 days']])}</div>
          <div class="field"><span>Entry</span>${seg('entry', [['single', 'All at once'], ['ladder', '3 tranches']])}</div>
          <div class="field"><span>Exit</span>${seg('exitAt', [['mid', 'Midline'], ['ceilingZone', 'Near ceiling']])}</div>
          ${btSettings.exitAt === 'ceilingZone' ? `<label class="field"><span>Exit within % below ceiling</span><input type="number" data-bt="exitZonePct" value="${btSettings.exitZonePct}" step="1"></label>` : ''}
          <label class="field"><span>Stop below floor (%)</span><input type="number" data-bt="stopPct" value="${btSettings.stopPct}" step="0.5"></label>
          <label class="field"><span>Time exit (sessions)</span><input type="number" data-bt="timeStopSessions" value="${btSettings.timeStopSessions}" step="1"></label>
          <label class="field"><span>Costs per side (bps)</span><input type="number" data-bt="costBps" value="${btSettings.costBps}" step="1"></label>
          <label class="field"><span>Skip trades near earnings</span><input type="checkbox" data-bt="skipEarnings" ${btSettings.skipEarnings ? 'checked' : ''}></label>
        </div>
        <p class="note">Channel and lower-zone settings come from your criteria. Each trade is sized at $${btSettings.positionSize.toLocaleString()}; with 3 tranches each third fills only if price reaches it.</p>
      </div>
      <div id="bt-result" class="card" style="margin-top:14px"><p class="note">Running on ${esc(s.ticker)} price history.</p></div>`;
    body.querySelectorAll('button[data-seg]').forEach(b => b.addEventListener('click', () => {
      btSettings[b.dataset.seg] = b.dataset.v; store.set('bt', btSettings); renderBacktest(s);
    }));
    body.querySelectorAll('input[data-bt]').forEach(inp => inp.addEventListener('change', () => {
      btSettings[inp.dataset.bt] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
      store.set('bt', btSettings); renderBacktest(s);
    }));

    let bars;
    try { bars = await loadBars(s.ticker); }
    catch (e) { $('#bt-result').innerHTML = `<p>${esc(e.message)} Run the data pipeline, then reload.</p>`; return; }
    if (selected !== s.ticker || tab !== 'backtest') return;
    const series = btSettings.timeframe === '15m' ? bars.m15 : bars.h1;
    const rules = { ...channelRules(), zonePct: criteria.zonePct, ...btSettings };
    const res = RW.backtest(series || [], rules, btSettings.timeframe, bars.earnings);
    renderBtResult(s, res, series);
  }

  function renderBtResult(s, res, series) {
    const el = $('#bt-result');
    const span = series && series.length ? `${fmt.date(series[0][0])} to ${fmt.date(series[series.length - 1][0])}` : 'no data';
    if (!res.count) {
      el.innerHTML = `<h3>No trades</h3><p style="margin:0">Your rules found no channel entries in ${esc(s.ticker)}'s history (${span}). Try a wider channel range, fewer touches or a larger lower zone in your criteria.</p>`;
      return;
    }
    el.innerHTML = `
      <div class="bt-summary">
        <div><small style="color:var(--muted)">Net result, ${res.count} trades, ${span}</small><div class="bt-net ${res.net >= 0 ? 'pos' : 'neg'}">${fmt.money(res.net)}</div></div>
      </div>
      <div class="curve-wrap"><canvas id="curve" role="img" aria-label="Cumulative result after each trade"></canvas></div>
      <div class="stats">
        <div class="stat"><small>Win rate</small><b>${fmt.pct(res.winRate, 0)}</b></div>
        <div class="stat"><small>Average win</small><b class="pos">${fmt.money(res.avgWin)}</b></div>
        <div class="stat"><small>Average loss</small><b class="neg">${fmt.money(res.avgLoss)}</b></div>
        <div class="stat"><small>Result per trade</small><b>${fmt.money(res.expectancy)}</b></div>
        <div class="stat"><small>Worst trade</small><b class="neg">${fmt.money(res.worst)}</b></div>
        <div class="stat"><small>Deepest drawdown</small><b class="neg">${fmt.money(res.maxDrawdown)}</b></div>
        <div class="stat"><small>One average loss erases</small><b>${res.lossToWin == null ? 'n/a' : res.lossToWin.toFixed(1) + ' wins'}</b></div>
        <div class="stat"><small>Break-even win rate</small><b>${res.lossToWin == null ? 'n/a' : fmt.pct(res.lossToWin / (1 + res.lossToWin) * 100, 0)}</b></div>
      </div>
      <div class="table-scroll">
        <table class="trades">
          <thead><tr><th scope="col">Entered</th><th scope="col">Avg fill</th><th scope="col">Tranches</th><th scope="col">Exit</th><th scope="col">Reason</th><th scope="col">Result</th></tr></thead>
          <tbody>${res.trades.slice().reverse().map(t => `<tr>
            <td>${fmt.dateTime(t.entryTime)}</td><td>${fmt.price(t.avgFill)}</td><td>${t.tranches}</td><td>${fmt.price(t.exitPrice)}</td><td>${t.reason}</td>
            <td class="${t.pnl > 0 ? 'pos' : 'neg'}">${fmt.money(t.pnl)} (${fmt.signedPct(t.pct)})</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="note">Hypothetical: your rules applied to ${esc(s.ticker)}'s actual historical prices${data.meta.demo ? ' (demo prices here, so these results mean nothing)' : ''}. Fills assume the price you set was available; a stop and a target in the same bar count as a stop. Valuation and analyst filters use today's values, so the test covers the channel rules only. Past results do not predict future results.</p>`;
    drawCurve(res.curve);
  }

  function drawCurve(curve) {
    const canvas = $('#curve');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const lo = Math.min(0, ...curve), hi = Math.max(0, ...curve);
    const pad = 8;
    const y = v => pad + (hi - v) / ((hi - lo) || 1) * (h - pad * 2);
    const x = i => (i / Math.max(1, curve.length - 1)) * (w - 2);
    ctx.strokeStyle = 'rgba(163,182,209,0.35)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = curve[curve.length - 1] >= 0 ? css('--blue-soft') : css('--loss');
    ctx.lineWidth = 2; ctx.beginPath();
    curve.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  }

  // ---------- boot ----------
  async function loadData() {
    if (window.__RW_INLINE__) return window.__RW_INLINE__.screen;
    const r = await fetch('data/screen.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`screen.json could not be loaded (HTTP ${r.status}).`);
    return r.json();
  }

  async function refresh(first) {
    try {
      data = await loadData();
    } catch (e) {
      $('#freshness').textContent = 'Data unavailable';
      $('#watchlist').innerHTML = `<p class="empty">${esc(e.message)} Run the data pipeline to create it.</p>`;
      return;
    }
    $('#demo-banner').hidden = !data.meta.demo;
    const gen = new Date(data.meta.generated);
    $('#freshness').innerHTML = `Prices updated ${esc(gen.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}<br>${esc(data.meta.source)}`;
    renderWatchlist();
    if (selected && !first) renderDetail();
    checkAlerts();
    if (first) {
      const firstZone = document.querySelector('#watchlist button.stock');
      if (firstZone && window.matchMedia('(min-width: 901px)').matches) select(firstZone.dataset.tk);
    }
  }

  renderCriteria();
  refresh(true);
  if (!window.__RW_INLINE__) setInterval(() => refresh(false), 10 * 60 * 1000);
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (selected && tab === 'overview') renderDetail(); }, 150); });
})();
