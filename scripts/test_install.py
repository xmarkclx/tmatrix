"""Exercise the curl installer offline, including a corrupt release archive."""
import shutil
import hashlib
import io
import json
import http.server
import sys
import threading
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


INSTALLER = Path(__file__).with_name("install.sh")


class PrerequisiteTests(unittest.TestCase):
    """Run actual preflight with a hermetic PATH; never install host packages."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "tools"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin), FIXTURE=str(self.root))
        for name in ("rm", "mktemp", "tar", "install", "mkdir", "chmod", "cp"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.tool("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.tool("curl", 'exit 55')
        self.script = self.root / "preflight.sh"
        self.script.write_text(INSTALLER.read_text().split('release_label="Selected release"')[0] +
                               '\nprintf "%s\\n" "$PATH" > "$FIXTURE/result-path"\n')
        self.brew_source = self.root / "brew-source"
        self.brew_source.write_text("""#!/bin/sh
case "$1" in
  install)
    echo "$2" >> "$FIXTURE/packages"
    [ ! -f "$FIXTURE/fail-brew" ] || exit 42
    case "$2" in
      node@24) target="$FIXTURE/node/bin"; names="node npm";;
      *) exit 99;;
    esac
    mkdir -p "$target"
    for name in $names; do
      printf '#!/bin/sh\nexit 0\n' > "$target/$name"
      chmod +x "$target/$name"
    done;;
  --prefix)
    case "$2" in node@24) echo "$FIXTURE/node";; esac;;
esac
""")

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def brew(self):
        shutil.copyfile(self.brew_source, self.bin / "brew")
        (self.bin / "brew").chmod(0o755)

    def run_preflight(self):
        return subprocess.run(["/bin/sh", str(self.script)], env=self.env, capture_output=True, text=True)

    def test_compatible_runtimes_skip_homebrew(self):
        for name in ("node", "npm"):
            self.tool(name, "exit 0")
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "packages").exists())

    def test_missing_runtimes_installed_and_selected(self):
        self.brew()
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "packages").read_text().splitlines(), ["node@24"])
        self.assertTrue((self.root / "result-path").read_text().startswith(
            str(self.root / "node/bin")))

    def test_broken_python_is_never_used(self):
        self.brew()
        for name in ("node", "npm"):
            self.tool(name, "exit 0")
        self.tool("python3", 'echo unexpected-python >&2; exit 1')
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "packages").exists())
        self.assertNotIn("unexpected-python", result.stderr)

    def test_old_node_or_broken_npm_installs_node(self):
        self.brew()
        for node_status, npm_status in ((1, 0), (0, 1)):
            self.tool("node", f"exit {node_status}")
            self.tool("npm", f"exit {npm_status}")
            result = self.run_preflight()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "packages").read_text().splitlines(), ["node@24", "node@24"])

    def test_brew_failure_stops_before_release_install(self):
        self.brew()
        (self.root / "fail-brew").touch()
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "result-path").exists())

    @unittest.skipIf(Path("/opt/homebrew/bin/brew").exists() or Path("/usr/local/bin/brew").exists(),
                     "Host Homebrew would bypass the bootstrap fixture")
    def test_homebrew_bootstrap_then_runtime_install(self):
        self.tool("curl", """while [ "$1" != -o ]; do shift; done
printf '#!/bin/sh\ncp "$FIXTURE/brew-source" "$FIXTURE/tools/brew"\nchmod +x "$FIXTURE/tools/brew"\n' > "$2"
""")
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installing Homebrew", result.stdout)
        self.assertEqual((self.root / "packages").read_text().splitlines(), ["node@24"])

    def test_linux_does_not_bootstrap_homebrew(self):
        self.tool("uname", 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac')
        self.brew()
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node.js", result.stderr)
        self.assertFalse((self.root / "packages").exists())


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
                "tmatrix": b'''#!/bin/sh
if [ "$1" = --version ]; then echo "TMatrix 1.2.3 (build 42, commit 0123456789ab)"; exit 0; fi
if [ "$1" = upgrade ]; then
  printf '%s\\n' "$@" >> "$INSTALL_FIXTURE/upgrade-args"
  if [ -f "$INSTALL_FIXTURE/busy-workers" ]; then echo 'Upgrade deferred while workers are active' >&2; exit 1; fi
  exit 0
fi
printf '%s\\n' "$@" >> "$INSTALL_FIXTURE/setup-args"
if [ -f "$INSTALL_FIXTURE/fail-setup" ]; then exit 1; fi
''',
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
        self.tool("npm", '#!/bin/sh\n[ "$1" = --version ] && exit 0\ntouch "$INSTALL_FIXTURE/npm-called"\n')
        self.tool("curl", f'#!{sys.executable}\n' + '''
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
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], INSTALL_FIXTURE=str(self.root), HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / ".config"))
        return subprocess.run(["sh", str(INSTALLER), "--repo", "fixture/tmatrix", "--version", version, "--prefix", str(self.prefix)], env=env, capture_output=True, text=True)

    def test_valid_archive_installs_binary_and_engine(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.prefix / "bin/tmatrix").is_file())
        self.assertTrue((self.prefix / "bin/tmatrix").resolve().with_name("engine").joinpath("dist/index.js").is_file())
        self.assertTrue((self.root / "npm-called").exists())
        self.assertIn("engine/node_modules/.bin/codex login", result.stdout)

    def test_full_install_does_not_invoke_python(self):
        self.tool("python3", '#!/bin/sh\necho unexpected-python >&2\nexit 99\n')
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("unexpected-python", result.stderr)
        self.assertTrue((self.home / ".zshrc").exists())

    def test_official_repository_default(self):
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], INSTALL_FIXTURE=str(self.root), HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / ".config"))
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

    def test_non_utf8_profiles_are_preserved_and_setup_runs(self):
        original = b"# legacy shell profile\n# byte: \x9c\xff\nexport EXISTING=yes\n"
        # Exercise shell quoting at the same time as preserving arbitrary bytes.
        self.prefix = self.root / "install with spaces and 'quotes'"
        for name in (".profile", ".bashrc", ".zshrc"):
            (self.home / name).write_bytes(original)
        for _ in range(2):
            result = self.run_installer()
            self.assertEqual(result.returncode, 0, result.stderr)
        for name in (".profile", ".bashrc", ".zshrc"):
            profile = (self.home / name).read_bytes()
            self.assertTrue(profile.startswith(original))
            self.assertEqual(profile.count(b"# TMatrix installer"), 1)
        self.assertEqual((self.root / "setup-args").read_text().splitlines().count("setup"), 2)

    def test_reports_old_and_new_build_before_upgrade(self):
        (self.prefix / "bin").mkdir(parents=True)
        binary = self.prefix / "bin/tmatrix"
        binary.write_text('#!/bin/sh\necho "TMatrix 1.2.2 (build 41, commit fedcba987654)"\n')
        binary.chmod(0o755)
        result = self.run_installer("latest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Currently installed CLI: TMatrix 1.2.2 (build 41, commit fedcba987654)", result.stdout)
        self.assertIn("Latest release (v1.2.3): TMatrix 1.2.3 (build 42, commit 0123456789ab)", result.stdout)
        self.assertLess(result.stdout.index("Latest release"), result.stdout.index("Installed:"))

    def test_dependency_failure_leaves_install_untouched(self):
        self.tool("npm", '#!/bin/sh\nexit 42\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.prefix.exists())

    def test_busy_workers_leave_cli_and_settings_untouched(self):
        (self.prefix / "bin").mkdir(parents=True)
        current = self.prefix / "bin/tmatrix"
        current.write_text('#!/bin/sh\necho "TMatrix 1.2.2"\n')
        current.chmod(0o755)
        config = self.home / ".config/tmatrix/config.json"
        config.parent.mkdir(parents=True)
        config.write_text('{"engine_dir":"previous-engine","max_workers":50}')
        before = config.read_bytes()
        (self.root / "busy-workers").touch()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Upgrade deferred", result.stderr)
        self.assertFalse(current.is_symlink())
        self.assertIn("1.2.2", current.read_text())
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((self.root / "setup-args").exists())
        self.assertFalse((self.home / ".profile").exists())
        self.assertFalse((self.prefix / "lib/tmatrix/install.lock").exists())
        self.assertEqual(list((self.prefix / "lib/tmatrix/releases").iterdir()), [])

    def test_latest_and_service_setup_arguments(self):
        result = self.run_installer("latest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Latest release (v1.2.3): TMatrix 1.2.3 (build 42, commit 0123456789ab)", result.stdout)
        args = (self.root / "setup-args").read_text().splitlines()
        self.assertEqual(args[0], "--engine-dir")
        self.assertTrue(Path(args[1]).joinpath("dist/index.js").exists())
        self.assertEqual(args[2], "setup")

    @unittest.skipUnless(sys.platform == "linux", "systemd upgrade fixture requires Linux")
    def test_real_cli_upgrades_existing_daemon(self):
        # Run the actual CLI while replacing only OS supervision and the bridge.
        # No host service, credentials, or engine process is touched.
        binary = self.root / "tmatrix"
        subprocess.run(["go", "build", "-ldflags",
                        "-X main.version=1.2.3 -X main.commit=0123456789abcdef -X main.commitCount=42",
                        "-o", str(binary), "./cmd/tmatrix"],
                       cwd=INSTALLER.parent.parent, check=True, capture_output=True)
        with tarfile.open(self.archive, "w:gz") as archive:
            archive.add(binary, arcname="tmatrix")
            for name, data in {
                "engine/dist/index.js": b"// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED",
                "engine/dist/local-control-server.js": b"// fixture",
                "engine/package.json": b'{"private":true}',
            }.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.checksum.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest()
                                 + "  " + self.archive.name + "\n")

        self_config_dir = self.home / ".config/tmatrix"

        class Bridge(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"version":1,"max_workers":3,"running_workers":0}')

            def do_POST(self):
                size = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(size))
                assert self.path == "/v1/shutdown" and body == {"only_if_idle": True}
                bridge = self_config_dir / "bridge.json"
                bridge.unlink(missing_ok=True)
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"shutting_down"}')

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        discovery = json.dumps({"version": 1, "pid": os.getpid(),
                                "url": f"http://127.0.0.1:{server.server_port}",
                                "token": "offline-bridge-fixture"})
        (self.root / "discovery").write_text(discovery)
        self.tool("systemctl", """#!/usr/bin/env python3
import os, sys
from pathlib import Path
root = Path(os.environ["INSTALL_FIXTURE"])
args = sys.argv[1:]
assert args[0] == "--user"
action = args[1]
with (root / "service-calls").open("a") as f:
    f.write(action + "\\n")
bridge = Path(os.environ["XDG_CONFIG_HOME"]) / "tmatrix/bridge.json"
if action == "stop":
    bridge.unlink(missing_ok=True)
if action == "start":
    if (root / "fail-start").exists():
        sys.exit(42)
    bridge.write_text((root / "discovery").read_text())
    bridge.chmod(0o600)
""")
        first = self.run_installer()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("Service setup queued", first.stdout)
        self.assertIn("Currently installed CLI: none", first.stdout)
        self.assertIn("Selected release (v1.2.3): TMatrix 1.2.3 (build 42, commit 0123456789ab)", first.stdout)
        self.assertFalse((self.root / "service-calls").exists())
        old = (self.prefix / "bin/tmatrix").resolve()
        config_dir = self.home / ".config/tmatrix"
        config_path = config_dir / "config.json"
        saved = json.loads(config_path.read_text())
        saved.update(max_workers=3, resume_intake=False)
        config_path.write_text(json.dumps(saved))
        (config_dir / "credentials").write_text("offline-fixture")
        (config_dir / "credentials").chmod(0o600)
        (config_dir / "bridge.json").write_text(discovery)
        (config_dir / "bridge.json").chmod(0o600)
        unit = self.home / ".config/systemd/user/tmatrix.service"
        unit.parent.mkdir(parents=True)
        unit.write_text('# Managed by tmatrix service install\n'
                        + f'ExecStart="{old}" --config-dir "{config_dir}" daemon\n')

        upgraded = self.run_installer()
        self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
        new = (self.prefix / "bin/tmatrix").resolve()
        self.assertNotEqual(new, old)
        self.assertTrue(old.exists())
        self.assertIn(str(new), unit.read_text())
        expected = dict(saved, engine_dir=str(new.with_name("engine")))
        actual = json.loads(config_path.read_text())
        actual.setdefault("resume_intake", False)
        self.assertEqual(actual, expected)
        self.assertEqual((config_dir / "credentials").read_text(), "offline-fixture")
        self.assertFalse((config_dir / "install-service-on-connect").exists())
        self.assertEqual((self.root / "service-calls").read_text().splitlines(),
                         ["daemon-reload", "enable", "stop", "start"])
        self.assertIn("Currently installed CLI: TMatrix 1.2.3 (build 42, commit 0123456789ab)", upgraded.stdout)
        self.assertIn("Draining existing TMatrix workers", upgraded.stdout)
        self.assertIn("Service enabled and started", upgraded.stdout)

        (self.root / "fail-start").touch()
        failed = self.run_installer()
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("Service setup incomplete", failed.stderr)
        self.assertNotIn("Service enabled and started", failed.stdout)
        self.assertTrue((config_dir / "install-service-on-connect").exists())
        self.assertTrue(new.exists())

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
