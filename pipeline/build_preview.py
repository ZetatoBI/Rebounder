"""Bundle the site and its current data into one file, preview.html, that opens
with a double-click (no web server needed). Useful for sharing a snapshot.
Full histories for backtests are included, so the file can get large with the
real universe; use --tickers to include full history for a few stocks only."""
import argparse
import json
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
TFS = ("1d", "1h", "15m")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default="", help="comma-separated tickers to include full history for (default: all)")
    args = ap.parse_args()
    only = {t.strip().upper() for t in args.tickers.split(",") if t.strip()}
    html = (WEB / "index.html").read_text()
    screen = json.loads((WEB / "data" / "screen.json").read_text())
    recent = {tf: json.loads((WEB / "data" / "recent" / f"{tf}.json").read_text()) for tf in TFS}
    bars = {tf: {} for tf in TFS}
    for tf in TFS:
        for f in (WEB / "data" / "bars" / tf).glob("*.json"):
            if not only or f.stem in only or f.stem == "SPY":
                bars[tf][f.stem] = json.loads(f.read_text())
    inline = json.dumps({"screen": screen, "recent": recent, "bars": bars}, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{(WEB / 'style.css').read_text()}\n</style>")
    html = html.replace('<script src="engine.js"></script>',
                        f"<script>window.__RW_INLINE__={inline};</script>\n<script>\n{(WEB / 'engine.js').read_text()}\n</script>")
    html = html.replace('<script src="strategies.js"></script>', f"<script>\n{(WEB / 'strategies.js').read_text()}\n</script>")
    html = html.replace('<script src="app.js"></script>', f"<script>\n{(WEB / 'app.js').read_text()}\n</script>")
    (WEB / "preview.html").write_text(html)
    print(f"Wrote {WEB / 'preview.html'} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
