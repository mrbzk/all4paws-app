"""Builds the installable app (index.html) from the same source as the claude.ai prototype.
Usage: python3 build.py path/to/source/index.html
Adds the manifest, icons and Firebase config to the page head. Everything else is shared."""
import sys, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src/index.html").read_text(encoding="utf-8")
marker = '<meta name="format-detection" content="telephone=no">'
assert marker in src, "head marker not found"
head = marker + '''
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<script src="firebase-config.js"></script>'''
out = src.replace(marker, head, 1)
pathlib.Path("index.html").write_text(out, encoding="utf-8")
print("Built index.html (%d bytes)" % len(out))
