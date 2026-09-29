"""The RAG paths of ai/intent_client add the library context as a second system message; Qwen3.5's
chat template refuses that (HTTP 500 "System message must be at the beginning"). A fake server
with the same rule: every path must reach it with exactly one system message, first."""
import http.server
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai"))
import intent_client  # noqa: E402


class Strict(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        msgs = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["messages"]
        roles = [m["role"] for m in msgs]
        if roles.count("system") > 1 or (roles.count("system") and roles[0] != "system"):
            b = b'{"error":{"message":"System message must be at the beginning."}}'
            self.send_response(500)
        else:
            out = ("```vhdl\nlibrary IEEE;\nuse IEEE.STD_LOGIC_1164.ALL;\nentity ha is port(a,b: in std_logic; "
                   "s,c: out std_logic); end;\narchitecture rtl of ha is begin s <= a xor b; c <= a and b; end;\n```")
            b = json.dumps({"choices": [{"message": {"content": out}}]}).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class OneSystemMessage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Strict)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.ep = f"http://127.0.0.1:{cls.srv.server_port}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_rag_context_is_folded_into_the_first_system_message(self):
        old = intent_client.retrieve_context
        intent_client.retrieve_context = lambda *a, **k: "half adder: s = a xor b, c = a and b"
        try:
            r = intent_client.generate_vhdl_from_spec("half adder", endpoint=self.ep, use_rag=True)
        finally:
            intent_client.retrieve_context = old
        self.assertTrue(r.get("ok"), r)
        self.assertIn("xor", r["vhdl"])

    def test_merge_keeps_no_think_last(self):
        m = intent_client.one_system_message([{"role": "system", "content": "A\n/no_think"},
                                              {"role": "system", "content": "CTX"}, {"role": "user", "content": "q"}])
        self.assertEqual([x["role"] for x in m], ["system", "user"])
        self.assertTrue(m[0]["content"].endswith("/no_think"))
        self.assertIn("CTX", m[0]["content"])


if __name__ == "__main__":
    unittest.main()
