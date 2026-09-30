"""Reject release archives with missing, extra or non-regular payload files."""
import json
import re
from pathlib import Path
import tarfile
import zipfile


def verify(root):
    manifest = json.loads((root / "staging/release-manifest.json").read_text())
    common = {"README.md", "LICENSE"} | {"engine/" + name for name in manifest}
    archives = sorted((root / "dist").glob("*.tar.gz")) + sorted((root / "dist").glob("*.zip"))
    if len(archives) != 6:
        raise RuntimeError("Expected exactly six platform archives")
    targets = set()
    for archive in archives:
        match = re.fullmatch(r"tmatrix_.+_(linux|darwin|windows)_(amd64|arm64)\.(tar\.gz|zip)", archive.name)
        if not match:
            raise RuntimeError("Unexpected archive name")
        platform, arch, extension = match.groups()
        target = (platform, arch)
        if target in targets or extension != ("zip" if platform == "windows" else "tar.gz"):
            raise RuntimeError("Duplicate target or unexpected archive format")
        targets.add(target)
        windows = platform == "windows"
        expected = common | {"tmatrix.exe" if windows else "tmatrix"}
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as bundle:
                files = []
                for entry in bundle.infolist():
                    if entry.is_dir():
                        continue
                    mode = entry.external_attr >> 16
                    if mode & 0o170000 not in (0, 0o100000):
                        raise RuntimeError("Non-regular ZIP entry")
                    files.append(entry.filename)
        else:
            with tarfile.open(archive) as bundle:
                files = []
                for entry in bundle:
                    if entry.isdir():
                        continue
                    if not entry.isfile():
                        raise RuntimeError("Non-regular tar entry")
                    files.append(entry.name)
        if len(files) != len(set(files)) or set(files) != expected:
            raise RuntimeError("Archive does not match the release allowlist: " + archive.name)
    print("Verified all six release archives against the fresh-build allowlist.")


if __name__ == "__main__":
    verify(Path(__file__).resolve().parents[1])
