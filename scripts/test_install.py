"""Exercise the curl installer offline, including a corrupt release archive."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


INSTALLER = Path(__file__).with_name("install.sh")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tmatrix-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "tools"
        self.bin.mkdir()
        self.prefix = self.root / "installed"
        self.home = self.root / "home"
        self.home.mkdir()
        self.archive = self.root / "tmatrix_1.2.3_linux_amd64.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in {
                "tmatrix": b'#!/bin/sh\nprintf "%s\\n" "$@" >> "$INSTALL_FIXTURE/setup-args"\nif [ -f "$INSTALL_FIXTURE/fail-setup" ]; then exit 1; fi\n' ,
                "engine/dist/index.js": b"// offline installer fixture\n",
                "engine/package.json": b'{"private":true}',
            }.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o755 if name == "tmatrix" else 0o644
                archive.addfile(info, io.BytesIO(data))
        self.checksum = self.root / "checksums.txt"
        self.checksum.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest() + "  " + self.archive.name + "\n")
        self.tool("uname", '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        self.tool("npm", '#!/bin/sh\ntouch "$INSTALL_FIXTURE/npm-called"\n')
        self.tool("curl", '''#!/usr/bin/env python3
import os,sys,shutil
from pathlib import Path
args=sys.argv[1:]
url=next(x for x in args if x.startswith('https://'))
name=url.rsplit('/',1)[-1]
if name == 'latest':
    Path(args[args.index('-o')+1]).write_text('{"tag_name":"v1.2.3"}')
    sys.exit(0)
assert name in ('tmatrix_1.2.3_linux_amd64.tar.gz','tmatrix_1.2.3_darwin_arm64.tar.gz','tmatrix_1.2.3_darwin_amd64.tar.gz','checksums.txt')
assert any(url.startswith('https://github.com/'+repo+'/releases/download/v1.2.3/') for repo in ('fixture/tmatrix', 'xmarkclx/tmatrix'))
shutil.copyfile(Path(os.environ['INSTALL_FIXTURE'])/name,args[args.index('-o')+1])
''')

    def tool(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)

    def run_installer(self, version="1.2.3"):
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], INSTALL_FIXTURE=str(self.root), HOME=str(self.home))
        return subprocess.run(["sh", str(INSTALLER), "--repo", "fixture/tmatrix", "--version", version, "--prefix", str(self.prefix)], env=env, capture_output=True, text=True)

    def test_valid_archive_installs_binary_and_engine(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.prefix / "bin/tmatrix").is_file())
        self.assertTrue((self.prefix / "bin/tmatrix").resolve().with_name("engine").joinpath("dist/index.js").is_file())
        self.assertTrue((self.root / "npm-called").exists())
        self.assertIn("engine/node_modules/.bin/codex login", result.stdout)

    def test_official_repository_default(self):
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], INSTALL_FIXTURE=str(self.root), HOME=str(self.home))
        env.pop("TMATRIX_REPO", None)
        result = subprocess.run(["sh", str(INSTALLER), "--version", "1.2.3", "--prefix", str(self.prefix)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_macos_archives(self):
        for machine, arch in (("arm64", "arm64"), ("x86_64", "amd64")):
            with self.subTest(machine=machine):
                self.prefix = self.root / ("installed-" + arch)
                mac_archive = self.root / f"tmatrix_1.2.3_darwin_{arch}.tar.gz"
                mac_archive.write_bytes(self.archive.read_bytes())
                self.checksum.write_text(hashlib.sha256(mac_archive.read_bytes()).hexdigest() + "  " + mac_archive.name + "\n")
                self.tool("uname", f'#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo {machine};; esac\n')
                result = self.run_installer()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((self.prefix / "bin/tmatrix").is_file())
                self.assertTrue((self.prefix / "bin/tmatrix").resolve().with_name("engine").joinpath("dist/index.js").is_file())

    def test_corrupt_checksum_rejects_before_execution(self):
        self.checksum.write_text("0" * 64 + "  " + self.archive.name + "\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.prefix.exists())
        self.assertFalse((self.root / "npm-called").exists())

    def test_existing_engine_is_retained_during_upgrade(self):
        existing = self.prefix / "lib/tmatrix/engine"
        existing.mkdir(parents=True)
        sentinel = existing / "keep"
        sentinel.write_text("existing-engine")
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sentinel.read_text(), "existing-engine")
        self.assertTrue((self.prefix / "bin/tmatrix").exists())

    def test_repeat_install_keeps_old_bundle_and_path_is_idempotent(self):
        self.assertEqual(self.run_installer().returncode, 0)
        old = (self.prefix / "bin/tmatrix").resolve()
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertTrue(old.exists())
        self.assertNotEqual(old, (self.prefix / "bin/tmatrix").resolve())
        self.assertEqual((self.home / ".profile").read_text().count("# TMatrix installer"), 1)

    def test_dependency_failure_leaves_install_untouched(self):
        self.tool("npm", '#!/bin/sh\nexit 42\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.prefix.exists())

    def test_latest_and_service_setup_arguments(self):
        result = self.run_installer("latest")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = (self.root / "setup-args").read_text().splitlines()
        self.assertEqual(args[0], "--engine-dir")
        self.assertTrue(Path(args[1]).joinpath("dist/index.js").exists())
        self.assertEqual(args[2], "setup")

    def test_service_failure_reports_failure_and_retains_previous_bundle(self):
        self.assertEqual(self.run_installer().returncode, 0)
        old = (self.prefix / "bin/tmatrix").resolve()
        (self.root / "fail-setup").touch()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Service setup incomplete", result.stderr)
        self.assertTrue(old.exists())
        self.assertTrue((self.prefix / "bin/tmatrix").exists())
        self.assertFalse((self.prefix / "lib/tmatrix/install.lock").exists())


class UninstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tmatrix-uninstall-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prefix = self.root / "install with spaces"
        (self.prefix / "bin").mkdir(parents=True)
        self.binary = self.prefix / "bin/tmatrix"
        self.binary.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$UNINSTALL_ARGS"\nexit "${UNINSTALL_STATUS:-0}"\n')
        self.binary.chmod(0o755)
        self.log = self.root / "args"
        self.env = dict(os.environ, UNINSTALL_ARGS=str(self.log), TMATRIX_PREFIX=str(self.prefix))
        self.script = INSTALLER.with_name("uninstall-daemon.sh")

    def run_uninstaller(self, *args, status="0"):
        return subprocess.run(["sh", str(self.script), *args], env=dict(self.env, UNINSTALL_STATUS=status), capture_output=True, text=True)

    def test_removes_only_daemon_and_preserves_application(self):
        result = self.run_uninstaller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ["service", "uninstall"])
        self.assertTrue(self.binary.exists())
        self.assertFalse((self.prefix / "lib/tmatrix/install.lock").exists())

    def test_custom_config_is_one_argument(self):
        config = str(self.root / "config with spaces;literal")
        result = self.run_uninstaller("--prefix", str(self.prefix), "--config-dir", config)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ["--config-dir", config, "service", "uninstall"])

    def test_failure_does_not_report_success(self):
        result = self.run_uninstaller(status="42")
        self.assertEqual(result.returncode, 42)
        self.assertNotIn("Daemon removed.", result.stdout)
        self.assertTrue(self.binary.exists())
        self.assertFalse((self.prefix / "lib/tmatrix/install.lock").exists())

    def test_active_installer_lock_is_preserved(self):
        lock = self.prefix / "lib/tmatrix/install.lock"
        lock.mkdir(parents=True)
        result = self.run_uninstaller()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(lock.exists())
        self.assertFalse(self.log.exists())

    def test_missing_install_and_invalid_arguments(self):
        for args in [("--prefix", str(self.root / "missing")), ("--prefix", "relative"), ("--config-dir",), ("--unknown",)]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_uninstaller(*args).returncode, 0)
                self.assertFalse(self.log.exists())

    def test_windows_embedded_shell_defaults_custom_paths_and_failure(self):
        # Execute the exact shell sent to WSL, using a fictional installed CLI.
        source = self.script.with_suffix(".ps1").read_text()
        script = source.split("$uninstallScript = @'\n", 1)[1].split("\n'@", 1)[0]
        for config, status in [("-", "0"), (str(self.root / "config with spaces;literal"), "0"), ("-", "42")]:
            result = subprocess.run(["sh", "-c", script, "sh", str(self.prefix), config], env=dict(self.env, UNINSTALL_STATUS=status), capture_output=True, text=True)
            self.assertEqual(result.returncode, int(status), result.stderr)
            expected = ["service", "uninstall"] if config == "-" else ["--config-dir", config, "service", "uninstall"]
            self.assertEqual(self.log.read_text().splitlines(), expected)
            self.assertFalse((self.prefix / "lib/tmatrix/install.lock").exists())


if __name__ == "__main__":
    unittest.main()
