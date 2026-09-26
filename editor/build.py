"""
build.py - put the editor's UX layer (editor/ux/*.js + ux.css) into schematic&bus2vhdl.html.

The editor ships as ONE html file (it must open straight from disk and from the launcher),
so the UX layer is written as separate source files here and inlined between the
<!-- UX-LAYER:BEGIN --> / <!-- UX-LAYER:END --> markers at the end of the page.
Scripts are concatenated in file-name order (01-… 02-… — later files may wrap
functions defined by earlier ones and by the editor itself).

    python editor/build.py           # rebuild the html in place
    python editor/build.py --check   # CI: fail if the html is out of date with the sources

Edit the files in editor/ux/, never the inlined copy in the html — it is overwritten.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "schematic&bus2vhdl.html"
UX = Path(__file__).resolve().parent / "ux"
BEGIN, END = "<!-- UX-LAYER:BEGIN -->", "<!-- UX-LAYER:END -->"


def render_block() -> str:
    css = (UX / "ux.css").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in sorted(UX.glob("*.js")))
    return f"{BEGIN}\n<style>\n{css}</style>\n<script>\n\"use strict\";\n{js}\n</script>\n{END}"


def build(text: str) -> str:
    block = render_block()
    if BEGIN in text:
        a, b = text.index(BEGIN), text.index(END) + len(END)
        return text[:a] + block + text[b:]
    i = text.rindex("</body>")
    return text[:i] + block + "\n" + text[i:]


def main() -> int:
    cur = HTML.read_text(encoding="utf-8")
    new = build(cur)
    if "--check" in sys.argv:
        if new != cur:
            print("schematic&bus2vhdl.html is out of date with editor/ux/ — run: python editor/build.py")
            return 1
        print("editor html up to date")
        return 0
    if new != cur:
        HTML.write_text(new, encoding="utf-8")
        print(f"rebuilt {HTML.name} ({len(new):,} bytes)")
    else:
        print("no changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
