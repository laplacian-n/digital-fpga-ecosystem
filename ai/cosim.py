"""
cosim.py - co-simulation equivalence check with GHDL (bundled in ai/tools/ghdl).

Compiles the deterministically-generated VHDL, drives EVERY input combination in
a self-checking testbench, captures outputs, and compares them BIT-FOR-BIT with
netlist_sim's truth table. This is the strongest correctness gate: the emitted
VHDL must behave on a real VHDL simulator exactly as the verified netlist
(closes "co-sim equivalence"). Combinational (Intent v1), exhaustive <=16 inputs.

(Note: the bundled vivado_min XSim lacks precompiled IEEE libs, so we use GHDL,
which ships std/ieee built in — matches the architecture's GHDL choice.)
"""
from __future__ import annotations
import subprocess
import tempfile
import shutil
from pathlib import Path

from netlist_sim import build_graph, truth_table, is_sequential, simulate_sequential
from gen_vhdl import generate_vhdl, _san

GHDL = Path(__file__).resolve().parent / "tools" / "ghdl" / "bin" / "ghdl.exe"
STD = "08"


def _names(intent):
    comps, fanin, inputs, outputs = build_graph(intent)
    inn = [_san(comps[i].get("name") or i) for i in inputs]
    outn = [_san(comps[o].get("name") or o) for o in outputs]
    return inn, outn


def make_testbench(intent, entity: str) -> str:
    inn, outn = _names(intent)
    N = len(inn)
    sig = "".join(f"  signal {n} : std_logic;\n" for n in inn + outn)
    pmap = ", ".join(f"{n} => {n}" for n in inn + outn)
    setb = "".join(f"      {n} <= iv({i});\n" for i, n in enumerate(inn))
    _w = "write(L, character'('1')); else write(L, character'('0'))"
    win = "".join(f"      if {n}='1' then {_w}; end if;\n" for n in inn)
    wout = "".join(f"      if {n}='1' then {_w}; end if;\n" for n in outn)
    return f"""library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;
use STD.TEXTIO.ALL;
entity tb is end tb;
architecture sim of tb is
{sig}begin
  dut: entity work.{entity} port map({pmap});
  process
    file f : text open write_mode is "cosim_out.txt";
    variable L : line;
    variable iv : std_logic_vector({N-1} downto 0);
  begin
    for i in 0 to {2**N - 1} loop
      iv := std_logic_vector(to_unsigned(i, {N}));
{setb}      wait for 10 ns;
{win}      write(L, character'(' '));
{wout}      writeline(f, L);
    end loop;
    file_close(f);
    wait;
  end process;
end sim;
"""


def make_testbench_seq(intent, entity: str, cycles: int, stim: list | None = None) -> str:
    inn, outn = _names(intent)
    sig = "".join(f"  signal {n} : std_logic := '0';\n" for n in inn + outn)
    pmap = ", ".join([f"{n} => {n}" for n in inn] + ["clk => clk"] +
                     [f"{n} => {n}" for n in outn])
    wout = "".join(f"      if {n}='1' then write(L, character'('1')); "
                   f"else write(L, character'('0')); end if;\n" for n in outn)
    # per-cycle input stimulus (stim[i] = list of bits in inn order); default hold 0
    setin = ""
    if stim and inn:
        branches = []
        for i, bits in enumerate(stim):
            asg = " ".join(f"{inn[k]} <= '{int(b) & 1}';" for k, b in enumerate(bits))
            branches.append(f"{'if' if i == 0 else 'elsif'} i = {i} then {asg}")
        setin = "      " + "\n      ".join(branches) + "\n      end if;\n"
    return f"""library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use STD.TEXTIO.ALL;
entity tb is end tb;
architecture sim of tb is
  signal clk : std_logic := '0';
{sig}  signal done : boolean := false;
begin
  dut: entity work.{entity} port map({pmap});
  clkp: process begin
    while not done loop
      clk <= '0'; wait for 5 ns; clk <= '1'; wait for 5 ns;
    end loop;
    wait;
  end process;
  process
    file f : text open write_mode is "cosim_out.txt";
    variable L : line;
  begin
    for i in 0 to {cycles - 1} loop
{setin}      wait for 1 ns;
{wout}      writeline(f, L);
      wait until rising_edge(clk);
    end loop;
    file_close(f);
    done <= true;
    wait;
  end process;
end sim;
"""


def _run(args, cwd, timeout=120):
    p = subprocess.run([str(GHDL)] + args, cwd=str(cwd),
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def cosim(intent: dict, entity: str | None = None, keep: bool = False,
          cycles: int = 16, input_seq: list | None = None) -> dict:
    if not GHDL.exists():
        return {"ok": False, "error": f"GHDL not found at {GHDL}"}
    inn, outn = _names(intent)
    seq = is_sequential(intent)
    if len(inn) > 16 and not seq:
        return {"ok": False, "error": "too many inputs for exhaustive cosim"}
    ent = _san(entity or intent.get("module") or "ai_design")
    work = Path(tempfile.mkdtemp(prefix="cosim_"))
    (work / "dut.vhd").write_text(generate_vhdl(intent, entity=ent), encoding="utf-8")
    if seq:
        in_ids = build_graph(intent)[2]                 # IN component ids, in order
        stim = None
        if input_seq:
            stim = [[int(step.get(iid, 0)) & 1 for iid in in_ids] for step in input_seq]
            cycles = len(stim)
        tb = make_testbench_seq(intent, ent, cycles, stim)
    else:
        tb = make_testbench(intent, ent)
    (work / "tb.vhd").write_text(tb, encoding="utf-8")
    log = []
    for args in ([f"-a", f"--std={STD}", "dut.vhd", "tb.vhd"],
                 [f"-e", f"--std={STD}", "tb"],
                 [f"-r", f"--std={STD}", "tb"]):
        rc, out = _run(args, work)
        log.append("$ ghdl " + " ".join(args) + "\n" + out.strip()[-1500:])
        if rc != 0:
            if not keep:
                shutil.rmtree(work, ignore_errors=True)
            return {"ok": False, "error": f"ghdl {args[0]} failed rc={rc}",
                    "log": "\n\n".join(log)}
    outfile = work / "cosim_out.txt"
    if not outfile.exists():
        return {"ok": False, "error": "no cosim_out.txt", "log": "\n\n".join(log)}
    lines = [ln.strip().replace(" ", "") for ln in outfile.read_text(encoding="utf-8").splitlines()]
    mism = []
    if seq:
        # each line = output bits for one cycle; compare to simulate_sequential
        gh = [tuple(int(c) for c in s) for s in lines if s and all(c in "01" for c in s)]
        sr = simulate_sequential(intent, cycles=cycles, input_seq=input_seq)
        ref = [tuple(r["out"][o] for o in sr["outputs"]) for r in sr["rows"]]
        n = min(len(gh), len(ref))
        for i in range(n):
            if gh[i] != ref[i]:
                mism.append({"cycle": i, "got": list(gh[i]), "exp": list(ref[i])})
        ok = (not mism) and len(gh) >= len(ref)
        checked = len(ref)
        got_rows = len(gh)
    else:
        sim_rows = {}
        for s in lines:
            if len(s) != len(inn) + len(outn) or any(c not in "01" for c in s):
                continue
            sim_rows[tuple(int(x) for x in s[:len(inn)])] = tuple(int(x) for x in s[len(inn):])
        _, _, rows = truth_table(intent)
        for bits, obits in rows:
            got = sim_rows.get(tuple(bits))
            if got != tuple(obits):
                mism.append({"in": list(bits), "got": got, "exp": list(obits)})
        ok = (not mism) and len(sim_rows) == len(rows)
        checked = len(rows)
        got_rows = len(sim_rows)
    if not keep:
        shutil.rmtree(work, ignore_errors=True)
    return {"ok": ok, "checked": checked, "sim_rows": got_rows, "seq": seq,
            "mismatches": mism[:8], "log": None if ok else "\n\n".join(log)}


if __name__ == "__main__":
    import json
    import sys
    intent = json.load(open(sys.argv[1], encoding="utf-8"))
    r = cosim(intent, sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("-") else None)
    print(json.dumps({k: v for k, v in r.items() if k != "log"}, ensure_ascii=False, indent=2))
    if r.get("log") and "-v" in sys.argv:
        print(r["log"])
