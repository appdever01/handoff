import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).with_name("bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        files = [*("backend/" + name for name in bundle.BACKEND_FILES),
                 "backend/src/server.ts", "backend/packages/contracts/index.ts",
                 "backend/deploy/README.md", "frontend/dist/index.html",
                 "frontend/dist/assets/main.js", "frontend/deploy/Caddyfile",
                 "frontend/src/App.tsx", "frontend/index.html", "frontend/vite.config.ts",
                 "frontend/package.json", "frontend/package-lock.json"]
        for name in files:
            self.write(name, "test release input")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def test_excludes_credentials_data_and_cache(self):
        for name in ["backend/deploy/.env", "backend/deploy/ops.env", "backend/deploy/.env.production", "backend/deploy/secrets/worker", "backend/deploy/private.key", "backend/src/__pycache__/cache.pyc", "frontend/dist/.env", "backend/.data/original.bin"]:
            self.write(name, "private-do-not-package")
        self.write("backend/deploy/release.env.example", "EXAMPLE=1")
        release, entries = bundle.assemble(self.root)
        self.assertEqual(len(release), 16)
        self.assertIn("backend/deploy/release.env.example", entries)
        self.assertFalse(any(b"private-do-not-package" in content for content, _ in entries.values()))

    def test_archive_is_deterministic_and_hashes_inputs(self):
        release, entries = bundle.assemble(self.root)
        first, second = self.root / "first.tgz", self.root / "second.tgz"
        bundle.write_bundle(first, entries)
        bundle.write_bundle(second, entries)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            manifest = json.load(archive.extractfile("manifest.json"))
        self.assertIn("frontend/dist/index.html", manifest["files"])
        self.assertIn("frontend/src/App.tsx", manifest["frontendSource"])
        self.write("backend/src/server.ts", "changed server")
        self.assertNotEqual(release, bundle.assemble(self.root)[0])

    def test_refuses_symlink_and_missing_frontend_output(self):
        target = self.root / "backend/src/secret.ts"
        target.symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            bundle.assemble(self.root)
        target.unlink()
        (self.root / "frontend/dist/index.html").unlink()
        with self.assertRaises(ValueError):
            bundle.assemble(self.root)


if __name__ == "__main__":
    unittest.main()
