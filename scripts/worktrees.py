#!/usr/bin/env python3
"""Conservative, local PR checkout lifecycle. All operations share an OS lock."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import stat
from datetime import datetime
import urllib.request
import urllib.parse
import tarfile
import time
import uuid

STATE = Path(os.environ.get('AIWORKER_WORKTREE_STATE', '~/.local/state/aiworker/worktrees')).expanduser()
DAY = 86400

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE).decode().strip()

def git(repo, *args):
    return run('git', '-C', str(repo), *args)

@contextlib.contextmanager
def registry():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = STATE / 'registry.json'
        data = json.loads(path.read_text()) if path.exists() else {'version': 1, 'entries': {}, 'sessions': {}}
        yield data
        save(data)

def save(data):
    """Commit recovery metadata atomically before touching a checkout directory."""
    temporary = STATE / 'registry.tmp'
    with temporary.open('w') as stream:
        temporary.chmod(0o600)
        json.dump(data, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(STATE / 'registry.json')
    fd = os.open(STATE, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def repo_root(path):
    common = Path(git(Path(path).expanduser(), 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    primary = git(common.parent, 'worktree', 'list', '--porcelain').splitlines()[0]
    return Path(primary.removeprefix('worktree ')).resolve()

def inventory(repo):
    result = []
    for block in git(repo, 'worktree', 'list', '--porcelain').split('\n\n'):
        fields = dict(line.split(' ', 1) if ' ' in line else (line, True) for line in block.splitlines())
        if 'worktree' in fields:
            result.append(fields)
    return result

def checkout_key(repo, task, extra):
    return hashlib.sha256(f'{repo}\n{task}\n{extra}'.encode()).hexdigest()

def fingerprint(path):
    """Record all local files, including ignored configuration, without reading secrets."""
    result = []
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(root) / name
            if p == path / '.git':
                continue
            s = p.lstat()
            result.append((str(p.relative_to(path)), s.st_mode, s.st_size, s.st_mtime_ns))
    return sorted(result)

def protection(entry, data):
    if entry.get('pinned'):
        return 'pinned'
    if any(entry['task'] == s['task'] for s in data['sessions'].values()):
        return 'active or unreleased session'
    path = Path(entry['path'])
    records = inventory(entry['repo'])
    record = next((r for r in records if r['worktree'] == str(path)), None)
    if not record or record.get('locked') or record.get('prunable'):
        return 'missing, locked, or prunable checkout'
    if record.get('branch') != 'refs/heads/' + entry['branch']:
        return 'branch changed'
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            mode = (Path(root) / name).lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                return 'special local file cannot be backed up'
    if git(path, 'status', '--porcelain', '--untracked-files=all'):
        return 'uncommitted or untracked work'
    if (path / '.git').is_symlink():
        return 'unexpected git metadata'
    metadata = Path(git(path, 'rev-parse', '--absolute-git-dir'))
    if any((metadata / name).exists() for name in ('index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'BISECT_LOG')):
        return 'git operation in progress'
    if git(path, 'submodule', 'status'):
        return 'submodules need manual handling'
    return None

def human_completion(entry):
    """Read current human DONE state; missing, reopened, and AI_DONE are not closure."""
    try:
        config_path = Path(os.environ.get('CONFIG_PATH', str(Path(__file__).resolve().parents[1] / 'config.json')))
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
        poll = urllib.parse.urlsplit(os.environ.get('POLL_URL', config.get('poll_url', '')))
        key = os.environ.get('API_KEY', config.get('api_key'))
        if poll.scheme != 'https' or not key:
            return None
        url = urllib.parse.urlunsplit((poll.scheme, poll.netloc, '/api/v1/tasks/' + entry['task'], '', ''))
        # Never forward the bearer token through a redirect.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + key, 'User-Agent': 'aiworker/0.1'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            task = json.load(response)
        if entry['task'] not in (task.get('id'), task.get('clientId')) or task.get('status') != 'DONE' or not task.get('completedAt'):
            return None
        return datetime.fromisoformat(task['completedAt'].replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

def terminal_time(entry):
    """Unknown or failing PR lookup never supplies evidence of closure."""
    completed = human_completion(entry)
    values = [completed] if completed is not None else []
    if entry.get('pr'):
        try:
            pr = json.loads(run('gh', 'pr', 'view', entry['pr'], '--json', 'state,closedAt,mergedAt', cwd=entry['repo']))
            if pr['state'] in ('CLOSED', 'MERGED'):
                stamp = pr.get('closedAt') or pr.get('mergedAt')
                if stamp:
                    values.append(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp())
        except (subprocess.SubprocessError, ValueError, KeyError):
            pass
    return min(values) if values else None

def cleanup(data, apply=False, repo=None, path=None):
    reports = []
    now = time.time()
    for key, entry in data['entries'].items():
        if repo is not None and entry['repo'] != str(repo):
            continue
        if path is not None and entry['path'] != str(path):
            continue
        if entry.get('removed'):
            continue
        try:
            reason = protection(entry, data)
            terminal = terminal_time(entry) if not reason else None
            eligible = now - entry['last_use'] >= 7 * DAY or (terminal is not None and now - max(terminal, entry['last_use']) >= DAY)
            reason = reason or (None if eligible else 'not old enough')
            if reason or not apply:
                reports.append({'path': entry['path'], 'reason': reason or 'eligible (dry run)'})
                continue
            path = Path(entry['path'])
            head = git(path, 'rev-parse', 'HEAD')
            before = fingerprint(path)
            recovery = STATE / 'recovery' / key / str(time.time_ns())
            recovery.mkdir(parents=True, mode=0o700)
            bundle = recovery / 'commits.bundle'
            git(path, 'bundle', 'create', str(bundle), 'HEAD', 'refs/heads/' + entry['branch'])
            git(path, 'bundle', 'verify', str(bundle))
            archive = recovery / 'checkout.tar.gz'
            # Preserve every ignored file too. Backups are private and are never
            # automatically expired; dependency-heavy trees trade space for safety.
            with tarfile.open(archive, 'w:gz', dereference=False) as tar:
                for child in path.iterdir():
                    if child.name != '.git':
                        tar.add(child, arcname=child.name)
            archive.chmod(0o600)
            digest = checksum(archive)
            with tarfile.open(archive) as tar:
                for member in tar:
                    tarfile.data_filter(member, str(path))
                    if member.isfile():
                        stream = tar.extractfile(member)
                        while stream.read(1024 * 1024):
                            pass
            if protection(entry, data) or head != git(path, 'rev-parse', 'HEAD') or before != fingerprint(path):
                raise RuntimeError('checkout changed during backup')
            # Recovery metadata is written before removal, so interruption is safe.
            manifest = {'head': head, 'archive': str(archive), 'sha256': digest, 'bundle': str(bundle)}
            (recovery / 'manifest.json').write_text(json.dumps(manifest))
            for saved in recovery.iterdir():
                with saved.open('rb') as stream:
                    os.fsync(stream.fileno())
            # Persist new recovery directory entries as well as file contents.
            # A machine crash must not leave a durable registry pointing at a
            # backup whose newly created directory names were never flushed.
            for directory in (recovery, recovery.parent, recovery.parent.parent):
                fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            entry['recovery'] = manifest
            # Persist before the irreversible directory operation.
            save(data)
            git(entry['repo'], 'worktree', 'remove', str(path))
            entry['removed'] = now
            reports.append({'path': str(path), 'reason': 'removed; branch and verified recovery retained'})
        except Exception as error:
            reports.append({'path': entry['path'], 'reason': f'protected: {type(error).__name__}'})
    data['last_cleanup'] = reports
    return reports

def acquire(data, args):
    if args.intent != 'pr':
        raise ValueError('Only explicit PR delivery intent may allocate a managed checkout')
    task = str(uuid.UUID(args.task))
    repo = repo_root(args.repo)
    key = checkout_key(repo, task, args.extra)
    entry = data['entries'].get(key)
    if not args.session or args.session not in data['sessions'] or data['sessions'][args.session]['task'] != task:
        raise ValueError('A matching active session is required')
    if any(sid != args.session and s['task'] == task for sid, s in data['sessions'].items()):
        raise ValueError('Another session owns this task; resume it or release its lease first')
    if entry is None:
        managed = {e['path'] for e in data['entries'].values()}
        matches = [r for r in inventory(repo) if r['worktree'] not in managed and (task in r.get('branch', '') or task in r['worktree'])]
        if matches:
            raise ValueError('Existing task checkout requires explicit adopt; inspect inventory first')
        path = repo.parent / f'{repo.name}-task-{task}{("-" + args.extra) if args.extra else ""}'
        branch = f'task/{task}{("-" + args.extra) if args.extra else ""}'
        if path.exists():
            raise ValueError('Destination already exists; refusing a suffixed duplicate')
        git(repo, 'fetch', 'origin', 'main')
        git(repo, 'worktree', 'add', '-b', branch, str(path), 'origin/main')
        entry = {'repo': str(repo), 'path': str(path), 'task': task, 'branch': branch, 'last_use': time.time()}
        data['entries'][key] = entry
    elif entry.get('removed'):
        recovery = entry['recovery']
        archive = Path(recovery['archive'])
        if checksum(archive) != recovery['sha256']:
            raise ValueError('Recovery archive checksum mismatch')
        if git(repo, 'rev-parse', 'refs/heads/' + entry['branch']) != recovery['head']:
            raise ValueError('Saved branch moved; manual recovery required')
        git(repo, 'worktree', 'add', entry['path'], entry['branch'])
        with tarfile.open(archive) as tar:
            tar.extractall(entry['path'], filter='data')
        del entry['removed']
    else:
        records = inventory(repo)
        if not any(r['worktree'] == entry['path'] and r.get('branch') == 'refs/heads/' + entry['branch'] for r in records):
            raise ValueError('Checkout missing or changed; inspect recovery metadata')
    entry['last_use'] = time.time()
    return entry

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inventory', 'acquire', 'adopt', 'cleanup', 'session-start', 'session-end', 'touch', 'pin', 'unpin', 'pr'])
    parser.add_argument('--repo')
    parser.add_argument('--task')
    parser.add_argument('--extra', default='')
    parser.add_argument('--session')
    parser.add_argument('--intent', choices=['pr'])
    parser.add_argument('--path')
    parser.add_argument('--url')
    parser.add_argument('--apply', action='store_true', help='Actually remove eligible checkouts; omitted means dry run')
    args = parser.parse_args()
    if not re.fullmatch('[a-zA-Z0-9_-]*', args.extra):
        parser.error('extra must be a simple checkout name')
    with registry() as data:
        if args.action == 'session-start':
            task = str(uuid.UUID(args.task))
            data['sessions'][args.session] = {'task': task, 'started': time.time()}
            result = {'session': args.session}
        elif args.action == 'session-end':
            session = data['sessions'].pop(args.session, None)
            for e in data['entries'].values():
                if session and e['task'] == session['task']:
                    e['last_use'] = time.time()
            result = {'released': bool(session)}
        elif args.action == 'cleanup':
            if not args.repo or (args.apply and not args.path):
                parser.error('cleanup requires --repo; --apply also requires a reviewed --path')
            result = cleanup(data, args.apply, repo_root(args.repo), Path(args.path).resolve() if args.path else None)
        elif args.action == 'inventory':
            result = inventory(repo_root(args.repo))
        elif args.action == 'acquire':
            result = acquire(data, args)
        else:
            repo = repo_root(args.repo)
            task = str(uuid.UUID(args.task))
            key = checkout_key(repo, task, args.extra)
            if args.action == 'adopt':
                path = str(Path(args.path).resolve())
                record = next(r for r in inventory(repo) if r['worktree'] == path)
                if key in data['entries'] or any(e['path'] == path for e in data['entries'].values()):
                    raise ValueError('Checkout already registered')
                if args.intent != 'pr' or task not in record.get('branch', '') or path == str(repo):
                    raise ValueError('Adoption requires PR intent and full UUID in branch; manual/ambiguous trees stay unmanaged')
                data['entries'][key] = {'repo': str(repo), 'path': path, 'task': task, 'branch': record['branch'].removeprefix('refs/heads/'), 'last_use': time.time()}
            entry = data['entries'][key]
            if args.action == 'pin': entry['pinned'] = True
            if args.action == 'unpin': entry['pinned'] = False
            if args.action == 'touch': entry['last_use'] = time.time()
            if args.action == 'pr':
                if not args.url or not re.fullmatch(r'https://github.com/[^/]+/[^/]+/pull/\d+', args.url):
                    raise ValueError('A canonical GitHub PR URL is required')
                owner = run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner', cwd=entry['repo'])
                pr = json.loads(run('gh', 'pr', 'view', args.url, '--json', 'headRefName', cwd=entry['repo']))
                if not args.url.startswith('https://github.com/' + owner + '/pull/') or pr['headRefName'] != entry['branch']:
                    raise ValueError('PR must belong to this repository and checkout branch')
                entry['pr'] = args.url
            result = entry
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
