"""ai/intent_client.restate_spec + the chat server's VHDL path: a Thai request is restated in
English first (against a fake OpenAI-compatible endpoint)."""
import http.server
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai"))
import intent_client  # noqa: E402

SEEN = []


class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        sys_p = body["messages"][0]["content"]
        if "precise ENGLISH hardware specification" in sys_p:
            out = "Module: bcd_limit\nInputs: SW[8]\nOutputs: yy[8]\nBehaviour: combinational, yy = SW."
        else:
            out = ("```vhdl\nlibrary IEEE;\nuse IEEE.STD_LOGIC_1164.ALL;\nentity bcd_limit is port(SW: in "
                   "std_logic_vector(7 downto 0); yy: out std_logic_vector(7 downto 0)); end;\n"
                   "architecture rtl of bcd_limit is begin yy <= SW; end;\n```")
        b = json.dumps({"choices": [{"message": {"content": out}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class RestateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.ep = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_thai_is_detected(self):
        self.assertTrue(intent_client.needs_restate("อินพุตเป็นสวิตช์ 8 ตัว"))
        self.assertFalse(intent_client.needs_restate("4-bit counter with enable"))

    def test_restate_returns_english_spec(self):
        r = intent_client.restate_spec("อินพุตเป็นสวิตช์ 8 ตัว SW[7:4] หลักสิบ", endpoint=self.ep)
        self.assertTrue(r["ok"])
        self.assertIn("Inputs: SW[8]", r["spec"])

    def test_chat_vhdl_path_sends_the_restatement(self):
        import chat_server
        SEEN.clear()
        # the endpoint is baked into keyword defaults (app.set_llm_endpoint rewrites them the same way)
        fns = (intent_client.restate_spec, intent_client.generate_vhdl_from_spec)
        saved = [dict(f.__kwdefaults__) for f in fns]
        try:
            for f in fns:
                f.__kwdefaults__["endpoint"] = self.ep
            out = chat_server._run_llm_vhdl("อินพุตเป็นสวิตช์ 8 ตัว กำหนดค่า yy")
        finally:
            for f, kw in zip(fns, saved):
                f.__kwdefaults__.update(kw)
        self.assertEqual(out["status"], "DRAWN")
        self.assertIn("Module: bcd_limit", out["restated"])
        self.assertEqual([e["stage"] for e in out["evidence"]], ["translate", "generate-vhdl"])
        # the VHDL request carries the English spec first
        self.assertTrue(SEEN[-1]["messages"][-1]["content"].startswith("Module: bcd_limit"))


if __name__ == "__main__":
    unittest.main()
