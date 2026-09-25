"""
intent_validate.py — server-side (Python hub) mirror of validateIntent() in
schematic&bus2vhdl.html. Same error CODES and hint style so the retry loop can
feed hints straight back to the model, and so the hub rejects a bad topology
BEFORE it ever reaches the editor (validate-then-apply / ERC gate).

Keep this in lock-step with the JS. Source of truth = the HTML editor's
validateIntent / INTENT_TYPES / INTENT_GATES / INTENT_SOURCES.

Intent schema v1 (topology only — NO x/y/pts):
    {
      "module":     "full_adder",          # optional
      "components": [{"id","type","name"?,"label"?,"params"?}, ...],
      "nets":       [{"from","to"}, ...]    # from/to = "id" or "id.pin"
    }
"""
from __future__ import annotations
from typing import Any

# --- kept identical to the editor's constants -------------------------------
INTENT_GATES = {"AND": 0, "OR": 0, "XOR": 0, "NAND": 0, "NOR": 0,
                "XNOR": 0, "NOT": 1, "BUF": 1}          # value = fixed arity (0 = variadic)
INTENT_SOURCES = {"IN", "VCC", "GND", "CONST"}          # output pin only, no inputs
INTENT_SEQ = {"DFF"}                                     # v2: rising-edge D flip-flop (pins d/en/arst, out q)
INTENT_DFF_PINS = {"d", "en", "arst"}
INTENT_TYPES = {"IN", "OUT", "VCC", "GND", "CONST",
                "AND", "OR", "XOR", "NAND", "NOR", "XNOR", "NOT", "BUF", "DFF"}


def _ref(s: Any) -> dict:
    """'id' or 'id.pin' -> {'id','pin'}  (mirrors intentRef)."""
    t = ("" if s is None else str(s)).strip()
    d = t.find(".")
    return {"id": t, "pin": None} if d < 0 else {"id": t[:d], "pin": t[d + 1:]}


def validate_intent(intent: Any) -> dict:
    """Return {'ok': bool, 'errors': [{code,msg,hint}], 'warns': [str]}."""
    errors: list[dict] = []
    warns: list[str] = []

    def E(code: str, msg: str, hint: str = "") -> None:
        errors.append({"code": code, "msg": msg, "hint": hint})

    if not isinstance(intent, dict) or not isinstance(intent.get("components"), list):
        E("NO_COMPONENTS", "intent.components ต้องเป็น array", "ใส่ components:[{id,type},...]")
        return {"ok": False, "errors": errors, "warns": warns}

    by_id: dict[str, dict] = {}
    for i, c in enumerate(intent["components"]):
        if not isinstance(c, dict) or not c.get("id"):
            E("BAD_ID", f"component [{i}] ไม่มี id", "ทุก component ต้องมี id ที่ไม่ซ้ำ")
            continue
        cid = c["id"]
        if cid in by_id:
            E("DUP_ID", f"id ซ้ำ: {cid}", "ตั้ง id ให้ไม่ซ้ำกัน")
            continue
        if c.get("type") not in INTENT_TYPES:
            E("BAD_TYPE", f"type ไม่รู้จัก: {c.get('type')} (id={cid})",
              "ใช้ได้: " + ", ".join(sorted(INTENT_TYPES)))
        by_id[cid] = c

    nets = intent.get("nets") if isinstance(intent.get("nets"), list) else []
    in_count: dict[str, int] = {}
    dff_has_d: dict[str, bool] = {}
    for i, n in enumerate(nets):
        f, t = _ref(n.get("from")), _ref(n.get("to"))
        fc, tc = by_id.get(f["id"]), by_id.get(t["id"])
        if not fc:
            E("NET_FROM_MISSING", f"net[{i}] from ชี้ component ที่ไม่มี: {f['id']}",
              "สร้าง component นี้ หรือแก้ id")
            continue
        if not tc:
            E("NET_TO_MISSING", f"net[{i}] to ชี้ component ที่ไม่มี: {t['id']}",
              "สร้าง component นี้ หรือแก้ id")
            continue
        if fc.get("type") == "OUT":
            E("NET_FROM_OUTPUT", f"net[{i}] from เป็น OUT ({f['id']}) ที่ไม่มีขาออก",
              "OUT รับสัญญาณอย่างเดียว — from ต้องเป็น gate/IN/DFF")
        if tc.get("type") in INTENT_SOURCES:
            E("NET_TO_SOURCE", f"net[{i}] to เป็น {tc.get('type')} ({t['id']}) ที่ไม่มีขาเข้า",
              "ปลายทางต้องเป็น gate/OUT/DFF")
        if tc.get("type") in INTENT_SEQ:
            pin = t["pin"] or "d"
            if pin not in INTENT_DFF_PINS:
                E("DFF_BAD_PIN", f"net[{i}] to {t['id']}.{pin} ไม่ใช่ขาของ DFF",
                  "ขา DFF ใช้ได้: d, en, arst (เช่น ff.d)")
            if pin == "d":
                dff_has_d[t["id"]] = True
        in_count[t["id"]] = in_count.get(t["id"], 0) + 1

    for c in intent["components"]:
        if not isinstance(c, dict):
            continue
        cid, ctype = c.get("id"), c.get("type")
        if ctype == "OUT" and not in_count.get(cid):
            warns.append(f"OUT {cid} ไม่มีสัญญาณเข้า")
        if ctype in INTENT_GATES:
            n, fixed = in_count.get(cid, 0), INTENT_GATES[ctype]
            if n == 0:
                E("GATE_NO_INPUT", f"gate {cid} ({ctype}) ไม่มี input",
                  "ต่อสายเข้า gate นี้อย่างน้อย 1 เส้น")
            if fixed == 1 and n > 1:
                E("GATE_ARITY", f"{ctype} {cid} รับ input ได้ตัวเดียว แต่ได้ {n}", "NOT/BUF มีขาเดียว")
        if ctype in INTENT_SEQ and not dff_has_d.get(cid):
            E("DFF_NO_D", f"DFF {cid} ไม่มีสัญญาณเข้าขา d", "ต่อสายเข้า <id>.d (เช่น g -> ff.d)")

    return {"ok": len(errors) == 0, "errors": errors, "warns": warns}


def hints_for_retry(result: dict) -> str:
    """Compact error+hint block to append to the model prompt on a retry."""
    lines = []
    for e in result.get("errors", []):
        h = f"  → {e['hint']}" if e.get("hint") else ""
        lines.append(f"[{e['code']}] {e['msg']}{h}")
    return "\n".join(lines)


if __name__ == "__main__":
    import json
    import sys
    data = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {
        "module": "demo", "components": [{"id": "a", "type": "IN"}], "nets": []}
    r = validate_intent(data)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    sys.exit(0 if r["ok"] else 1)
