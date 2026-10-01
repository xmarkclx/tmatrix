"""Offline checks: no actual build, tag push, release, or service is invoked."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("release_local", Path(__file__).with_name("release-local.py"))
release_local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_local)


class LocalReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "dist").mkdir()
        for os_name in ("linux", "darwin", "windows"):
            for arch in ("amd64", "arm64"):
                suffix = "zip" if os_name == "windows" else "tar.gz"
                (self.root / "dist" / f"tmatrix_1.2.3_{os_name}_{arch}.{suffix}").touch()
        self.calls = []
        self.head = "0123456789abcdef0123456789abcdef01234567"
        self.dirty = ""
        self.shallow = "false"
        self.tagged = self.head
        self.tags = "v1.2.3"
        self.failure = None
        self.head_reads = 0

    def fake_run(self, args, root, env, capture=False):
        self.calls.append(args)
        if self.failure and self.failure in args:
            raise subprocess.CalledProcessError(1, args)
        if args == ["git", "rev-parse", "--is-shallow-repository"]:
            return self.shallow
        if args == ["git", "status", "--porcelain"]:
            return self.dirty
        if args == ["git", "rev-parse", "HEAD"]:
            self.head_reads += 1
            return self.head
        if args[:3] == ["git", "rev-parse", "--verify"]:
            return self.tagged
        if args[:3] == ["git", "tag", "--points-at"]:
            return self.tags
        if args == ["git", "rev-list", "--count", "HEAD"]:
            return "42"
        if args[:3] == ["git", "remote", "get-url"]:
            return "https://github.com/fixture/tmatrix.git"
        if args[:3] == ["gh", "repo", "view"]:
            self.assertEqual(args[3], "https://github.com/fixture/tmatrix.git")
            return "fixture/tmatrix"
        if args[:2] == ["goreleaser", "release"]:
            self.assertEqual(env["TMATRIX_COMMIT_COUNT"], "42")
        return ""

    def release(self, upload=False):
        with patch.object(release_local.shutil, "which", return_value="/fixture/tool"), \
             patch.object(release_local, "run", side_effect=self.fake_run), \
             patch("builtins.print"):
            release_local.release("v1.2.3", upload, self.root)

    def test_build_only_never_pushes_or_uploads(self):
        self.release()
        self.assertTrue(any("scripts/verify-release.py" in args for args in self.calls))
        self.assertFalse(any(args[0] == "gh" or args[:2] == ["git", "push"] for args in self.calls))

    def test_verified_build_precedes_tag_push_and_draft_upload(self):
        self.release(upload=True)
        verify = next(i for i, args in enumerate(self.calls) if "scripts/verify-release.py" in args)
        push = self.calls.index(["git", "push", "origin", "refs/tags/v1.2.3"])
        upload = next(i for i, args in enumerate(self.calls) if args[:3] == ["gh", "release", "create"])
        self.assertLess(verify, push)
        self.assertLess(push, upload)
        args = self.calls[upload]
        self.assertIn("--draft", args)
        self.assertIn("--verify-tag", args)
        self.assertIn("fixture/tmatrix", args)
        self.assertIn("TMatrix v1.2.3 (build 42, 0123456789ab)", args)
        self.assertEqual(sum(arg.endswith((".tar.gz", ".zip")) for arg in args), 6)
        self.assertIn("scripts/install.sh", args)
        self.assertNotIn("--clobber", args)

    def test_failed_checks_or_archive_verification_prevent_remote_writes(self):
        for failure in ("check", "scripts/test_install.py", "audit", "scripts/verify-release.py"):
            with self.subTest(failure=failure):
                self.calls = []
                self.failure = failure
                with self.assertRaises(subprocess.CalledProcessError):
                    self.release(upload=True)
                self.assertFalse(any(args[:2] == ["git", "push"] or args[:3] == ["gh", "release", "create"]
                                     for args in self.calls))

    def test_dirty_shallow_wrong_or_ambiguous_tag_blocks_build(self):
        for attribute, value in (("dirty", " M source"), ("shallow", "true"),
                                 ("tagged", "different"), ("tags", "v1.2.3\nv1.2.4")):
            with self.subTest(attribute=attribute):
                original = getattr(self, attribute)
                setattr(self, attribute, value)
                self.calls = []
                with self.assertRaises(RuntimeError):
                    self.release(upload=True)
                self.assertFalse(any(args[0] in ("npm", "goreleaser") for args in self.calls))
                setattr(self, attribute, original)

    def test_source_change_after_checks_prevents_packaging(self):
        original = self.fake_run

        def changed(args, root, env, capture=False):
            if self.head_reads == 1 and args == ["git", "rev-parse", "HEAD"]:
                self.head = self.tagged = "new-commit"
            return original(args, root, env, capture)

        with patch.object(release_local.shutil, "which", return_value="/fixture/tool"), \
             patch.object(release_local, "run", side_effect=changed), \
             self.assertRaisesRegex(RuntimeError, "Source changed"):
            release_local.release("v1.2.3", True, self.root)
        self.assertFalse(any(args[:2] == ["goreleaser", "release"] for args in self.calls))

    def test_failed_push_does_not_upload(self):
        self.failure = "push"
        with self.assertRaises(subprocess.CalledProcessError):
            self.release(upload=True)
        self.assertFalse(any(args[:3] == ["gh", "release", "create"] for args in self.calls))

    def test_invalid_tag_rejected_before_running_any_command(self):
        with patch.object(release_local, "run") as run:
            with self.assertRaises(RuntimeError):
                release_local.release("main", root=self.root)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
