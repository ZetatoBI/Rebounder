"""Generate clearly labelled DEMO data with fictional tickers so the site can be
tested before the real pipeline runs. The site shows a demo banner whenever
meta.demo is true. Running build_data.py replaces all of it with real data."""
import json
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
rnd = random.Random(7)

DEMO = [
    # ticker, sector, industry, price, fwdPE, evEbitda, ps, fcfYield, div, off52, targetUp, trend
    ("DMOA", "Technology", "Software - Application", 120, 15.1, 14.0, 5.2, 5.1, 0.6, 31, 22, "rising"),
    ("DMOB", "Technology", "Software - Application", 64, 26.0, 22.0, 9.8, 2.2, 0.0, 12, 8, "mixed"),
    ("DMOC", "Technology", "Software - Application", 210, 13.2, 11.5, 4.1, 6.3, 1.1, 38, 31, "rising"),
    ("DMOD", "Technology", "Software - Application", 88, 19.0, 17.2, 6.6, 3.9, 0.0, 18, 12, "falling"),
    ("DMOE", "Communication Services", "Telecom Services", 182, 16.2, 9.1, 2.2, 6.8, 2.2, 29, 33, "rising"),
    ("DMOF", "Communication Services", "Telecom Services", 41, 8.8, 7.0, 1.2, 9.5, 6.4, 9, 6, "mixed"),
    ("DMOG", "Communication Services", "Telecom Services", 27, 9.4, 7.4, 1.1, 10.2, 5.9, 14, 10, "mixed"),
    ("DMOH", "Communication Services", "Telecom Services", 66, 12.5, 8.0, 1.8, 7.1, 3.0, 22, 17, "rising"),
    ("DMOI", "Healthcare", "Healthcare Plans", 310, 12.0, 9.5, 0.6, 5.5, 2.4, 44, 27, "rising"),
    ("DMOJ", "Healthcare", "Healthcare Plans", 245, 14.4, 10.8, 0.5, 4.6, 1.9, 20, 9, "falling"),
    ("DMOK", "Healthcare", "Healthcare Plans", 520, 17.9, 12.1, 0.9, 3.8, 1.5, 11, 7, "mixed"),
    ("DMOL", "Healthcare", "Healthcare Plans", 150, 11.1, 8.7, 0.4, 6.0, 2.8, 35, 24, "rising"),
]


def session_times(days):
    """Timestamps for US regular sessions (UTC 13:30 to 20:00), weekdays only."""
    out15, out60 = [], []
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = now.timestamp() - days * 86400
    d = start
    while d < now.timestamp():
        wd = datetime.fromtimestamp(d, timezone.utc).weekday()
        if wd < 5:
            open_t = d + 13.5 * 3600
            out15 += [int(open_t + k * 900) for k in range(26)]
            out60 += [int(open_t + k * 3600) for k in range(7)]
        d += 86400
    return out15, out60


def walk(times, start, channel_every, vol):
    """Random walk that alternates between trending stretches and clean ranges."""
    bars, p = [], start
    regime_len, in_range, center, half = 0, False, start, start * 0.012
    for i, t in enumerate(times):
        if regime_len <= 0:
            if in_range and rnd.random() < 0.45:
                p = p * (1 + rnd.choice([-1, -1, 1]) * rnd.uniform(0.02, 0.05))  # breakout or breakdown
            in_range = rnd.random() < channel_every
            regime_len = rnd.randint(40, 140)
            center, half = p, p * rnd.uniform(0.011, 0.02)
        regime_len -= 1
        if in_range:
            phase = math.sin(i / rnd.uniform(5, 8))
            target = center + half * phase
            p = p + (target - p) * 0.35 + rnd.gauss(0, p * vol * 0.9)
            p = min(max(p, center - half * 1.3), center + half * 1.3)
        else:
            p = p * (1 + rnd.gauss(0.00005, vol))
        o = bars[-1][4] if bars else p
        h = max(o, p) * (1 + abs(rnd.gauss(0, vol * 0.5)))
        l = min(o, p) * (1 - abs(rnd.gauss(0, vol * 0.5)))
        bars.append([t, round(o, 2), round(h, 2), round(l, 2), round(p, 2), rnd.randint(200000, 900000)])
    return bars


def main():
    (DATA / "bars").mkdir(parents=True, exist_ok=True)
    t15, t60 = session_times(60)
    _, t60long = session_times(730)
    stocks = []
    for (tk, sector, industry, price, pe, ev, ps, fcf, div, off, up, trend) in DEMO:
        h1 = walk(t60long, price * rnd.uniform(0.85, 1.2), 0.55, 0.004)
        scale = price / h1[-1][4]
        h1 = [[b[0]] + [round(x * scale, 2) for x in b[1:5]] + [b[5]] for b in h1]
        m15 = walk(t15, price, 0.6, 0.0022)
        # End the demo on a clean range near the floor for a couple of names.
        if tk in ("DMOA", "DMOE", "DMOL"):
            last = m15[-1][4]
            base, half = last, last * 0.013
            for k in range(78):
                idx = len(m15) - 78 + k
                ph = math.sin(k / 6.5 + 0.4)
                c = base + half * ph
                o = m15[idx - 1][4]
                m15[idx] = [m15[idx][0], round(o, 2), round(max(o, c) * 1.0012, 2), round(min(o, c) * 0.9988, 2), round(c, 2), m15[idx][5]]
            # finish near the floor
            m15[-1][4] = round(base - half * 0.8, 2)
            m15[-1][3] = round(min(m15[-1][3], m15[-1][4]), 2)
        earnings = [int(time.time() - k * 91 * 86400 + 20 * 86400) for k in range(9)]
        json.dump({"h1": h1, "m15": m15, "earnings": sorted(earnings)}, open(DATA / "bars" / f"{tk}.json", "w"), separators=(",", ":"))
        p = m15[-1][4]
        mean_t = round(p * (1 + up / 100), 2)
        stocks.append({
            "ticker": tk, "name": f"Demo company {tk[-1]}", "sector": sector, "industry": industry,
            "price": p, "marketCap": rnd.uniform(40, 400) * 1e9, "avgDollarVolume": rnd.uniform(0.3, 3) * 1e9,
            "fwdPE": pe, "evEbitda": ev, "ps": ps, "fcfYield": fcf, "divYield": div,
            "high52": round(p / (1 - off / 100), 2), "offHighPct": off,
            "target": {"mean": mean_t, "weighted": round(mean_t * rnd.uniform(0.98, 1.03), 2), "n": rnd.randint(12, 40),
                       "raised90": rnd.randint(2, 9), "lowered90": rnd.randint(0, 5), "trend90": trend},
            "nextEarnings": min(e for e in earnings if e > time.time()) if any(e > time.time() for e in earnings) else None,
            "recent": m15[-5 * 26:],
            "ai": None,
        })
    # peer medians
    import statistics
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
    json.dump({"meta": {"generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
                        "fundamentalsDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        "source": "Demo data", "demo": True},
               "benchmarks": bench, "stocks": stocks}, open(DATA / "screen.json", "w"), separators=(",", ":"))
    print("demo data written")


if __name__ == "__main__":
    main()
