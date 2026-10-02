"""Q&A mode (/ask) answers with course notes: the question is found inside the editor's wrapped
payload, notes come in one fixed format (tools/dataset uses the same functions), and Thai question
words do not decide what is retrieved."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "ai"), str(ROOT / "ai" / "rag")]

import chat_server  # noqa: E402
import retriever  # noqa: E402


class AskNotes(unittest.TestCase):
    def test_query_is_the_last_question(self):
        p = "คุณคือผู้ช่วย\n\n[วงจรบนแผ่นที่ผู้ใช้กำลังทำอยู่]\nAND a b\n\n[คำถาม/คำสั่งล่าสุด]\nD latch คืออะไร"
        self.assertEqual(chat_server.ask_query(p), "D latch คืออะไร")
        self.assertEqual(chat_server.ask_query("setup time"), "setup time")

    def test_messages_carry_notes(self):
        hits = [{"topic": "D Latch", "source": "Ch_5.pdf", "text": "x " * 1000}]
        m = chat_server.ask_messages("D latch คืออะไร", hits)
        self.assertEqual(m[0]["content"], chat_server._ASK_SYS)
        u = m[1]["content"]
        self.assertTrue(u.startswith("[บันทึกจากเนื้อหาวิชา"))
        self.assertIn("1. D Latch · Ch_5.pdf", u)
        self.assertTrue(u.endswith("D latch คืออะไร"))
        self.assertLess(len(u), chat_server.ASK_NOTE_CHARS + 300)
        self.assertEqual(chat_server.ask_messages("q", [])[1]["content"], "q")

    def test_notes_failure_is_no_notes(self):
        old = chat_server.ASK_NOTES
        try:
            chat_server.ASK_NOTES = lambda q: 1 / 0
            self.assertEqual(chat_server._ask_hits("x"), [])
        finally:
            chat_server.ASK_NOTES = old

    def test_thai_question_words_do_not_rank(self):
        if not retriever.INDEX.exists():
            self.skipTest("RAG index not built")
        r = retriever.Retriever()
        top = r.search("latch กับ flip-flop ต่างกันยังไง", k=3, hybrid=False)
        self.assertTrue(all(h["group"] == "content" for h in top), top)
        self.assertTrue(retriever.tokenize_query("อะไร"))      # only question words: kept


if __name__ == "__main__":
    unittest.main()
