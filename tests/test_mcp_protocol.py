"""MCP protocol surface of launcher/mcp_server.py (no app needed).  python -m unittest discover -s tests"""
import json, subprocess, sys, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "launcher"))
import mcp_server as M  # noqa: E402


class Protocol(unittest.TestCase):
    def test_initialize_negotiates_version(self):
        r = M.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}})
        self.assertEqual(r["result"]["protocolVersion"], "2024-11-05")
        r = M.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(r["result"]["protocolVersion"], M.PROTOCOLS[0])
        self.assertIn("tools", r["result"]["capabilities"])
        self.assertIn("Schematic Studio", r["result"]["instructions"])

    def test_tools_are_well_formed(self):
        tools = M.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        names = [t["name"] for t in tools]
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(tools), 35)
        for t in tools:
            self.assertTrue(t["description"], t["name"])
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertNotIn("_timeout", t)                   # internal fields never leak
            for req in t["inputSchema"].get("required", []):
                self.assertIn(req, t["inputSchema"]["properties"], t["name"])

    def test_every_editor_tool_has_an_editor_op(self):
        js = "\n".join(p.read_text("utf-8") for p in (ROOT / "editor" / "ux").glob("*.js"))
        for t in M.TOOLS:
            if t["name"] in M.LOCAL_TOOLS:
                continue
            self.assertIn(f"MCP_OPS.{t['name']} =", js, f"tool {t['name']} has no MCP_OPS handler in the editor")

    def test_prompts_resources_and_errors(self):
        p = M.handle({"jsonrpc": "2.0", "id": 1, "method": "prompts/get", "params": {"name": "design_from_spec", "arguments": {"spec": "full adder"}}})
        self.assertIn("full adder", p["result"]["messages"][0]["content"]["text"])
        g = M.handle({"jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": {"uri": "fpga://guide"}})
        self.assertIn("Schematic Studio", g["result"]["contents"][0]["text"])
        e = M.handle({"jsonrpc": "2.0", "id": 3, "method": "no/such"})
        self.assertEqual(e["error"]["code"], -32601)
        self.assertIsNone(M.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        bad = M.call_tool("nope", {})
        self.assertTrue(bad["isError"])

    def test_stdio_roundtrip(self):
        msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        out = subprocess.run([sys.executable, str(ROOT / "launcher" / "mcp_server.py")],
                             input="\n".join(json.dumps(m) for m in msgs) + "\n",
                             capture_output=True, text=True, timeout=30, encoding="utf-8")
        lines = [json.loads(l) for l in out.stdout.splitlines() if l.strip()]
        self.assertEqual(sorted(l["id"] for l in lines), [1, 2])       # only protocol on stdout
        self.assertTrue(any("tools" in l.get("result", {}) for l in lines))


if __name__ == "__main__":
    unittest.main()
