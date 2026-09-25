"""
pdf_extract.py - pre-extract raw per-page text from the course PDFs so the
Sonnet-5 extraction agents all work from the SAME cleaned text (and know which
pages are image-only and need vision).

Outputs (under ai/rag/_raw/):
  <name>.txt        : per-page text with "===== PAGE n =====" markers, with the
                      repeating copyright / course-header boilerplate stripped.
  manifest.json     : per PDF -> {pages, image_pages:[...], chars_per_page:[...]}
                      image_pages = pages with < IMG_THRESHOLD chars (diagrams,
                      K-maps, circuits, waveforms) that an agent should Read with
                      the vision tool instead of trusting the text.

Run:  py -3.10 ai/rag/pdf_extract.py
Idempotent; safe to re-run.
"""
from __future__ import annotations
import json
import re
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]          # project dir
SRC = {"content": ROOT / "content", "labs": ROOT / "labAssignment"}
OUT = Path(__file__).resolve().parent / "_raw"
OUT.mkdir(parents=True, exist_ok=True)

IMG_THRESHOLD = 80          # chars/page below this = treat page as image-only

# lines that repeat on nearly every page and carry no teaching content
BOILER = [
    re.compile(r"copyright\s*(c|©)", re.I),
    re.compile(r"pearson education", re.I),
    re.compile(r"upper saddle river", re.I),
    re.compile(r"all rights reserved", re.I),
    re.compile(r"digital systems:\s*principles", re.I),
    re.compile(r"ronald j\.?\s*tocci", re.I),
    re.compile(r"01076112|01076113"),                # course code header
    re.compile(r"digital system fundamentals in practice\s*(หน้า)?\s*\d*", re.I),
]


def clean(line: str) -> str | None:
    s = line.rstrip()
    if not s.strip():
        return None
    for b in BOILER:
        if b.search(s):
            return None
    return s


def main() -> None:
    manifest = {}
    for group, d in SRC.items():
        for pdf in sorted(d.glob("*.pdf")):
            r = PdfReader(str(pdf))
            per_page_chars, img_pages, blocks = [], [], []
            for i, page in enumerate(r.pages):
                raw = page.extract_text() or ""
                kept = [c for c in (clean(l) for l in raw.splitlines()) if c]
                text = "\n".join(kept).strip()
                per_page_chars.append(len(text))
                if len(text) < IMG_THRESHOLD:
                    img_pages.append(i + 1)
                blocks.append(f"===== PAGE {i+1} =====\n{text}")
            (OUT / f"{pdf.stem}.txt").write_text("\n\n".join(blocks), encoding="utf-8")
            manifest[pdf.name] = {"group": group, "pages": len(r.pages),
                                  "image_pages": img_pages,
                                  "chars_per_page": per_page_chars,
                                  "raw_txt": f"_raw/{pdf.stem}.txt"}
            print(f"{pdf.name:24} pages={len(r.pages):3} image_pages={len(img_pages):3}")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT/'manifest.json'}  ({len(manifest)} pdfs)")


if __name__ == "__main__":
    main()
