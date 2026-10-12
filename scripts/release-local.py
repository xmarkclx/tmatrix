"""Build and verify a tagged release locally; optionally upload a GitHub draft."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def run(args, root, env, capture=False):
    print("+ " + " ".join(args), flush=True)
    result = subprocess.run(args, cwd=root, env=env, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def identity(tag, root, env):
    if run(["git", "rev-parse", "--is-shallow-repository"], root, env, True) != "false":
        raise RuntimeError("Full Git history is required; run git fetch --unshallow.")
    if run(["git", "status", "--porcelain"], root, env, True):
        raise RuntimeError("Release requires a clean checkout, including untracked files.")
    head = run(["git", "rev-parse", "HEAD"], root, env, True)
    tagged = run(["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"], root, env, True)
    if head != tagged:
        raise RuntimeError("The release tag must point to the checked-out commit.")
    # GoReleaser selects the tag at HEAD. Refuse ambiguous/multiple version tags.
    tags = run(["git", "tag", "--points-at", "HEAD"], root, env, True).splitlines()
    if [value for value in tags if value.startswith("v")] != [tag]:
        raise RuntimeError("HEAD must have exactly one v-prefixed release tag.")
    return head


PREREQUISITES = {
    "git": "Git — https://git-scm.com/downloads",
    "go": "Go toolchain — https://go.dev/doc/install",
    "node": "Node.js 22 — https://nodejs.org/en/download",
    "npm": "npm (included with Node.js) — https://nodejs.org/en/download",
    "goreleaser": "GoReleaser v2 packages the six release archives — "
                  "https://goreleaser.com/getting-started/install/oss/",
    "pwsh": "PowerShell 7 runs the Windows installer tests, including on Linux/macOS — "
            "https://learn.microsoft.com/powershell/scripting/install/installing-powershell",
    "gh": "GitHub CLI uploads the verified draft — https://cli.github.com/",
}


def check_prerequisites(upload=False):
    """Check executable availability without requiring a tag or changing anything."""
    required = ["git", "go", "node", "npm", "goreleaser", "pwsh"]
    if upload:
        required.append("gh")
    missing = [tool for tool in required if shutil.which(tool) is None]
    if missing:
        hints = [f"  {tool}: {PREREQUISITES[tool]}" for tool in missing]
        raise RuntimeError(
            "Missing prerequisites: " + ", ".join(missing) + "\n"
            + "\n".join(hints)
            + "\nInstall these tools and ensure they are on PATH, then rerun "
              "python3 scripts/release-local.py --check-prerequisites"
            + (" --upload" if upload else "")
            + ". No tag, build, or upload is performed by that check."
        )


def release(tag, upload=False, root=ROOT):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise RuntimeError("Use a stable version tag, for example v0.1.2.")
    check_prerequisites(upload)
    env = dict(os.environ)
    head = identity(tag, root, env)
    count = run(["git", "rev-list", "--count", "HEAD"], root, env, True)
    env["TMATRIX_COMMIT_COUNT"] = count
    repository = None
    if upload:
        # Resolve the explicit origin URL, not a possibly unrelated GH_REPO.
        origin = run(["git", "remote", "get-url", "origin"], root, env, True)
        repository = run(["gh", "repo", "view", origin, "--json", "nameWithOwner",
                          "--jq", ".nameWithOwner"], root, env, True)

    # Full release checks run on this machine. No staging/engine or service commands.
    checks = [
        ["npm", "ci"],
        ["npm", "run", "check"],
        ["go", "test", "-race", "./..."],
        ["go", "vet", "./..."],
        [sys.executable, "scripts/test_install.py"],
        ["pwsh", "-NoProfile", "-File", "scripts/test_install.ps1"],
        [sys.executable, "scripts/test_release.py"],
        [sys.executable, "scripts/test_release_local.py"],
        [sys.executable, "scripts/test_release_workflow.py"],
        ["npm", "audit"],
        ["go", "run", "golang.org/x/vuln/cmd/govulncheck@v1.8.0", "./..."],
        ["goreleaser", "check"],
    ]
    for command in checks:
        run(command, root, env)
    if identity(tag, root, env) != head:
        raise RuntimeError("Source changed during checks; rerun from the tagged commit.")
    run(["goreleaser", "release", "--clean", "--skip=publish,announce"], root, env)
    # This must succeed BEFORE pushing a tag or uploading any asset.
    run([sys.executable, "scripts/verify-release.py"], root, env)
    if identity(tag, root, env) != head:
        raise RuntimeError("Source changed during the build; refusing to upload.")

    if not upload:
        print("Verified release built in dist/. Nothing was pushed or uploaded.")
        return
    # Never force-update tags or replace existing releases/assets.
    assets = sorted((root / "dist").glob("*.tar.gz")) + sorted((root / "dist").glob("*.zip"))
    if len(assets) != 6:
        raise RuntimeError("Expected six verified archives before upload.")
    run(["git", "push", "origin", f"refs/tags/{tag}"], root, env)
    run(["gh", "release", "create", tag, "--repo", repository, "--verify-tag", "--draft",
         "--title", f"TMatrix {tag} (build {count}, {head[:12]})", "--generate-notes",
         *[str(path) for path in assets], "dist/checksums.txt",
         "scripts/install.sh", "scripts/install.ps1",
         "scripts/uninstall-daemon.sh", "scripts/uninstall-daemon.ps1"], root, env)
    print(f"Draft uploaded. To publish: gh release edit {tag} --repo {repository} --draft=false --latest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", nargs="?", help="existing local version tag at HEAD, e.g. v0.1.2")
    parser.add_argument("--upload", action="store_true", help="push the verified tag and upload a draft")
    parser.add_argument("--check-prerequisites", action="store_true",
                        help="only check required tools on PATH; no tag or build needed")
    args = parser.parse_args()
    if not args.check_prerequisites and not args.tag:
        parser.error("tag is required unless --check-prerequisites is used")
    try:
        if args.check_prerequisites:
            check_prerequisites(args.upload)
            print("All required tools are on PATH. Tool versions, authentication, and "
                  "release checks are validated when you run the release.")
        else:
            release(args.tag, args.upload)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release failed: {error}\n")


if __name__ == "__main__":
    main()
