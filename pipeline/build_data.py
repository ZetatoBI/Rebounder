"""Rebounder data pipeline.

Pulls prices, valuation ratios, analyst targets and earnings dates from Yahoo
Finance (via yfinance), computes peer benchmarks, and writes static JSON for
the website in web/data/.

Usage:
  python pipeline/build_data.py --mode full     # everything (run once a day)
  python pipeline/build_data.py --mode hourly   # refresh recent prices only

MVP note: yfinance is an unofficial Yahoo client. It is fine for a private or
unlisted MVP, but Yahoo's terms do not allow commercial redistribution. Switch
to a licensed provider before a public launch (see README).
"""
import argparse
import json
import math
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
BARS = DATA / "bars"
UNIVERSE = ROOT / "pipeline" / "universe.json"
SCREEN = DATA / "screen.json"
RECENT_SESSIONS = 5          # 15-minute bars kept inline for the watchlist
PAUSE = 0.4                  # seconds between tickers, to be polite to Yahoo


def num(x):
    """Return a finite float or None."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def bars_to_list(df):
    if df is None or df.empty:
        return []
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    out = []
    for ts, r in df.iterrows():
        t = int(pd.Timestamp(ts).timestamp())
        out.append([t, round(r["Open"], 4), round(r["High"], 4), round(r["Low"], 4),
                    round(r["Close"], 4), int(r.get("Volume", 0) or 0)])
    return out


def analyst_targets(tk, price):
    """Consensus target plus a recency-weighted target and the 90-day revision trend.

    Uses yfinance's upgrades_downgrades table when it carries price targets; falls
    back to the plain consensus mean otherwise.
    """
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
        # Latest target per firm, weighted by age with a 45-day half-life.
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
    dates = []
    try:
        ed = tk.get_earnings_dates(limit=16)
        if ed is not None and not ed.empty:
            dates = sorted({int(pd.Timestamp(d).timestamp()) for d in ed.index})
    except Exception as e:
        print(f"  earnings dates unavailable: {e}", file=sys.stderr)
    return dates


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
    return tk, {
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
        "target": analyst_targets(tk, price),
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


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


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
    tk = yf.Ticker(symbol)
    path = BARS / f"{symbol}.json"
    store = load_json(path, {"h1": [], "m15": [], "earnings": []})
    if full:
        # Yahoo limits: hourly bars go back about 730 days, 15-minute bars about 60 days.
        store["h1"] = bars_to_list(tk.history(period="730d", interval="1h", auto_adjust=True))
        store["m15"] = bars_to_list(tk.history(period="60d", interval="15m", auto_adjust=True))
    else:
        store["h1"] = merge_bars(store["h1"], bars_to_list(tk.history(period="5d", interval="1h", auto_adjust=True)))
        store["m15"] = merge_bars(store["m15"], bars_to_list(tk.history(period="5d", interval="15m", auto_adjust=True)))
        cutoff = time.time() - 60 * 86400
        store["m15"] = [b for b in store["m15"] if b[0] >= cutoff]
    write_json(path, store)
    return store


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


def peer_bench(stock, bench):
    ind = bench["industry"].get(stock.get("industry") or "", {})
    if ind.get("n", 0) >= 4:
        return {"level": "industry", "name": stock.get("industry"), **ind}
    sec = bench["sector"].get(stock.get("sector") or "", {})
    return {"level": "sector", "name": stock.get("sector"), **sec}


def worth_summarizing(s):
    """Only summarize stocks close to the default criteria, to keep API cost low.
    Loose on purpose so stocks near the line still get a summary."""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full", "hourly"], default="full")
    ap.add_argument("--limit", type=int, default=0, help="only process the first N tickers (testing)")
    args = ap.parse_args()
    full = args.mode == "full"

    tickers = json.load(open(UNIVERSE))["tickers"]
    if args.limit:
        tickers = tickers[: args.limit]
    screen = load_json(SCREEN, {"meta": {}, "stocks": [], "benchmarks": {}})
    if screen.get("meta", {}).get("demo"):
        # First real run: throw away the demo data entirely.
        for f in BARS.glob("*.json"):
            f.unlink()
        screen = {"meta": {}, "stocks": [], "benchmarks": {}}
        full = True
    old = {s["ticker"]: s for s in screen.get("stocks", [])}

    stocks = []
    for i, sym in enumerate(tickers, 1):
        print(f"[{i}/{len(tickers)}] {sym}")
        try:
            if full or sym not in old:
                _, s = fundamentals(sym)
            else:
                s = old[sym]
            store = refresh_bars(sym, full)
            if store.get("earnings") != s.get("earnings") and s.get("earnings"):
                store["earnings"] = s["earnings"]
                write_json(BARS / f"{sym}.json", store)
            m15 = store["m15"]
            s["recent"] = m15[-RECENT_SESSIONS * 26:]
            if m15:
                s["price"] = m15[-1][4]
                if s.get("high52"):
                    s["offHighPct"] = round((1 - s["price"] / s["high52"]) * 100, 1)
            stocks.append(s)
        except Exception as e:
            print(f"  skipped {sym}: {e}", file=sys.stderr)
            if sym in old:
                stocks.append(old[sym])
        time.sleep(PAUSE)

    bench = benchmarks(stocks) if full else screen.get("benchmarks") or benchmarks(stocks)
    for s in stocks:
        s["peers"] = peer_bench(s, bench)
        s.pop("earnings", None)
        if full:
            s["ai"] = ai_summary(s, s["peers"]) if worth_summarizing(s) else None
            if s["ai"]:
                s["aiDate"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        else:
            s["ai"] = old.get(s["ticker"], {}).get("ai")
            s["aiDate"] = old.get(s["ticker"], {}).get("aiDate")

    write_json(SCREEN, {
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "fundamentalsDate": datetime.now(timezone.utc).strftime("%Y-%m-%d") if full
            else screen.get("meta", {}).get("fundamentalsDate"),
            "source": "Yahoo Finance via yfinance",
            "demo": False,
        },
        "benchmarks": bench,
        "stocks": stocks,
    })
    print(f"Wrote {len(stocks)} stocks to {SCREEN}")


if __name__ == "__main__":
    main()
