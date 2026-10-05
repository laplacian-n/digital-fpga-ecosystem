"""launcher/llm.py: download (resumable) + unpack llama.cpp, model download, from a local server."""
import http.server
import io
import os
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "launcher"))
import llm  # noqa: E402


class Handler(http.server.BaseHTTPRequestHandler):
    files = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = self.files.get(self.path)
        if body is None:
            self.send_response(404); self.end_headers(); return
        rng = self.headers.get("Range")
        start = int(rng.split("=")[1].rstrip("-")) if rng else 0
        self.send_response(206 if rng else 200)
        self.send_header("Content-Length", str(len(body) - start))
        self.end_headers()
        self.wfile.write(body[start:])


def wait():
    for _ in range(100):
        if not llm.DL.busy():
            return llm.DL.snapshot()
        time.sleep(0.05)
    raise AssertionError("download did not finish")


class LlmDownloads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("build/bin/" + llm.EXE, "#!/bin/sh\necho hi\n")
            z.writestr("../evil.txt", "nope")
        Handler.files["/llama.zip"] = buf.getvalue()
        Handler.files["/m.gguf"] = b"GGUF" + b"x" * 5000
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        llm.init(Path(self.tmp), Path(self.tmp) / "llama.log")

    def test_llama_is_downloaded_and_unpacked_safely(self):
        llm._llama_asset = lambda variant: (self.base + "/llama.zip", "llama-b1-bin-test.zip")
        self.assertTrue(llm.download_llama("cpu")["ok"])
        s = wait()
        self.assertEqual(s["phase"], "done", s)
        self.assertTrue(llm.find_server().endswith(llm.EXE))
        self.assertFalse((Path(self.tmp) / "evil.txt").exists())
        self.assertFalse((Path(self.tmp) / "llama" / "evil.txt").exists())

    def test_model_download_resumes_a_partial_file(self):
        llm.CATALOG.append({"id": "t", "name": "t", "size_gb": 0, "note": "", "file": "m.gguf", "url": self.base + "/m.gguf"})
        try:
            (Path(self.tmp) / "models").mkdir(parents=True)
            (Path(self.tmp) / "models" / "m.gguf.part").write_bytes(Handler.files["/m.gguf"][:1000])
            self.assertTrue(llm.download_model("t")["ok"])
            s = wait()
            self.assertEqual(s["phase"], "done", s)
            self.assertEqual((Path(self.tmp) / "models" / "m.gguf").read_bytes(), Handler.files["/m.gguf"])
            self.assertEqual(llm.installed_models(), [str(Path(self.tmp) / "models" / "m.gguf")])
        finally:
            llm.CATALOG.pop()

    def test_import_a_local_gguf_takes_the_catalog_name(self):
        src = Path(self.tmp) / "dl" / "QWEN3.5-4b-sft1.gguf"
        src.parent.mkdir()
        src.write_bytes(b"GGUF" + os.urandom(20000))
        r = llm.import_model('"%s"' % src)                     # pasted from Explorer, with quotes
        self.assertTrue(r["ok"], r)
        self.assertEqual(wait()["phase"], "done")
        dst = Path(self.tmp) / "models" / "qwen3.5-4B-SFT1.gguf"
        self.assertEqual(dst.read_bytes(), src.read_bytes())
        self.assertTrue(llm.import_model(str(src)).get("already"))
        self.assertFalse(llm.download_model("qwen3.5-4b-sft1")["ok"])          # no url: import only
        self.assertEqual(llm.preferred_model([str(Path(self.tmp) / "models" / "a.gguf"), str(dst)]), str(dst))

    def test_import_refuses_what_is_not_gguf(self):
        bad = Path(self.tmp) / "x.gguf"
        bad.write_bytes(b"MZ\x90\x00 not a model")
        self.assertFalse(llm.import_model(str(bad))["ok"])
        self.assertFalse(llm.import_model(str(Path(self.tmp) / "none.gguf"))["ok"])

    def test_start_refuses_without_files(self):
        self.assertFalse(llm.start("", "", "http://127.0.0.1:8080/v1", "")["ok"])
        self.assertEqual(llm.state("http://127.0.0.1:9/v1"), "stopped")


if __name__ == "__main__":
    unittest.main()
