# Rebounder (rebounder.zetatobi.com)

A Zetato Studios stock-screening app. Static site in `web/`, deployed to GitHub Pages by
`.github/workflows/refresh.yml` (Pages source: GitHub Actions). `CNAME` holds the custom domain: never delete it.

## How it fits together
- `pipeline/build_data.py` pulls Yahoo data (yfinance) into `web/data/` (not committed; kept in the Actions cache).
- `web/engine.js` and `web/strategies.js` hold all strategy logic. They run in the browser and in Node.
- `pipeline/build_signals.js` runs after each refresh and writes `web/data/signals.json`: positions the four
  strategies hold with DEFAULT settings, and trades they closed recently. It loads the same engine and
  strategy files, so there is one implementation of every rule. Do not re-implement strategy logic elsewhere.
- zetatobi.com/insights (repo `ZetatoBI/website`) reads `signals.json` daily and keeps the permanent,
  forward-only track record. Changing the file's field names or meaning breaks that page: coordinate both repos.

## Rules
- `FILTER_DEFAULTS` and `BT_DEFAULTS` in `build_signals.js` must match `web/app.js`. Change them together.
- Changing a strategy's default settings changes the public track record from that day on. Treat it as a
  deliberate, dated decision, never a casual tweak.
- Stay on the information side: no buy or sell language, rules are the same for everyone, backtests are
  labelled hypothetical, keep the disclaimers. Yahoo data is not licensed for commercial redistribution.
- Test without network access: `python pipeline/demo_data.py`, then `node pipeline/build_signals.js`.
  Demo data is flagged `demo: true`, and Insights ignores it.
- Work on a branch and open a pull request. Do not push to `main` directly: a push to `main` deploys.
