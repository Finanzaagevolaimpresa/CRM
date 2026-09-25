import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("transport", Path(__file__).with_name("split_qualified_images.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def test_parts_reconstruct_exact_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)/"source"; data = bytes(range(256))*3
            source.write_bytes(data)
            manifest = m.split(source, Path(root)/"out", hashlib.sha256(data).hexdigest(), 500)
            self.assertEqual(len(manifest["parts"]), 2)
            self.assertEqual(b"".join((Path(root)/"out"/p["file"]).read_bytes() for p in manifest["parts"]), data)

    def test_wrong_archive_creates_no_output(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)/"source"; source.write_bytes(b"wrong")
            with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
                m.split(source, Path(root)/"out", "0"*64, 100)
            self.assertFalse((Path(root)/"out").exists())

    def test_occupied_destination_is_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)/"source"; source.write_bytes(b"fixture")
            out = Path(root)/"out"; out.mkdir(); (out/"preserve").write_text("existing")
            with self.assertRaises(FileExistsError):
                m.split(source, out, m.digest(source), 100)
            self.assertEqual((out/"preserve").read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
