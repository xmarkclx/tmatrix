"""Build a clean release engine without touching the live staging/engine tree."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def prepare(root=ROOT):
    source = root
    for name in ("src", "tsconfig.build.json", "package.json", "package-lock.json",
                 "scripts/worktrees.py", "LICENSE"):
        if not (source / name).exists():
            raise RuntimeError("Release requires the TMatrix source tree: missing " + name)
    staging = root / "staging"
    staging.mkdir(exist_ok=True)
    # Serialize publishers of the release-only directory; the running engine
    # uses staging/engine and is never modified by this build.
    with (staging / ".release.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix=".release-", dir=staging) as temporary:
            candidate = Path(temporary) / "engine"
            candidate.mkdir()
            subprocess.run([
                str(source / "node_modules/.bin/tsc"), "-p", "tsconfig.build.json",
                "--outDir", str(candidate / "dist"), "--sourceMap", "false",
                "--declaration", "false",
            ], cwd=source, check=True)
            emitted = list((candidate / "dist").rglob("*"))
            if not (candidate / "dist/index.js").is_file():
                raise RuntimeError("Compiler did not produce the engine entry point")
            for path in emitted:
                if path.is_symlink() or (not path.is_dir() and path.suffix != ".js"):
                    raise RuntimeError("Unexpected compiler output in release staging")
            for name in ("package.json", "package-lock.json", "LICENSE", "scripts/worktrees.py"):
                target = candidate / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, target)
            # Preserve notices for Go code linked into the executable. npm
            # dependencies are fetched by the installer with their own notices.
            notices = candidate / "go-licenses"
            notices.mkdir()
            modules = set()
            for platform in ("linux", "darwin", "windows"):
                for arch in ("amd64", "arm64"):
                    modules.update(subprocess.check_output(
                        ["go", "list", "-deps", "-f",
                         "{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}", "./cmd/tmatrix"],
                        cwd=root, text=True,
                        env={**os.environ, "GOOS": platform, "GOARCH": arch, "CGO_ENABLED": "0"},
                    ).splitlines())
            for line in sorted(modules - {""}):
                module, version, directory = line.split("|", 2)
                if not version:  # Main module is covered by LICENSE.
                    continue
                if not directory:
                    raise RuntimeError("Module source unavailable for " + module)
                files = [p for p in Path(directory).iterdir()
                         if p.is_file() and p.name.upper().startswith(("LICENSE", "COPYING", "NOTICE"))]
                # go-localereader v0.0.1 declares its MIT license and author in
                # README.md instead of a separate license file. Preserve it.
                if module == "github.com/mattn/go-localereader" and version == "v0.0.1" and not files:
                    files = [Path(directory) / "README.md"]
                if not files:
                    raise RuntimeError("Missing third-party license for " + module)
                destination = notices / (module.replace("/", "_") + "@" + version)
                destination.mkdir()
                for path in files:
                    shutil.copyfile(path, destination / path.name)
            goroot = subprocess.check_output(["go", "env", "GOROOT"], cwd=root, text=True).strip()
            shutil.copyfile(Path(goroot) / "LICENSE", notices / "Go-LICENSE")
            manifest = sorted(p.relative_to(candidate).as_posix()
                              for p in candidate.rglob("*") if p.is_file())
            # This directory is build output only. Never merge it with a prior
            # tree: removed modules, stray logs and local files must disappear.
            destination = staging / "release-engine"
            if destination.is_symlink():
                raise RuntimeError("Refusing a symlink release directory")
            if destination.exists():
                shutil.rmtree(destination)
            candidate.rename(destination)
            (staging / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    prepare()
