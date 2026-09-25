"""Rebounder data pipeline (v2).

Pulls prices (daily, hourly, 15-minute), valuation ratios, analyst targets and
earnings dates from Yahoo Finance (via yfinance), computes peer benchmarks, and
writes static JSON for the website in web/data/:

  screen.json                 fundamentals, peers, earnings, market trend, timestamps
  recent/{1d,1h,15m}.json     the latest bars of every stock, for the watchlist
  bars/{1d,1h,15m}/TICKER.json full history, loaded on demand for backtests

Usage:
  python pipeline/build_data.py --mode full     # everything (once a day, before the open)
  python pipeline/build_data.py --mode hourly   # recent prices only (during market hours)
  add --force to run an hourly refresh outside market hours

MVP note: yfinance is an unofficial Yahoo client. Fine for a private or unlisted
MVP, but Yahoo's terms do not allow commercial redistribution. Switch to a
licensed provider before a public launch (see README).
"""
import argparse
import json
import math
import os
import shutil
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

VERSION = 2
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
UNIVERSE = ROOT / "pipeline" / "universe.json"
SCREEN = DATA / "screen.json"
MARKET = "SPY"          # S&P 500 proxy for the market-trend filter
PAUSE = 0.4             # seconds between tickers, to be polite to Yahoo
NY = ZoneInfo("America/New_York")

# timeframe -> (yfinance interval, full-history period, bars kept in recent/, max age in days)
TIMEFRAMES = {
    "1d": ("1d", "10y", 340, None),
    "1h": ("1h", "730d", 40 * 7, 730),
    "15m": ("15m", "60d", 12 * 26, 60),
}

SCHEDULE = ("Prices refresh about every hour while the US market is open: the first refresh is around "
            "9:50 AM ET and the last shortly after the 4:00 PM close. Company data and analyst targets "
            "refresh once each weekday before the open, around 7 to 8 AM ET.")


def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def market_open_window(now=None):
    """True on weekdays between 9:30 AM and 5:05 PM New York time (covers the post-close refresh)."""
    now = (now or datetime.now(timezone.utc)).astimezone(NY)
    minutes = now.hour * 60 + now.minute
    return now.weekday() < 5 and 9 * 60 + 30 <= minutes <= 17 * 60 + 5


def set_output(key, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"{key}={value}\n")


def bars_to_list(df):
    if df is None or df.empty:
        return []
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    out = []
    for ts, r in df.iterrows():
        out.append([int(pd.Timestamp(ts).timestamp()), round(float(r["Open"]), 2), round(float(r["High"]), 2),
                    round(float(r["Low"]), 2), round(float(r["Close"]), 2), int(r.get("Volume", 0) or 0)])
    return out


def analyst_targets(tk):
    """Consensus target plus a recency-weighted target and the 90-day revision trend."""
    info = tk.info or {}
    mean = num(info.get("targetMeanPrice"))
    out = {"mean": mean, "weighted": mean, "n": info.get("numberOfAnalystOpinions"),
           "raised90": None, "lowered90": None, "trend90": None}
    try:
        ud = tk.upgrades_downgrades
        if ud is None or ud.empty or "currentPriceTarget" not in ud.columns:
            return out
        ud = ud.reset_index()
        date_col = "GradeDate" if "GradeDate" in ud.columns else ud.columns[0]
        ud[date_col] = pd.to_datetime(ud[date_col], utc=True)
        now = pd.Timestamp.now(tz="UTC")
        recent = ud[ud[date_col] >= now - pd.Timedelta(days=180)]
        recent = recent[recent["currentPriceTarget"].fillna(0) > 0]
        if recent.empty:
            return out
        latest = recent.sort_values(date_col).groupby("Firm").tail(1)
        ages = (now - latest[date_col]).dt.days.clip(lower=0)
        weights = 0.5 ** (ages / 45.0)
        out["weighted"] = round(float((latest["currentPriceTarget"] * weights).sum() / weights.sum()), 2)
        last90 = recent[recent[date_col] >= now - pd.Timedelta(days=90)]
        if "priorPriceTarget" in last90.columns:
            prior = last90["priorPriceTarget"].fillna(0)
            cur = last90["currentPriceTarget"]
            raised = int(((cur > prior) & (prior > 0)).sum())
            lowered = int(((cur < prior) & (prior > 0)).sum())
            out["raised90"], out["lowered90"] = raised, lowered
            if raised + lowered >= 2:
                out["trend90"] = "rising" if raised > lowered * 1.5 else "falling" if lowered > raised * 1.5 else "mixed"
    except Exception as e:  # yfinance fields change; never fail the run over this
        print(f"  targets detail unavailable: {e}", file=sys.stderr)
    return out


def earnings_dates(tk):
    try:
        ed = tk.get_earnings_dates(limit=40)
        if ed is not None and not ed.empty:
            return sorted({int(pd.Timestamp(d).timestamp()) for d in ed.index})
    except Exception as e:
        print(f"  earnings dates unavailable: {e}", file=sys.stderr)
    return []


def fundamentals(symbol):
    tk = yf.Ticker(symbol)
    info = tk.info or {}
    price = num(info.get("currentPrice")) or num(info.get("regularMarketPrice"))
    mcap = num(info.get("marketCap"))
    fcf = num(info.get("freeCashflow"))
    div_rate = num(info.get("dividendRate")) or num(info.get("trailingAnnualDividendRate"))
    high52 = num(info.get("fiftyTwoWeekHigh"))
    avg_vol = num(info.get("averageVolume"))
    earn = earnings_dates(tk)
    now = int(time.time())
    upcoming = [d for d in earn if d >= now]
    return {
        "ticker": symbol,
        "name": info.get("shortName") or info.get("longName") or symbol,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "price": price,
        "marketCap": mcap,
        "avgDollarVolume": avg_vol * price if avg_vol and price else None,
        "fwdPE": num(info.get("forwardPE")),
        "evEbitda": num(info.get("enterpriseToEbitda")),
        "ps": num(info.get("priceToSalesTrailing12Months")),
        "fcfYield": round(fcf / mcap * 100, 2) if fcf and mcap else None,
        "divYield": round(div_rate / price * 100, 2) if div_rate and price else 0.0,
        "high52": high52,
        "offHighPct": round((1 - price / high52) * 100, 1) if price and high52 else None,
        "target": analyst_targets(tk),
        "nextEarnings": upcoming[0] if upcoming else None,
        "earnings": earn,
    }


def median(values):
    vals = [v for v in values if v is not None and v > 0]
    return round(statistics.median(vals), 2) if vals else None


def benchmarks(stocks):
    """Peer medians by industry and by sector, computed from the universe."""
    out = {"industry": {}, "sector": {}}
    keys = ["fwdPE", "evEbitda", "ps", "fcfYield", "divYield"]
    for level in ("industry", "sector"):
        groups = {}
        for s in stocks:
            if s.get(level):
                groups.setdefault(s[level], []).append(s)
        for name, members in groups.items():
            out[level][name] = {k: median([m.get(k) for m in members]) for k in keys}
            out[level][name]["n"] = len(members)
    return out


def peer_bench(stock, bench):
    ind = bench["industry"].get(stock.get("industry") or "", {})
    if ind.get("n", 0) >= 4:
        return {"level": "industry", "name": stock.get("industry"), **ind}
    sec = bench["sector"].get(stock.get("sector") or "", {})
    return {"level": "sector", "name": stock.get("sector"), **sec}


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    tmp.replace(path)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def merge_bars(old, new):
    by_t = {b[0]: b for b in old}
    for b in new:
        by_t[b[0]] = b
    return [by_t[t] for t in sorted(by_t)]


def refresh_bars(symbol, full):
    """Update bars/{tf}/SYMBOL.json for every timeframe and return the recent slices."""
    tk = yf.Ticker(symbol)
    recent = {}
    for tf, (interval, period, keep, max_age) in TIMEFRAMES.items():
        path = DATA / "bars" / tf / f"{symbol}.json"
        old = [] if full else load_json(path, [])
        new = bars_to_list(tk.history(period=period if full or not old else "5d", interval=interval, auto_adjust=True))
        bars = merge_bars(old, new)
        if max_age:
            cutoff = time.time() - max_age * 86400
            bars = [b for b in bars if b[0] >= cutoff]
        if bars:
            write_json(path, bars)
        recent[tf] = bars[-keep:]
    return recent


def ai_summary(stock, bench):
    """Optional neutral summary. Runs only when ANTHROPIC_API_KEY is set."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    import requests
    facts = {k: stock.get(k) for k in ["ticker", "name", "industry", "price", "fwdPE", "evEbitda", "ps",
                                         "fcfYield", "divYield", "offHighPct", "target", "nextEarnings"]}
    prompt = (
        "Write a neutral, factual 2 to 3 sentence summary of this stock's current valuation and analyst "
        "picture for an educational screening tool. Compare ratios with the peer medians given. Do not "
        "recommend buying, selling or holding, do not predict prices, and do not use the words buy, sell, "
        "entry, or target price as advice. No dashes. Data (JSON):\n"
        + json.dumps({"stock": facts, "peer_medians": bench})
    )
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5"), "max_tokens": 300,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=60,
        )
        r.raise_for_status()
        return "".join(b.get("text", "") for b in r.json().get("content", [])).strip() or None
    except Exception as e:
        print(f"  AI summary failed for {stock['ticker']}: {e}", file=sys.stderr)
        return None


def worth_summarizing(s):
    """Only summarize stocks close to the default value criteria, to keep API cost low."""
    peer_pe = (s.get("peers") or {}).get("fwdPE")
    t = s.get("target") or {}
    target = t.get("weighted") or t.get("mean")
    upside = (target / s["price"] - 1) * 100 if target and s.get("price") else None
    return bool(
        (s.get("marketCap") or 0) >= 10e9
        and s.get("fwdPE") and peer_pe and s["fwdPE"] <= peer_pe
        and (s.get("offHighPct") or 0) >= 10
        and upside is not None and upside >= 10
    )


def market_summary(daily):
    if len(daily) < 201:
        return None
    closes = [b[4] for b in daily]
    ma = sum(closes[-200:]) / 200
    return {"ticker": MARKET, "price": closes[-1], "ma200": round(ma, 2), "above": closes[-1] > ma,
            "vsMaPct": round((closes[-1] / ma - 1) * 100, 1)}


def reset_data():
    """Remove demo or v1 data so the new layout starts clean."""
    for p in (DATA / "bars", DATA / "recent"):
        shutil.rmtree(p, ignore_errors=True)
    SCREEN.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full", "hourly"], default="full")
    ap.add_argument("--force", action="store_true", help="run an hourly refresh even outside market hours")
    ap.add_argument("--limit", type=int, default=0, help="only process the first N tickers (testing)")
    args = ap.parse_args()
    full = args.mode == "full"

    screen = load_json(SCREEN, {})
    meta = screen.get("meta", {})
    if meta.get("demo") or meta.get("version") != VERSION:
        if screen:
            print("Old or demo data found: starting a clean full refresh.")
        reset_data()
        screen, full = {}, True

    if not full and not args.force and not market_open_window():
        print("Outside US market hours: nothing to refresh.")
        set_output("skip", "true")
        return
    set_output("skip", "false")

    tickers = json.load(open(UNIVERSE))["tickers"]
    if args.limit:
        tickers = tickers[: args.limit]
    old = {s["ticker"]: s for s in screen.get("stocks", [])}
    recent = {tf: load_json(DATA / "recent" / f"{tf}.json", {}) for tf in TIMEFRAMES}

    stocks = []
    for i, sym in enumerate([MARKET] + tickers, 1):
        print(f"[{i}/{len(tickers) + 1}] {sym}")
        try:
            rec = refresh_bars(sym, full)
            for tf in TIMEFRAMES:
                recent[tf][sym] = rec[tf]
            if sym == MARKET:
                continue
            s = fundamentals(sym) if full or sym not in old else old[sym]
            last = next((rec[tf][-1] for tf in ("15m", "1h", "1d") if rec[tf]), None)
            if last:
                s["price"] = last[4]
                if s.get("high52"):
                    s["offHighPct"] = round((1 - s["price"] / s["high52"]) * 100, 1)
            stocks.append(s)
        except Exception as e:
            print(f"  skipped {sym}: {e}", file=sys.stderr)
            if sym in old:
                stocks.append(old[sym])
        time.sleep(PAUSE)

    bench = benchmarks(stocks) if full or not screen.get("benchmarks") else screen["benchmarks"]
    now_iso = datetime.now(timezone.utc).isoformat(timespec="minutes")
    for s in stocks:
        s["peers"] = peer_bench(s, bench)
        prev = old.get(s["ticker"], {})
        if full:
            s["ai"] = ai_summary(s, s["peers"]) if worth_summarizing(s) else None
            s["aiDate"] = datetime.now(timezone.utc).strftime("%Y-%m-%d") if s["ai"] else None
        else:
            s["ai"], s["aiDate"] = prev.get("ai"), prev.get("aiDate")

    for tf in TIMEFRAMES:
        write_json(DATA / "recent" / f"{tf}.json", recent[tf])
    latest = max((bars[-1][0] for tf in ("15m", "1h") for bars in recent[tf].values() if bars), default=None)
    write_json(SCREEN, {
        "meta": {
            "version": VERSION,
            "generated": now_iso,
            "mode": "full" if full else "hourly",
            "pricesAsOf": latest,
            "fundamentalsDate": datetime.now(timezone.utc).strftime("%Y-%m-%d") if full else meta.get("fundamentalsDate"),
            "fundamentalsUpdated": now_iso if full else meta.get("fundamentalsUpdated"),
            "source": "Yahoo Finance via yfinance",
            "schedule": SCHEDULE,
            "demo": False,
        },
        "market": market_summary(recent["1d"].get(MARKET, [])),
        "benchmarks": bench,
        "stocks": stocks,
    })
    print(f"Wrote {len(stocks)} stocks to {SCREEN}")


if __name__ == "__main__":
    main()
