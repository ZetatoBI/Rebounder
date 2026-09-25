"""Generate clearly labelled DEMO data with fictional tickers so the site can be
tested before the real pipeline runs. The site shows a demo banner whenever
meta.demo is true. Running build_data.py replaces all of it with real data."""
import json
import math
import random
import shutil
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
rnd = random.Random(11)

# ticker, sector, industry, price, fwdPE, evEbitda, ps, fcfYield, div, off52, targetUp, trend, character
DEMO = [
    ("DMOA", "Technology", "Software - Application", 120, 15.1, 14.0, 5.2, 5.1, 0.6, 31, 22, "rising", "range"),
    ("DMOB", "Technology", "Software - Application", 64, 26.0, 22.0, 9.8, 2.2, 0.0, 4, 8, "mixed", "trend"),
    ("DMOC", "Technology", "Software - Application", 210, 13.2, 11.5, 4.1, 6.3, 1.1, 38, 31, "rising", "range"),
    ("DMOD", "Technology", "Software - Application", 88, 19.0, 17.2, 6.6, 3.9, 0.0, 18, 12, "falling", "dip"),
    ("DMOE", "Communication Services", "Telecom Services", 182, 16.2, 9.1, 2.2, 6.8, 2.2, 29, 33, "rising", "range"),
    ("DMOF", "Communication Services", "Telecom Services", 41, 8.8, 7.0, 1.2, 9.5, 6.4, 9, 6, "mixed", "trend"),
    ("DMOG", "Communication Services", "Telecom Services", 27, 9.4, 7.4, 1.1, 10.2, 5.9, 14, 10, "mixed", "dip"),
    ("DMOH", "Communication Services", "Telecom Services", 66, 12.5, 8.0, 1.8, 7.1, 3.0, 22, 17, "rising", "chop"),
    ("DMOI", "Healthcare", "Healthcare Plans", 310, 12.0, 9.5, 0.6, 5.5, 2.4, 44, 27, "rising", "range"),
    ("DMOJ", "Healthcare", "Healthcare Plans", 245, 14.4, 10.8, 0.5, 4.6, 1.9, 2, 9, "falling", "trend"),
    ("DMOK", "Healthcare", "Healthcare Plans", 520, 17.9, 12.1, 0.9, 3.8, 1.5, 11, 7, "mixed", "chop"),
    ("DMOL", "Healthcare", "Healthcare Plans", 150, 11.1, 8.7, 0.4, 6.0, 2.8, 35, 24, "rising", "range"),
    ("DMOM", "Industrials", "Railroads", 230, 18.2, 12.4, 5.0, 4.2, 2.0, 3, 9, "rising", "trend"),
    ("DMON", "Industrials", "Railroads", 95, 14.0, 10.1, 3.1, 5.8, 2.6, 16, 19, "mixed", "dip"),
    ("DMOO", "Industrials", "Railroads", 140, 16.5, 11.0, 4.2, 5.0, 2.2, 8, 12, "mixed", "trend"),
    ("DMOP", "Industrials", "Railroads", 58, 21.0, 13.5, 2.8, 3.1, 1.2, 27, 15, "falling", "chop"),
]
CHAR = {  # daily drift, daily vol, share of time spent ranging
    "trend": (0.0009, 0.015, 0.25), "range": (0.0002, 0.013, 0.7), "dip": (0.0005, 0.018, 0.35), "chop": (0.0, 0.017, 0.45),
}


def session_times(days, per_day):
    """Timestamps for US regular sessions (UTC 13:30 to 20:00), weekdays only."""
    out = []
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    step = 23400 // per_day
    d = now - days * 86400
    while d < now:
        if datetime.fromtimestamp(d, timezone.utc).weekday() < 5:
            out += [int(d + 13.5 * 3600 + k * step) for k in range(per_day)] if per_day > 1 else [int(d + 4 * 3600)]
        d += 86400
    return out


def walk(times, start, drift, vol, range_share, dip=0.01):
    """Random walk that alternates between trending stretches and clean ranges."""
    bars, p = [], start
    regime_len, in_range, center, half = 0, False, start, start * 0.03
    for i, t in enumerate(times):
        if regime_len <= 0:
            in_range = rnd.random() < range_share
            regime_len = rnd.randint(40, 160)
            center, half = p, p * rnd.uniform(vol * 1.3, vol * 2.4)
            period = rnd.uniform(5, 9)
        regime_len -= 1
        if in_range:
            target = center + half * math.sin(i / period)
            p = p + (target - p) * 0.35 + rnd.gauss(0, p * vol * 0.5)
            p = min(max(p, center - half * 1.25), center + half * 1.25)
        else:
            p = p * (1 + rnd.gauss(drift, vol))
            if rnd.random() < dip:
                p *= 1 - rnd.uniform(0.02, 0.05)  # sharp dips for mean reversion
        o = bars[-1][4] if bars else p
        h = max(o, p) * (1 + abs(rnd.gauss(0, vol * 0.4)))
        l = min(o, p) * (1 - abs(rnd.gauss(0, vol * 0.4)))
        bars.append([t, round(o, 2), round(h, 2), round(l, 2), round(p, 2), rnd.randint(200000, 900000)])
    return bars


def scaled(bars, price):
    k = price / bars[-1][4]
    return [[b[0]] + [round(x * k, 2) for x in b[1:5]] + [b[5]] for b in bars]


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def main():
    for p in (DATA / "bars", DATA / "recent"):
        shutil.rmtree(p, ignore_errors=True)
    times = {"1d": session_times(365 * 8, 1), "1h": session_times(730, 7), "15m": session_times(60, 26)}
    keep = {"1d": 340, "1h": 280, "15m": 312}
    scale = {"1d": 1.0, "1h": 0.35, "15m": 0.18}  # per-bar volatility shrinks with shorter bars
    recent = {tf: {} for tf in times}
    stocks = []
    rows = [("SPY", None, None, 560, None, None, None, None, None, None, None, None, "trend")] + DEMO
    for (tk, sector, industry, price, pe, ev, ps, fcf, div, off, up, trend, char) in rows:
        drift, vol, share = CHAR[char]
        for tf, ts in times.items():
            d = drift * scale[tf] ** 2 * (0.6 if tk == "SPY" else 1)
            bars = scaled(walk(ts, price, d + (0.00035 if tf == '1d' else 0), vol * scale[tf] * (0.6 if tk == "SPY" else 1), share, 0.01 * scale[tf] ** 2), price)
            dump(DATA / "bars" / tf / f"{tk}.json", bars)
            recent[tf][tk] = bars[-keep[tf]:]
        if tk == "SPY":
            continue
        earnings = sorted(int(time.time() - k * 91 * 86400 + 20 * 86400) for k in range(32))
        mean_t = round(price * (1 + up / 100), 2)
        stocks.append({
            "ticker": tk, "name": f"Demo company {tk[-1]}", "sector": sector, "industry": industry,
            "price": price, "marketCap": rnd.uniform(40, 400) * 1e9, "avgDollarVolume": rnd.uniform(0.3, 3) * 1e9,
            "fwdPE": pe, "evEbitda": ev, "ps": ps, "fcfYield": fcf, "divYield": div,
            "high52": round(price / (1 - off / 100), 2), "offHighPct": off,
            "target": {"mean": mean_t, "weighted": round(mean_t * rnd.uniform(0.98, 1.03), 2), "n": rnd.randint(12, 40),
                       "raised90": rnd.randint(2, 9), "lowered90": rnd.randint(0, 5), "trend90": trend},
            "nextEarnings": min(e for e in earnings if e > time.time()),
            "earnings": earnings, "ai": None,
        })
    bench = {"industry": {}, "sector": {}}
    for level in ("industry", "sector"):
        groups = {}
        for s in stocks:
            groups.setdefault(s[level], []).append(s)
        for name, mem in groups.items():
            bench[level][name] = {k: round(statistics.median([m[k] for m in mem if m[k]]), 2)
                                  for k in ["fwdPE", "evEbitda", "ps", "fcfYield", "divYield"]}
            bench[level][name]["n"] = len(mem)
    for s in stocks:
        s["peers"] = {"level": "industry", "name": s["industry"], **bench["industry"][s["industry"]]}
    for tf in times:
        dump(DATA / "recent" / f"{tf}.json", recent[tf])
    spy = recent["1d"]["SPY"]
    ma = sum(b[4] for b in spy[-200:]) / 200
    now_iso = datetime.now(timezone.utc).isoformat(timespec="minutes")
    dump(DATA / "screen.json", {
        "meta": {"version": 2, "generated": now_iso, "mode": "full", "pricesAsOf": recent["15m"]["DMOA"][-1][0],
                 "fundamentalsDate": now_iso[:10], "fundamentalsUpdated": now_iso, "source": "Demo data",
                 "schedule": "Demo data does not refresh. Run the real pipeline to load market data.", "demo": True},
        "market": {"ticker": "SPY", "price": spy[-1][4], "ma200": round(ma, 2), "above": spy[-1][4] > ma,
                   "vsMaPct": round((spy[-1][4] / ma - 1) * 100, 1)},
        "benchmarks": bench, "stocks": stocks,
    })
    print(f"demo data written: {len(stocks)} stocks")


if __name__ == "__main__":
    main()
