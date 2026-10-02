"""Pull, tag, verify, publish and install a TMatrix release in one command."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def run(args, root, env, capture=False):
    print("+ " + " ".join(map(str, args)), flush=True)
    result = subprocess.run(args, cwd=root, env=env, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def prerequisites(install_only, skip_install):
    tools = ["git", "gh"]
    if not install_only:
        tools += ["go", "node", "npm", "goreleaser", "pwsh"]
    if not skip_install:
        if sys.platform not in ("linux", "darwin"):
            raise RuntimeError("Local installation requires Linux, macOS or WSL. "
                               "Use --skip-install to publish elsewhere.")
        tools += ["sh", "curl", "tar", "install", "uname"]
    missing = [tool for tool in tools if shutil.which(tool) is None]
    if missing:
        raise RuntimeError("Missing prerequisites: " + ", ".join(missing))


def repository(root, env):
    # Explicit origin prevents GH_REPO or a caller's cwd selecting another repo.
    origin = run(["git", "remote", "get-url", "origin"], root, env, True)
    return json.loads(run(["gh", "repo", "view", origin, "--json",
                           "nameWithOwner,defaultBranchRef"], root, env, True))


def clean(root, env):
    if run(["git", "rev-parse", "--is-shallow-repository"], root, env, True) != "false":
        raise RuntimeError("Full Git history is required; run git fetch --unshallow.")
    if run(["git", "status", "--porcelain"], root, env, True):
        raise RuntimeError("Release requires a clean checkout, including untracked files.")


def prepare(tag, branch, root, env):
    clean(root, env)
    current = run(["git", "branch", "--show-current"], root, env, True)
    if current != branch:
        raise RuntimeError(f"Run releases from the origin default branch ({branch}); "
                           "merge the reviewed changes first.")
    run(["git", "fetch", "origin", "--tags"], root, env)
    run(["git", "pull", "--ff-only", "origin", branch], root, env)
    clean(root, env)
    head = run(["git", "rev-parse", "HEAD"], root, env, True)
    remote = run(["git", "rev-parse", f"refs/remotes/origin/{branch}"], root, env, True)
    if head != remote:
        raise RuntimeError("Local commits are ahead of origin; push/merge them before releasing.")
    remote_tag = run(["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}"],
                     root, env, True)
    if remote_tag:
        raise RuntimeError("That tag already exists on origin. Existing releases are never replaced. "
                           "Use --install-only for a published release; see docs/releasing.md for recovery.")
    tags = run(["git", "tag", "--list", "v*"], root, env, True).splitlines()
    requested = tuple(map(int, VERSION.fullmatch(tag).groups()))
    versions = [tuple(map(int, match.groups())) for value in tags
                if (match := VERSION.fullmatch(value)) and value != tag]
    if versions and requested <= max(versions):
        raise RuntimeError("Choose a version newer than the existing stable version tags.")
    head_tags = run(["git", "tag", "--points-at", "HEAD"], root, env, True).splitlines()
    if any(value.startswith("v") and value != tag for value in head_tags):
        raise RuntimeError("HEAD already has a release tag; release a new commit instead.")
    if tag in tags:
        tagged = run(["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"],
                     root, env, True)
        if tagged != head:
            raise RuntimeError("The existing local tag points to another commit; it will not be moved.")
    else:
        run(["git", "tag", tag, head], root, env)


def install(repo, tag, prefix, root, env):
    print(f"Installing {tag} locally. Keep this command open while existing workers drain.", flush=True)
    # Use the installer attached to this published release, never a moving branch.
    with tempfile.TemporaryDirectory(prefix="tmatrix-release-install-") as temporary:
        run(["gh", "release", "download", tag, "--repo", repo, "--pattern", "install.sh",
             "--dir", temporary], root, env)
        command = ["sh", str(Path(temporary) / "install.sh"), "--repo", repo, "--version", tag]
        if prefix:
            command += ["--prefix", prefix]
        run(command, root, env)


def release(tag=None, install_only=False, skip_install=False, prefix=None, root=ROOT):
    if install_only and (tag or skip_install):
        raise RuntimeError("--install-only takes no tag and cannot use --skip-install.")
    if not install_only and (not tag or not VERSION.fullmatch(tag)):
        raise RuntimeError("Supply a stable version tag, for example v0.1.7.")
    if prefix and (skip_install or not Path(prefix).is_absolute()):
        raise RuntimeError("--prefix requires installation and an absolute path.")
    if not skip_install and not prefix and os.environ.get("TMATRIX_PREFIX"):
        if not Path(os.environ["TMATRIX_PREFIX"]).is_absolute():
            raise RuntimeError("TMATRIX_PREFIX must be an absolute path.")
    prerequisites(install_only, skip_install)
    env = dict(os.environ)
    info = repository(root, env)
    repo = info["nameWithOwner"]
    if install_only:
        # Resolve latest once, then pin both installer and bundle to that tag.
        tag = run(["gh", "release", "view", "--repo", repo, "--json", "tagName",
                   "--jq", ".tagName"], root, env, True)
        if not VERSION.fullmatch(tag):
            raise RuntimeError("Latest release must have a stable version tag.")
    else:
        prepare(tag, info["defaultBranchRef"]["name"], root, env)
        try:
            run([sys.executable, "scripts/release-local.py", tag, "--upload"], root, env)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"Build/upload failed for {tag}. The local tag is retained. "
                               "No publication or installation was attempted; "
                               "see docs/releasing.md before retrying.") from error
        try:
            run(["gh", "release", "edit", tag, "--repo", repo, "--draft=false", "--latest"], root, env)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"Publication failed for {tag}; the verified draft was uploaded. "
                               "Inspect its state on GitHub before retrying. "
                               "No local installation was attempted.") from error
        print(f"Published {tag}: https://github.com/{repo}/releases/tag/{tag}", flush=True)
    if not skip_install:
        try:
            install(repo, tag, prefix, root, env)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"Local installation failed for published {tag}. "
                               "Inspect tmatrix status: setup or a requested drain may still be running. "
                               "Publication is retained; use --install-only after resolving the error.") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=
        "Example: python3 scripts/release.py v0.1.7. "
        "Install latest only: python3 scripts/release.py --install-only.")
    parser.add_argument("tag", nargs="?", help="new stable version, e.g. v0.1.7")
    parser.add_argument("--install-only", action="store_true", help="install latest without pulling, tagging or publishing")
    parser.add_argument("--skip-install", action="store_true", help="publish without changing the local installation")
    parser.add_argument("--prefix", help="absolute install prefix (default: TMATRIX_PREFIX or ~/.local)")
    args = parser.parse_args()
    try:
        release(args.tag, args.install_only, args.skip_install, args.prefix)
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        parser.exit(1, f"Release failed: {error}\n")


if __name__ == "__main__":
    main()
