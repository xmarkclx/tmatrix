"""Offline regression checks for release isolation and archive contents."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage = load("stage-release")
verify = load("verify-release")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root
        (self.source / "src").mkdir()
        for name in ("tsconfig.build.json", "package.json", "package-lock.json",
                     "scripts/worktrees.py", "LICENSE"):
            path = self.source / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("fictional fixture")
        self.runtime = self.root / "staging/engine/dist/index.js"
        self.runtime.parent.mkdir(parents=True)
        self.runtime.write_text("live engine sentinel")
        self.old = self.root / "staging/release-engine/obsolete.js"
        self.old.parent.mkdir()
        self.old.write_text("stale release")

    def compiler(self, args, **kwargs):
        if "--outDir" in args:
            output = Path(args[args.index("--outDir") + 1])
            output.mkdir()
            (output / "index.js").write_text("// newly compiled")

    def go_output(self, args, **kwargs):
        return "tmatrix||" + str(self.root) if args[1] == "list" else str(self.source)

    def test_fresh_build_drops_stale_files_and_preserves_live_engine(self):
        (self.runtime.parent / "private.log").write_text("fictional private log")
        with patch.object(stage.subprocess, "run", side_effect=self.compiler), \
             patch.object(stage.subprocess, "check_output", side_effect=self.go_output):
            stage.prepare(self.root)
        self.assertFalse(self.old.exists())
        self.assertEqual(self.runtime.read_text(), "live engine sentinel")
        manifest = json.loads((self.root / "staging/release-manifest.json").read_text())
        self.assertIn("dist/index.js", manifest)
        self.assertNotIn("dist/private.log", manifest)

    def test_failed_compiler_preserves_previous_release_and_live_engine(self):
        with patch.object(stage.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "tsc")):
            with self.assertRaises(subprocess.CalledProcessError):
                stage.prepare(self.root)
        self.assertTrue(self.old.exists())
        self.assertEqual(self.runtime.read_text(), "live engine sentinel")

    def test_unexpected_compiler_file_rejected(self):
        def compiler(args, **kwargs):
            self.compiler(args, **kwargs)
            output = Path(args[args.index("--outDir") + 1])
            (output / "credentials").write_text("fictional")
        with patch.object(stage.subprocess, "run", side_effect=compiler):
            with self.assertRaisesRegex(RuntimeError, "Unexpected compiler output"):
                stage.prepare(self.root)
        self.assertTrue(self.old.exists())

    def archives(self, extra=False, symlink=False):
        (self.root / "staging/release-manifest.json").write_text('["dist/index.js"]')
        dist = self.root / "dist"
        dist.mkdir(exist_ok=True)
        for platform in ("linux", "darwin", "windows"):
            for arch in ("amd64", "arm64"):
                if platform == "windows":
                    with zipfile.ZipFile(dist / f"tmatrix_test_{platform}_{arch}.zip", "w") as bundle:
                        for name in ("README.md", "LICENSE", "engine/dist/index.js", "tmatrix.exe"):
                            bundle.writestr(name, "fixture")
                        if extra:
                            bundle.writestr("engine/credentials", "fictional")
                    continue
                with tarfile.open(dist / f"tmatrix_test_{platform}_{arch}.tar.gz", "w:gz") as bundle:
                    names = ["README.md", "LICENSE", "engine/dist/index.js",
                             "tmatrix.exe" if platform == "windows" else "tmatrix"]
                    if extra:
                        names.append("engine/credentials")
                    for name in names:
                        info = tarfile.TarInfo(name)
                        if symlink and name == "engine/dist/index.js":
                            info.type = tarfile.SYMTYPE
                            info.linkname = "/tmp/outside"
                        bundle.addfile(info, io.BytesIO())

    def test_archive_allowlist(self):
        self.archives()
        verify.verify(self.root)
        self.archives(extra=True)
        with self.assertRaisesRegex(RuntimeError, "allowlist"):
            verify.verify(self.root)

    def test_archive_symlink_rejected(self):
        self.archives(symlink=True)
        with self.assertRaisesRegex(RuntimeError, "Non-regular"):
            verify.verify(self.root)


if __name__ == "__main__":
    unittest.main()
