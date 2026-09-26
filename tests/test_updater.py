"""Unit tests for launcher/updater.py version logic.  python -m unittest discover -s tests"""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "launcher"))
import updater  # noqa: E402


class VersionTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(updater.parse_version("v0.10.2"), (0, 10, 2))
        self.assertEqual(updater.parse_version("1.2"), (1, 2))
        self.assertEqual(updater.parse_version("nightly"), ())

    def test_newer(self):
        self.assertTrue(updater.is_newer("v0.2.0", "0.1.9"))
        self.assertTrue(updater.is_newer("0.10.0", "0.9.9"))       # numeric, not string compare
        self.assertTrue(updater.is_newer("1.0", "0.9.9"))
        self.assertFalse(updater.is_newer("0.1.0", "0.1"))         # 0.1 == 0.1.0
        self.assertFalse(updater.is_newer("v0.1.0", "0.2.0"))
        self.assertFalse(updater.is_newer("garbage", "0.1.0"))


if __name__ == "__main__":
    unittest.main()
