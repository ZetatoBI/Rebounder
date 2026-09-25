# Rebounder

A Zetato Studios app. It screens large, liquid US stocks with four well-known strategies, shows which stocks are active under each one, and lets anyone test the rules on real price history, one stock at a time or across the whole universe.

It is an educational screening tool. It shows what matches rules the user sets. It never says buy or sell.

## Strategies

| Strategy | Idea | Timeframes | Default |
| --- | --- | --- | --- |
| Channel rebound | Fairly valued large caps moving sideways in a range; entry zone near the floor, exit at the midline or exit zone | 15 min, hourly, daily | Hourly |
| Mean reversion (RSI 2) | Short, sharp dips in stocks above their 200-bar average; exit on the bounce (Larry Connors) | Daily, hourly, 15 min | Daily |
| Trend following | Close above the 50-bar high while above the 200-bar average; exit on a 20-bar low or trailing ATR stop (Turtle-style) | Daily, hourly, 15 min | Daily |
| Momentum (12 minus 1) | Positive 12-month momentum excluding the last month, above the 200-day average, checked monthly; watchlist ranks the universe | Daily | Daily |

Each strategy has research-based defaults for every timeframe it supports, a plain-language explainer, and an info tip on every setting. User changes are saved in the browser, per strategy and per timeframe.

Shared features: value and analyst filters (on by default for Channel rebound only), a market filter (S&P 500 above its 200-day average), earnings avoidance, buy-and-hold comparison on every backtest, and "Test on all stocks".

## What's in the repo

| Path | What it does |
| --- | --- |
| `pipeline/build_data.py` | Pulls prices, ratios, analyst targets and earnings dates, computes peer medians, writes `web/data/` |
| `pipeline/universe.json` | The stocks to screen. Peer medians and momentum ranks come from this list, so broader is better |
| `pipeline/demo_data.py` | Fictional demo data for testing without market data (shows a demo banner) |
| `pipeline/build_preview.py` | Bundles site plus data into one `preview.html` you can open by double-click |
| `web/engine.js` | Indicators, channel detection, trade simulator, statistics |
| `web/strategies.js` | The four strategies: rules, defaults, settings help, explainers |
| `web/app.js`, `index.html`, `style.css` | The site |
| `.github/workflows/refresh.yml` | Runs the pipeline on a schedule and deploys to GitHub Pages |
| `PROGRESS.md` | Checkpoint log for the v2 upgrade |

### Data layout (`web/data/`, not committed)

| File | Contents |
| --- | --- |
| `screen.json` | Fundamentals, peers, earnings dates, market trend, timestamps and refresh schedule |
| `recent/{1d,1h,15m}.json` | The latest bars for every stock (about 340 daily, 40 sessions hourly, 12 sessions of 15 min), used by the watchlist |
| `bars/{1d,1h,15m}/TICKER.json` | Full history (10 years daily, about 2 years hourly, about 60 days of 15 min), loaded on demand for backtests |

## Refresh schedule

- **Full refresh** (fundamentals, analyst targets, all history): weekdays at 12:00 UTC, which is 8 AM EDT or 7 AM EST.
- **Price refresh**: about every hour while the US market is open. Cron runs at :50 past each hour from 13:50 to 20:50 UTC plus 21:20 UTC; the pipeline skips (and nothing is deployed) outside 9:30 AM to 5:05 PM New York time, which handles daylight saving automatically. First refresh is around 9:50 AM ET, the last shortly after the 4:00 PM close.
- A push to `main` deploys immediately with a price refresh. If the cached data is from v1 or demo, the pipeline does a clean full refresh first (about 10 minutes).

The dashboard shows when data was last updated in the header; the i next to it shows prices-as-of time, company data time, when your browser loaded it, and the schedule.

## Run it locally

```bash
pip install -r requirements.txt
python pipeline/build_data.py --mode full --limit 10   # quick test on 10 tickers
python pipeline/build_data.py --mode full              # whole universe, about 10 minutes
cd web && python -m http.server 8000                   # open http://localhost:8000
```

No market data yet? `python pipeline/demo_data.py` creates fictional demo data. The first real run deletes it automatically.

## Deploy on GitHub Pages

1. Replace the repo files with this version and push to `main`.
2. Settings > Pages > Source: **GitHub Actions** (already set for the live site).
3. Optional: add the `ANTHROPIC_API_KEY` secret for daily AI summaries. Without it the card is hidden.
4. The custom domain `rebounder.zetatobi.com` is kept by the `CNAME` file.

## How the numbers are calculated

- **Channel.** Ceiling from bar highs, floor from bar lows, over the look-back. "Channel edges" sets how many extreme wicks are ignored (0% uses the exact highest high and lowest low; 5% is the default). It counts as a channel when its width is inside your range, 90% of closes sit inside it, it drifts less than half its height, and both edges were visited enough times. When a range fails, the app says which test it failed.
- **Signals and fills.** Signals use completed bars only. Close-based rules (mean reversion, trend, momentum) fill at the next bar's open. Channel entries fill at your zone levels when price trades there. A gap through a stop fills at the open. A stop and a target in the same bar count as a stop. Costs are charged on both sides. Tested for lookahead bias: results on truncated history match the full history.
- **Buy and hold** uses the same position size over the same period. The strategy is only invested part of the time, so compare with that in mind.
- **Test on all stocks** pools every trade across the universe. Filtering to stocks that pass today's value and analyst filters is optional and flagged as hindsight.
- **Peer benchmarks.** Median of the same industry within the universe, or the sector when fewer than 4 industry peers exist.
- **Recency-weighted target.** Each firm's latest target from the last 180 days, weighted by age with a 45-day half-life.

## Data: what the free MVP can and can't do

The MVP uses `yfinance`, an unofficial Yahoo Finance client.

- **Limits.** Hourly bars go back about 2 years and 15-minute bars about 60 days. Fundamentals are today's values only, so value and analyst filters cannot be backtested.
- **Reliability.** Yahoo sometimes rate-limits cloud servers. If the GitHub run fails for that reason, run `build_data.py` on your own machine and push the output, or move to a paid provider.
- **Licensing.** Yahoo's terms don't allow commercial redistribution. Keep the MVP private or unlisted, and move to a licensed provider with public display rights before promoting it. Only `build_data.py` needs to change; the site reads the same JSON.
- **Survivorship bias.** The universe is today's large caps, so backtests exclude companies that shrank or disappeared. Results are flattered, most for momentum and trend.

## Staying on the information side

Confirm with legal counsel before public launch. The app stays general and impersonal: the user sets every rule, the output is the same for everyone, levels are shown as measurements, alerts are set by the user, backtests are labelled hypothetical, and there is no buy or sell language. Keep new features inside those lines.

## Before public launch

- Remove the `robots` noindex line from `web/index.html`.
- Move to a licensed data provider and get legal sign-off.

## Roadmap

- Email or push alerts (needs a small backend, for example a Cloudflare Worker with a scheduled check)
- Licensed data with point-in-time fundamentals, so value filters can be backtested
- Portfolio-level backtest (several positions at once, shared capital) and a momentum backtest that uses the universe ranking
- Volatility squeeze breakout as a fifth strategy
