"""Bundle the site and its current data into one file, preview.html, that opens
with a double-click (no web server needed). Useful for sharing a snapshot."""
import json
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


def main():
    html = (WEB / "index.html").read_text()
    css = (WEB / "style.css").read_text()
    engine = (WEB / "engine.js").read_text()
    app = (WEB / "app.js").read_text()
    screen = json.loads((WEB / "data" / "screen.json").read_text())
    bars = {}
    for s in screen["stocks"]:
        f = WEB / "data" / "bars" / f"{s['ticker']}.json"
        if f.exists():
            bars[s["ticker"]] = json.loads(f.read_text())
    inline = json.dumps({"screen": screen, "bars": bars}, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>")
    html = html.replace('<script src="engine.js"></script>',
                        f"<script>window.__RW_INLINE__={inline};</script>\n<script>\n{engine}\n</script>")
    html = html.replace('<script src="app.js"></script>', f"<script>\n{app}\n</script>")
    (WEB / "preview.html").write_text(html)
    print(f"Wrote {WEB / 'preview.html'} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
