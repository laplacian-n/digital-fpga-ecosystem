"""Writing the flash: openFPGALoader (MSYS2 build) failed with "Error: fail to open
…/Programs/FPGA Ecosystem/tools/openFPGALoader/spiOverJtag_xc7s15ftgb196.bit" — the install
folder has a space, and the bridge was passed as a full path.  python -m unittest discover -s tests"""
import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "launcher"))
import board  # noqa: E402


class FlashCmdTests(unittest.TestCase):
    def test_bridge_goes_by_its_bare_name_from_the_tools_folder(self):
        with tempfile.TemporaryDirectory() as t:
            tools = Path(t) / "FPGA Ecosystem" / "tools" / "openFPGALoader"
            tools.mkdir(parents=True)
            ofl = tools / "openFPGALoader.exe"; ofl.write_text("")
            bridge = tools / "spiOverJtag_xc7s15ftgb196.bit"; bridge.write_text("")
            bit = Path(t) / "build" / "top.bit"; bit.parent.mkdir(); bit.write_text("")
            cmd = board.flash_cmd(str(ofl), "ft2232", str(bridge), bit)
            self.assertEqual(cmd[:5], [str(ofl), "-c", "ft2232", "-f", "-B"])
            self.assertEqual(cmd[5], "spiOverJtag_xc7s15ftgb196.bit")     # no space, no drive, no slashes
            self.assertEqual(cmd[6], str(bit))                             # spaceless path kept as is

    def test_other_paths_are_kept_when_they_have_no_space(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "elsewhere" / "x.bit"
            self.assertEqual(board._cli_path(p, Path(t) / "tools"), str(p))


if __name__ == "__main__":
    unittest.main()
