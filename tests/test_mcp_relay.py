"""The launcher's MCP relay and the MCP server's argument checks (no editor needed).
python -m unittest discover -s tests"""
import sys, threading, time, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "launcher"))
import app  # noqa: E402
import mcp_server as M  # noqa: E402


class Relay(unittest.TestCase):
    def test_a_long_job_does_not_hang_the_next_call(self):
        """auto_layout of a big sheet froze the page for minutes; request_approval behind it hung
        and the page looked closed (it cannot poll while it works)."""
        R = app.McpRelay()
        R.BUSY_WAIT = 0.5
        R.seen["pg"] = time.time()
        got = {}

        def page():                                   # picks up the slow job, then "freezes"
            job = R.poll("pg", wait=5)
            got["job"] = job["op"]
            time.sleep(3)
            R.result({"id": job["id"], "ok": True, "result": "laid out"})

        threading.Thread(target=page, daemon=True).start()
        slow = {}
        threading.Thread(target=lambda: slow.update(r=R.call("auto_layout", {}, timeout=10)), daemon=True).start()
        time.sleep(0.3)
        R.seen["pg"] = time.time() - 100               # no polls while it works: still counts as open
        self.assertEqual(R.live_client(), "pg")
        t0 = time.time()
        r = R.call("request_approval", {"summary": "x"}, timeout=10)
        self.assertLess(time.time() - t0, 3)           # answered, not hung behind the layout
        self.assertFalse(r["ok"])
        self.assertIn("busy with 'auto_layout'", r["error"])
        self.assertEqual(R.jobs["pg"], [])             # and it was not left queued to run later
        time.sleep(3.2)
        self.assertEqual(slow["r"]["result"], "laid out")

    def test_late_answers_are_not_kept(self):
        R = app.McpRelay()
        R.result({"id": "j99", "ok": True})
        self.assertEqual(R.replies, {})

    def test_a_call_that_timed_out_can_fetch_its_answer(self):
        """Lab 7: build_hierarchy of a big top sheet ran past 120 s; the build finished but its
        report (unconnected / undriven) was lost, and the call was sent again."""
        R = app.McpRelay()
        R.seen["pg"] = time.time()

        def page():
            job = R.poll("pg", wait=5)
            time.sleep(1.5)
            R.result({"id": job["id"], "ok": True, "result": {"sheet": "top", "undriven_outputs": []}})

        threading.Thread(target=page, daemon=True).start()
        r = R.call("build_hierarchy", {}, timeout=0.5)
        self.assertFalse(r["ok"])
        self.assertIn("last_result", r["hint"])
        self.assertFalse(R.last_result(job=r["job"])["ok"])          # not done yet
        time.sleep(1.5)
        got = R.last_result(job=r["job"])
        self.assertTrue(got["ok"])
        self.assertEqual(got["reply"]["result"]["sheet"], "top")
        self.assertEqual(R.last_result(op="build_hierarchy")["job"], r["job"])
        old, app.RELAY = app.RELAY, R                     # the MCP tool goes through the app's /api/mcp/app
        try:
            self.assertEqual(app.mcp_app("last_result", {"job": r["job"]})["op"], "build_hierarchy")
        finally:
            app.RELAY = old


class Rag(unittest.TestCase):
    def test_course_notes_are_searchable(self):
        """The index is built from what ships with the app when it is missing (it is not in git)."""
        r = app.rag_search("7-segment decoder BCD", k=3, group="lab")
        self.assertTrue(r["ok"], r)
        self.assertGreater(r["records"], 200)
        self.assertEqual(len(r["hits"]), 3)
        self.assertTrue(all(h["group"] == "lab" and h["text"] for h in r["hits"]))
        b = app.rag_search("clock 50 MHz pin", k=2, group="board")
        self.assertIn("H11", " ".join(h["text"] for h in b["hits"]))
        self.assertIn("search_course", M.AGENT_TOOLS)


class Args(unittest.TestCase):
    def test_aliases_and_unknown_fields(self):
        a, e = M.normalize_args("delete", {"target": "el"})
        self.assertIsNone(e)
        self.assertEqual(a, {"refs": ["el"]})
        a, e = M.normalize_args("delete", {"components": ["a", "b"], "sheet": "top"})
        self.assertEqual(a["refs"], ["a", "b"])
        _, e = M.normalize_args("delete", {"whatever": 1})
        self.assertIn("unknown field 'whatever'", e)
        self.assertIn("refs* (array)", e)
        _, e = M.normalize_args("connect", {"from": "a", "to": "b", "color": "red"})
        self.assertIn("connect takes:", e)

    def test_arrays_and_objects_sent_as_json_text(self):
        """Lab 7: delete {refs:'["an[3]","an[2]"]'} looked for ONE component named '["an[3]",…]'."""
        a, e = M.normalize_args("delete", {"refs": '["an[3]", "an[2]"]'})
        self.assertIsNone(e)
        self.assertEqual(a["refs"], ["an[3]", "an[2]"])
        a, _ = M.normalize_args("set_pins", {"map": '{"an[3]": null}'})
        self.assertEqual(a["map"], {"an[3]": None})
        a, _ = M.normalize_args("delete", {"refs": "g1"})
        self.assertEqual(a["refs"], ["g1"])
        a, _ = M.normalize_args("build_part", {"kind": "bcd_counter_multi", "params": '{"format": "mm.ss"}'})
        self.assertEqual(a["params"], {"format": "mm.ss"})

    def test_apply_steps_are_checked_and_normalised(self):
        a, e = M.normalize_args("apply", {"steps": [{"op": "delete", "target": "el"}, {"op": "connect", "from": "x", "to": "y"}]})
        self.assertIsNone(e)
        self.assertEqual(a["steps"][0], {"op": "delete", "refs": ["el"]})
        _, e = M.normalize_args("apply", {"steps": [{"op": "connect", "from": "x", "too": "y"}]})
        self.assertIn("apply step 1: connect: unknown field 'too'", e)
        _, e = M.normalize_args("apply", {"steps": [{"op": "auto_layout"}]})
        self.assertIn("op must be one of", e)
        self.assertIn("delete: refs* (array)", M.TOOL_MAP["apply"]["description"])


if __name__ == "__main__":
    unittest.main()
