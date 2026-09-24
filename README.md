# Rebounder

A Zetato Studios app. It screens large, liquid stocks that trade below their peers on valuation, sit well under their 52-week high, and have analyst targets above the price. It then measures whether each one is trading in a tight price channel on 15-minute bars, and lets anyone backtest channel rules on real price history.

It is an educational screening tool. It shows what matches criteria the user sets. It never says buy or sell.

## What's in the repo

| Path | What it does |
| --- | --- |
| `pipeline/build_data.py` | Pulls prices, ratios, analyst targets and earnings dates, computes peer medians, writes `web/data/` |
| `pipeline/universe.json` | The stocks to screen. Peer medians come from this list, so broader is better |
| `pipeline/demo_data.py` | Fictional demo data for testing the site without market data (shows a demo banner) |
| `pipeline/build_preview.py` | Bundles site plus data into one `preview.html` you can open by double-click |
| `web/` | The static site: `index.html`, `style.css`, `app.js`, `engine.js` (channel and backtest logic) |
| `.github/workflows/refresh.yml` | Runs the pipeline on a schedule and deploys to GitHub Pages |

## Run it locally

```bash
pip install -r requirements.txt
python pipeline/build_data.py --mode full --limit 10   # quick test on 10 tickers
python pipeline/build_data.py --mode full              # whole universe, about 5 to 10 minutes
cd web && python -m http.server 8000                   # open http://localhost:8000
```

No market data yet? `python pipeline/demo_data.py` creates fictional demo data. The first real run deletes it automatically.

## Deploy on GitHub Pages

1. Create a repo in the ZetatoBI organization, for example `rebounder`, and push this folder.
2. Settings > Pages > Source: **GitHub Actions**.
3. Optional: Settings > Secrets and variables > Actions > add `ANTHROPIC_API_KEY` for the daily AI summaries. Without it the app simply hides that card. Summaries are only generated for stocks close to the default criteria, to keep cost to a few dollars a month.
4. Actions > Refresh data and deploy > Run workflow (mode `full`) for the first load.

After that it refreshes on its own: a full refresh at 8:00 ET on weekdays and a price refresh every hour during market hours. Data is cached between runs, not committed to git.

For a custom address such as `rebounder.zetatobi.com`, add it under Settings > Pages and a CNAME record in GoDaddy pointing to `zetatobi.github.io`.

## Data: what the free MVP can and can't do

The MVP uses `yfinance`, an unofficial Yahoo Finance client.

- **Limits.** Hourly bars go back about 2 years and 15-minute bars about 60 days, so the backtester offers both. Analyst target history depends on what Yahoo exposes; when dated targets are missing the app falls back to the plain consensus.
- **Reliability.** Yahoo sometimes rate-limits or blocks cloud servers. If the GitHub run fails for that reason, run `build_data.py` on your own machine on a schedule and push the output, or move to a paid provider.
- **Licensing.** Yahoo's terms don't allow commercial redistribution. Keep the MVP private or unlisted, and move to a licensed provider with public display rights before promoting it on Zetato Studios. Only `build_data.py` needs to change; the site reads the same JSON.

## How the numbers are calculated

- **Channel.** Over the last N sessions of 15-minute bars: ceiling is the 90th percentile of highs, floor the 10th percentile of lows. A channel counts when its width is inside your range, at least 90% of closes sit inside it, the drift is under half its height, and each side was visited at least your minimum number of times.
- **Peer benchmarks.** Median of the same industry within the universe, or the sector when fewer than 4 industry peers exist. Ratios: forward P/E, EV/EBITDA, price to sales, free cash flow yield, dividend yield.
- **Recency-weighted target.** Each firm's latest target from the last 180 days, weighted by age with a 45-day half-life.
- **Backtest.** Channel levels are frozen at the signal. Fills happen only if price reaches each level. A stop and a target in the same bar count as a stop. Costs are charged on both sides. Trades spanning an earnings date can be skipped. Valuation and analyst filters use today's values, so the backtest covers the channel rules only.

Sanity check: on pure random-walk prices these rules produce about a 72% win rate but a slightly negative result per trade. A high win rate alone doesn't prove anything, which is why the app leads with dollars, average loss and break-even win rate.

## Staying on the information side

Confirm with legal counsel before public launch. The app is built to stay general and impersonal: the user sets every criterion, the output is the same for everyone, levels are shown as measurements, alerts are set by the user, backtests are labelled hypothetical, and there is no buy or sell language. Keep new features inside those lines.

## Before public launch

- Remove the `robots` noindex line from `web/index.html` so search engines can list it.
- Move to a licensed data provider and get legal sign-off.

## Roadmap

- Email alerts (needs a small backend, for example a Cloudflare Worker with a scheduled check)
- Licensed data provider with public display rights and point-in-time fundamentals
- Earnings-aware channel resets and a market-condition filter (index trend, volatility)
