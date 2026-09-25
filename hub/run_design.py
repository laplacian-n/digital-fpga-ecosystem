"""
hub/run_design.py - the HUB orchestrator: run the AI pipeline (ai/pipeline.py) but
persist every stage into the durable Store as evidence + immutable artifacts, with
a job record. This is where the standalone ai/ scripts become a real hub over
durable state (the Foundation is now actually used, not orphaned).

  run_design(spec|intent) -> {uid, status, stages, artifacts}
  ...and the stage_state survives restart; re-running after a semantic edit shows
  stale stages via the hash chain.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))                 # hub modules
sys.path.insert(0, str(HERE.parent / "ai"))   # ai pipeline

import ir as IR
from store import Store
from errors import err
import pipeline as P            # ai/pipeline.py


# map an ai/pipeline evidence stage -> (store stage, artifact kind or None)
_STAGE_MAP = {"generate": ("design", None), "validate": ("design", None),
              "simulate": ("sim", None), "verify": ("sim", None),
              "codegen": ("vhdl", "vhdl"), "cosim": ("cosim", None),
              "draw": ("draw", "schproj"), "synth": ("synth", "bit")}


def run_design(spec: str = "", *, intent: dict | None = None, uid: str | None = None,
               store: Store | None = None, **kw) -> dict:
    st = store or Store()
    jid = st.create_job("run_design", uid)
    try:
        res = P.run(spec, intent=intent, verbose=kw.pop("verbose", True), **kw)
        # derive the IR from whatever intent the pipeline settled on
        used_intent = res.get("intent") or intent or {}
        design_uid = uid or ("d_" + IR.semantic_hash(IR.intent_to_ir(used_intent))[:10]) \
            if used_intent else (uid or "d_unknown")
        if used_intent:
            ir = IR.intent_to_ir(used_intent, provenance={"by": "hub", "status": res["status"]})
            st.save_design(ir, design_uid)
        # record each pipeline stage as durable evidence + artifacts
        seen = {}
        for e in res.get("evidence", []):
            m = _STAGE_MAP.get(e["stage"])
            if not m:
                continue
            store_stage, _ = m
            ok = e.get("ok", True)
            # keep the worst status per store-stage
            prev = seen.get(store_stage)
            status = "passed" if ok else "failed"
            if prev == "failed":
                status = "failed"
            seen[store_stage] = status
            st.record_stage(design_uid, store_stage, status, evidence=e)
        st.record_stage(design_uid, "design", "passed",
                        evidence={"status": res["status"]})
        # artifacts (paths the pipeline wrote)
        arts = {}
        for key, kind in (("vhdl_path", "vhdl"), ("xdc_path", "xdc"),
                          ("bitstream_path", "bit")):
            if res.get(key):
                st.put_artifact(design_uid, kind, path=res[key])
                arts[kind] = res[key]
        draw = res.get("draw") or {}
        if draw.get("schproj"):
            st.put_artifact(design_uid, "schproj", path=draw["schproj"],
                            data={"guarantees": draw.get("guarantees")})
            arts["schproj"] = draw["schproj"]
        out = {"uid": design_uid, "status": res["status"], "verified": res.get("verified"),
               "cosim": res.get("cosim"), "artifacts": arts,
               "stages": st.stage_state(design_uid)}
        st.finish_job(jid, "done", result={"uid": design_uid, "status": res["status"]})
        return out
    except Exception as ex:
        st.finish_job(jid, "error", error=err("JOB-ORPHANED", str(ex)))
        raise


if __name__ == "__main__":
    spec = " ".join(sys.argv[1:]) or "sum = a xor b xor cin ; cout = a*b + (a xor b)*cin"
    r = run_design(spec, module="full_adder", use_cosim=True, use_synth=False,
                   use_editor=False, out_dir=str(HERE.parent / "ai" / "out"))
    print("\n== HUB run ==")
    print("uid:", r["uid"], "status:", r["status"])
    print("artifacts:", json.dumps(r["artifacts"], ensure_ascii=False))
    print("stages:", {k: v["status"] for k, v in r["stages"].items()})
