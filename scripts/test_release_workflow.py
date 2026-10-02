"""Offline release orchestration checks; never publish or touch a real service."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("release_workflow", Path(__file__).with_name("release.py"))
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.calls = []
        self.failure = None

    def fake_run(self, args, root, env, capture=False):
        self.calls.append(args)
        if self.failure and self.failure(args):
            raise subprocess.CalledProcessError(1, args)
        if args[:3] == ["git", "remote", "get-url"]:
            return "https://github.com/fixture/tmatrix.git"
        if args[:3] == ["gh", "repo", "view"]:
            self.assertEqual(args[3], "https://github.com/fixture/tmatrix.git")
            return '{"nameWithOwner":"fixture/tmatrix","defaultBranchRef":{"name":"main"}}'
        if args[:3] == ["gh", "release", "view"]:
            return "v1.2.3"
        if args[:3] == ["gh", "release", "download"]:
            directory = Path(args[args.index("--dir") + 1])
            (directory / "install.sh").write_text("#!/bin/sh\nexit 0\n")
        return ""

    def release(self, **kwargs):
        with patch.object(workflow.shutil, "which", return_value="/fixture/tool"), \
             patch.object(workflow.sys, "platform", "linux"), \
             patch.dict(os.environ, {"GH_REPO": "unrelated/repo", "TMATRIX_PREFIX": ""}), \
             patch.object(workflow, "run", side_effect=self.fake_run), \
             patch.object(workflow, "prepare", return_value=kwargs.get("tag") or "v1.2.3") as prepare, patch("builtins.print"):
            workflow.release(root=self.root, **kwargs)
        return prepare

    def test_default_command_uses_automatically_prepared_version_through_install(self):
        prepare = self.release()
        self.assertIsNone(prepare.call_args.args[0])
        self.assertIn([workflow.sys.executable, "scripts/release-local.py", "v1.2.3", "--upload"], self.calls)
        self.assertIn(["gh", "release", "edit", "v1.2.3", "--repo", "fixture/tmatrix", "--draft=false", "--latest"], self.calls)
        self.assertEqual(next(args for args in self.calls if args[0] == "sh")[2:],
                         ["--repo", "fixture/tmatrix", "--version", "v1.2.3"])

    def test_publish_then_install_exact_tag_from_origin(self):
        prefix = str(self.root / "install with spaces and 'quotes'")
        prepare = self.release(tag="v1.2.3", prefix=prefix)
        prepare.assert_called_once()
        build = self.calls.index([workflow.sys.executable, "scripts/release-local.py", "v1.2.3", "--upload"])
        publish = self.calls.index(["gh", "release", "edit", "v1.2.3", "--repo", "fixture/tmatrix", "--draft=false", "--latest"])
        download = next(i for i, args in enumerate(self.calls) if args[:3] == ["gh", "release", "download"])
        install = next(i for i, args in enumerate(self.calls) if args[0] == "sh")
        self.assertLess(build, publish)
        self.assertLess(publish, download)
        self.assertLess(download, install)
        self.assertEqual(self.calls[install][2:], ["--repo", "fixture/tmatrix", "--version", "v1.2.3", "--prefix", prefix])
        self.assertFalse(Path(self.calls[install][1]).exists(), "temporary installer must be cleaned up")

    def test_install_only_resolves_latest_once_without_release_or_git_mutations(self):
        prepare = self.release(install_only=True)
        prepare.assert_not_called()
        self.assertEqual(sum(args[:3] == ["gh", "release", "view"] for args in self.calls), 1)
        self.assertFalse(any(args[:3] == ["gh", "release", "edit"] or "scripts/release-local.py" in args for args in self.calls))
        self.assertEqual(next(args for args in self.calls if args[0] == "sh")[2:],
                         ["--repo", "fixture/tmatrix", "--version", "v1.2.3"])

    def test_skip_install_does_not_download_or_run_installer(self):
        self.release(tag="v1.2.3", skip_install=True)
        self.assertTrue(any(args[:3] == ["gh", "release", "edit"] for args in self.calls))
        self.assertFalse(any(args[0] == "sh" or args[:3] == ["gh", "release", "download"] for args in self.calls))

    def test_build_or_upload_failure_prevents_publication_and_installation(self):
        self.failure = lambda args: "scripts/release-local.py" in args
        with self.assertRaisesRegex(RuntimeError, "No publication or installation"):
            self.release(tag="v1.2.3")
        self.assertFalse(any(args[:3] in (["gh", "release", "edit"], ["gh", "release", "download"]) for args in self.calls))

    def test_publication_failure_prevents_installation(self):
        self.failure = lambda args: args[:3] == ["gh", "release", "edit"]
        with self.assertRaisesRegex(RuntimeError, "Inspect its state"):
            self.release(tag="v1.2.3")
        self.assertFalse(any(args[0] == "sh" or args[:3] == ["gh", "release", "download"] for args in self.calls))

    def test_download_and_install_failures_leave_publication_and_report_drain_uncertainty(self):
        for stage in ("download", "sh"):
            with self.subTest(stage=stage):
                self.calls = []
                self.failure = lambda args: args[0] == stage or args[:3] == ["gh", "release", stage]
                with self.assertRaisesRegex(RuntimeError, "drain may still be running"):
                    self.release(tag="v1.2.3")
                self.assertTrue(any(args[:3] == ["gh", "release", "edit"] for args in self.calls))
                if stage == "download":
                    self.assertFalse(any(args[0] == "sh" for args in self.calls))

    def test_invalid_options_rejected_before_any_commands(self):
        cases = [{"tag": ""}, {"tag": "v1.02.3"}, {"tag": "main"}, {"tag": "v1.2.3", "prefix": "relative"},
                 {"install_only": True, "tag": "v1.2.3"}, {"install_only": True, "skip_install": True},
                 {"tag": "v1.2.3", "skip_install": True, "prefix": "/absolute"}]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                self.release(**case)
        self.assertEqual(self.calls, [])

    def test_missing_build_prerequisites_prevent_pull_or_tag(self):
        with patch.object(workflow.shutil, "which", side_effect=lambda tool: None if tool == "goreleaser" else "/tool"), \
             patch.object(workflow, "run") as run, self.assertRaisesRegex(RuntimeError, "goreleaser"):
            workflow.release("v1.2.3", skip_install=True, root=self.root)
        run.assert_not_called()

    def test_install_only_does_not_require_build_tools(self):
        with patch.object(workflow.shutil, "which", side_effect=lambda tool: None if tool in ("go", "node", "npm", "goreleaser", "pwsh") else "/tool"), \
             patch.object(workflow.sys, "platform", "linux"):
            workflow.prerequisites(install_only=True, skip_install=False)

    def test_unstable_latest_rejected_before_downloading_installer(self):
        original = self.fake_run

        def prerelease(args, root, env, capture=False):
            result = original(args, root, env, capture)
            return "v1.2.3-beta" if args[:3] == ["gh", "release", "view"] else result

        with patch.object(self, "fake_run", side_effect=prerelease), \
             self.assertRaisesRegex(RuntimeError, "stable version"):
            self.release(install_only=True)
        self.assertFalse(any(args[0] == "sh" or args[:3] == ["gh", "release", "download"] for args in self.calls))

    def test_relative_environment_prefix_rejected_before_commands(self):
        with patch.dict(os.environ, {"TMATRIX_PREFIX": "relative"}), \
             patch.object(workflow, "run") as run, self.assertRaisesRegex(RuntimeError, "TMATRIX_PREFIX"):
            workflow.release("v1.2.3", root=self.root)
        run.assert_not_called()

    def test_unsupported_install_platform_requires_skip_install(self):
        with patch.object(workflow.sys, "platform", "win32"), \
             patch.object(workflow.shutil, "which", return_value="/tool"):
            with self.assertRaisesRegex(RuntimeError, "WSL"):
                workflow.prerequisites(install_only=False, skip_install=False)
            workflow.prerequisites(install_only=False, skip_install=True)


class GitPreparationTests(unittest.TestCase):
    """Exercise clean/branch/tag guards against real disposable local Git repos."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.origin = self.directory / "origin.git"
        self.root = self.directory / "checkout"
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                        GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid")
        self.git("init", "--bare", str(self.origin), cwd=self.directory)
        self.git("init", "-b", "main", str(self.root), cwd=self.directory)
        self.commit("initial")
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-u", "origin", "main")
        self.git("tag", "v1.2.2")
        self.git("push", "origin", "v1.2.2")
        self.commit("new version")
        self.git("push", "origin", "main")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.root, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, content, cwd=None):
        root = cwd or self.root
        (root / "source").write_text(content)
        self.git("add", "source", cwd=root)
        self.git("commit", "-m", content, cwd=root)

    def prepare(self, tag="v1.2.3"):
        with patch("builtins.print"):
            return workflow.prepare(tag, "main", self.root, self.env)

    def test_automatic_version_fetches_remote_tags_and_compares_numerically(self):
        # These tags exist only on origin until prepare fetches them. Ignore
        # prereleases and invalid/zero-padded stable tags when incrementing.
        for tag in ("v1.9.9", "v1.10.2", "v2.0.0-rc.1", "v03.0.0"):
            self.git("--git-dir", str(self.origin), "tag", tag, "main~1", cwd=self.directory)
        self.assertEqual(self.prepare(None), "v1.10.3")
        self.assertEqual(self.git("rev-parse", "v1.10.3"), self.git("rev-parse", "HEAD"))
        self.assertEqual(self.git("ls-remote", "--tags", "origin", "refs/tags/v1.10.3"), "")

    def test_automatic_retry_reuses_unpublished_local_tag(self):
        self.assertEqual(self.prepare(None), "v1.2.3")
        self.assertEqual(self.prepare(None), "v1.2.3")
        self.assertEqual(self.git("tag", "--points-at", "HEAD"), "v1.2.3")

    def test_automatic_version_starts_at_v0_1_0_without_stable_tags(self):
        self.git("push", "origin", ":refs/tags/v1.2.2")
        self.git("tag", "-d", "v1.2.2")
        self.assertEqual(self.prepare(None), "v0.1.0")

    def test_automatic_version_refuses_to_rerelease_published_head(self):
        self.git("tag", "v1.2.3")
        self.git("push", "origin", "v1.2.3")
        with self.assertRaisesRegex(RuntimeError, "already exists on origin"):
            self.prepare(None)
        self.assertEqual(self.git("tag", "--points-at", "HEAD"), "v1.2.3")

    def test_pulls_fast_forward_then_creates_local_tag_only(self):
        other = self.directory / "other"
        self.git("clone", "--branch", "main", str(self.origin), str(other), cwd=self.directory)
        self.commit("remote update", cwd=other)
        self.git("push", "origin", "main", cwd=other)
        self.prepare()
        self.assertEqual(self.git("rev-parse", "v1.2.3"), self.git("rev-parse", "origin/main"))
        self.assertEqual((self.root / "source").read_text(), "remote update")
        self.assertEqual(self.git("ls-remote", "--tags", "origin", "refs/tags/v1.2.3"), "")
        self.prepare()  # Safe retry of a local tag after failed checks.

    def test_dirty_checkout_or_feature_branch_does_not_create_tag(self):
        (self.root / "untracked").touch()
        with self.assertRaisesRegex(RuntimeError, "clean checkout"):
            self.prepare()
        (self.root / "untracked").unlink()
        self.git("switch", "-c", "feature")
        with self.assertRaisesRegex(RuntimeError, "default branch"):
            self.prepare()
        self.assertEqual(self.git("tag", "--list", "v1.2.3"), "")

    def test_ahead_or_divergent_branch_does_not_create_tag(self):
        self.commit("unpublished")
        with self.assertRaisesRegex(RuntimeError, "ahead of origin"):
            self.prepare()
        other = self.directory / "other"
        self.git("clone", "--branch", "main", str(self.origin), str(other), cwd=self.directory)
        self.commit("diverged", cwd=other)
        self.git("push", "origin", "main", cwd=other)
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare()
        self.assertEqual(self.git("tag", "--list", "v1.2.3"), "")

    def test_remote_tag_or_old_version_never_replaced(self):
        with self.assertRaisesRegex(RuntimeError, "already exists on origin"):
            self.prepare("v1.2.2")
        with self.assertRaisesRegex(RuntimeError, "newer"):
            self.prepare("v1.2.1")
        self.assertEqual(self.git("tag", "--list", "v1.2.1"), "")

    def test_wrong_local_tag_or_already_tagged_commit_never_moved(self):
        self.git("tag", "v1.2.3", "HEAD~1")
        previous = self.git("rev-parse", "v1.2.3")
        with self.assertRaisesRegex(RuntimeError, "another commit"):
            self.prepare()
        self.assertEqual(self.git("rev-parse", "v1.2.3"), previous)
        self.git("tag", "v1.2.4")
        with self.assertRaisesRegex(RuntimeError, "already has a release tag"):
            self.prepare("v1.2.5")
        self.assertEqual(self.git("tag", "--list", "v1.2.5"), "")

    def test_shallow_checkout_rejected(self):
        shallow = self.directory / "shallow"
        self.git("clone", "--depth", "1", "--branch", "main", self.origin.as_uri(), str(shallow), cwd=self.directory)
        self.root = shallow
        with self.assertRaisesRegex(RuntimeError, "Full Git history"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
