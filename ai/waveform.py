"""
waveform.py — turn a sequential simulation into a TIMING DIAGRAM (self-contained SVG)
and a VCD file (opens in GTKWave). The editor's /sim can embed the SVG; the user can
save the VCD. Functional (0/1, zero-delay) — matches netlist_sim's model.

signals_from_sequential(intent, ...) -> (rows, cycles) where rows = [(name, [bit,...]), ...]
to_svg(rows, cycles) -> str        to_vcd(rows, cycles) -> str
"""
from __future__ import annotations


def signals_from_sequential(intent: dict, input_seq=None, cycles: int = 8) -> tuple:
    """Run the clocked sim and collect inputs, DFF state, and outputs per cycle. If no
    stimulus is given, drive all inputs HIGH so counters/FSMs actually move (visible wave)."""
    from netlist_sim import simulate_sequential, build_graph
    _, _, inputs, _ = build_graph(intent)
    if input_seq is None:
        input_seq = [{k: 1 for k in inputs} for _ in range(cycles)]
    sr = simulate_sequential(intent, cycles=cycles, input_seq=input_seq)
    rows = []
    for name in sr["inputs"]:
        rows.append((name, [r["in"].get(name, 0) for r in sr["rows"]]))
    for d in sr["dffs"]:
        rows.append(("state:" + d, [r["state"].get(d, 0) for r in sr["rows"]]))
    for o in sr["outputs"]:
        rows.append((o, [r["out"].get(o, 0) for r in sr["rows"]]))
    return rows, len(sr["rows"])


def to_svg(rows, cycles: int, title: str = "waveform", clk: bool = True) -> str:
    """Digital timing diagram. Self-contained SVG (dark theme, readable stand-alone)."""
    labelw, cw, rh, top = 96, 46, 34, 34
    tracks = (1 if clk else 0) + len(rows)
    left = labelw + 8
    W = left + cw * cycles + 16
    H = top + rh * tracks + 12
    BG, GRID, LBL, CLKC, SIG, EDGE = "#0b0e14", "#1e2633", "#9ecbff", "#e3b341", "#7ee787", "#2d3a4d"
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
         f'font-family="ui-monospace,Consolas,monospace" font-size="12">',
         f'<rect width="{W}" height="{H}" fill="{BG}"/>',
         f'<text x="10" y="20" fill="{LBL}" font-size="13">{_esc(title)}</text>']
    for c in range(cycles + 1):
        x = left + c * cw
        p.append(f'<line x1="{x}" y1="{top}" x2="{x}" y2="{top + rh * tracks}" stroke="{GRID}"/>')
        if c < cycles:
            p.append(f'<text x="{x + cw/2 - 3}" y="{top - 6}" fill="#6b7688">{c}</text>')

    def track(idx, name, draw, color):
        y0 = top + idx * rh
        hi, lo = y0 + 6, y0 + rh - 8
        p.append(f'<text x="10" y="{lo}" fill="{LBL}">{_esc(name)}</text>')
        p.append(draw(hi, lo, color))

    ti = 0
    if clk:
        def dclk(hi, lo, color):
            d = [f'M{left},{lo}']
            for c in range(cycles):
                x = left + c * cw
                d += [f'L{x},{lo}', f'L{x},{hi}', f'L{x + cw/2},{hi}', f'L{x + cw/2},{lo}', f'L{x + cw},{lo}']
            return f'<path d="{"".join(d)}" fill="none" stroke="{color}" stroke-width="1.5"/>'
        track(ti, "clk", dclk, CLKC); ti += 1

    def make_draw(vals):
        def d(hi, lo, color):
            yv = lambda v: hi if v else lo
            path = [f'M{left},{yv(vals[0])}']
            for c in range(cycles):
                path.append(f'L{left + (c + 1) * cw},{yv(vals[c])}')
                if c + 1 < cycles and vals[c + 1] != vals[c]:
                    path.append(f'L{left + (c + 1) * cw},{yv(vals[c + 1])}')
            return f'<path d="{"".join(path)}" fill="none" stroke="{color}" stroke-width="2"/>'
        return d

    for name, vals in rows:
        track(ti, name, make_draw(vals), SIG); ti += 1
    p.append('</svg>')
    return "\n".join(p)


def to_vcd(rows, cycles: int, timescale: str = "1ns", module: str = "dut") -> str:
    """Minimal VCD (one time step per cycle). Opens in GTKWave / any VCD viewer."""
    import string
    syms = {}
    ids = iter(c for c in string.ascii_letters + string.digits)
    out = [f"$timescale {timescale} $end", f"$scope module {module} $end"]
    for name, _ in rows:
        s = next(ids); syms[name] = s
        out.append(f"$var wire 1 {s} {name.replace(':', '_')} $end")
    out += ["$upscope $end", "$enddefinitions $end", "#0", "$dumpvars"]
    prev = {}
    for name, vals in rows:
        out.append(f"{vals[0]}{syms[name]}"); prev[name] = vals[0]
    out.append("$end")
    for c in range(1, cycles):
        changed = [(name, vals[c]) for name, vals in rows if vals[c] != prev[name]]
        if changed:
            out.append(f"#{c}")
            for name, v in changed:
                out.append(f"{v}{syms[name]}"); prev[name] = v
    return "\n".join(out) + "\n"


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


if __name__ == "__main__":
    import sys, json
    from synth import synth_intent_from_state_equations
    it = synth_intent_from_state_equations({"q1": "q1^(q0*en)", "q0": "q0^en"},
                                           {"c1": "q1", "c0": "q0"}, ["q1", "q0"],
                                           inputs=["en"], module="counter2")
    rows, n = signals_from_sequential(it, cycles=6)
    open("counter2.svg", "w", encoding="utf-8").write(to_svg(rows, n, "counter2 (en=1)"))
    open("counter2.vcd", "w", encoding="utf-8").write(to_vcd(rows, n))
    print("wrote counter2.svg + counter2.vcd", "rows", [r[0] for r in rows])
