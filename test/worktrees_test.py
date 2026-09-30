"""Exercise destructive paths only inside disposable local repositories."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worktrees', Path(__file__).parents[1] / 'scripts/worktrees.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
TASK = '01a0b9e8-8f04-7c4f-97c2-a03122e10ce4'

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        completion = patch.object(w, 'human_completion', return_value=None)
        completion.start()
        self.addCleanup(completion.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        w.STATE = self.root / 'state'
        w.STATE.mkdir()
        self.repo = self.root / 'repo'
        w.run('git', 'init', '-b', 'main', str(self.repo))
        w.git(self.repo, 'config', 'user.email', 'test@example.invalid')
        w.git(self.repo, 'config', 'user.name', 'Test')
        (self.repo / '.gitignore').write_text('.env\nnode_modules/\n')
        (self.repo / 'file').write_text('saved')
        w.git(self.repo, 'add', '.')
        w.git(self.repo, 'commit', '-m', 'initial')
        w.git(self.repo, 'remote', 'add', 'origin', str(self.repo))
        self.data = {'version': 1, 'entries': {}, 'sessions': {'run': {'task': TASK}}}
        self.args = argparse.Namespace(repo=str(self.repo), task=TASK, extra='', intent='pr', session='run')

    def acquire(self):
        return w.acquire(self.data, self.args)

    def age(self):
        self.data['sessions'] = {}
        for e in self.data['entries'].values():
            e['last_use'] = time.time() - 8 * w.DAY

    def test_reuse_and_named_extra(self):
        first = self.acquire()['path']
        self.assertEqual(first, self.acquire()['path'])
        self.args.extra = 'experiment'
        self.assertNotEqual(first, self.acquire()['path'])
        self.assertEqual(len(self.data['entries']), 2)

    def test_acquire_does_not_remove_old_checkouts(self):
        old = self.acquire()
        self.age()
        self.args.task = '11111111-1111-4111-8111-111111111111'
        self.data['sessions']['run'] = {'task': self.args.task}
        self.acquire()
        self.assertTrue(Path(old['path']).exists())
        self.assertNotIn('removed', old)

    def test_cleanup_only_applies_to_reviewed_path_and_repository(self):
        first = self.acquire()
        self.args.extra = 'experiment'
        second = self.acquire()
        self.age()
        self.assertEqual(w.cleanup(self.data, True, self.root / 'other', Path(first['path'])), [])
        result = w.cleanup(self.data, True, self.repo, Path(first['path']))
        self.assertEqual(len(result), 1)
        self.assertFalse(Path(first['path']).exists())
        self.assertTrue(Path(second['path']).exists())

    def test_unscoped_cleanup_cli_is_rejected(self):
        script = str(Path(__file__).parents[1] / 'scripts/worktrees.py')
        for flags in (['--apply'], ['--repo', str(self.repo), '--apply']):
            result = subprocess.run([sys.executable, script, 'cleanup', *flags],
                                    env={**os.environ, 'AIWORKER_WORKTREE_STATE': str(w.STATE)},
                                    capture_output=True)
            self.assertEqual(result.returncode, 2)

    def test_intent_and_session_gate(self):
        self.args.intent = None
        with self.assertRaises(ValueError): self.acquire()
        self.args.intent = 'pr'
        self.data['sessions']['second'] = {'task': TASK}
        with self.assertRaises(ValueError): self.acquire()
        self.assertEqual(len(w.inventory(self.repo)), 1)

    def test_dirty_untracked_active_pinned_locked_protected(self):
        e = self.acquire()
        p = Path(e['path'])
        e['last_use'] = 0
        self.assertIn('session', w.cleanup(self.data, True)[0]['reason'])
        self.age()
        for filename in ('file', 'untracked'):
            (p / filename).write_text('unique work')
            self.assertIn('uncommitted', w.cleanup(self.data, True)[0]['reason'])
            if filename == 'file': w.git(p, 'restore', 'file')
            else: (p / filename).unlink()
        e['pinned'] = True
        self.assertEqual(w.cleanup(self.data, True)[0]['reason'], 'pinned')
        e['pinned'] = False
        w.git(self.repo, 'worktree', 'lock', str(p))
        self.assertIn('locked', w.cleanup(self.data, True)[0]['reason'])
        self.assertTrue(p.exists())

    def test_verified_remove_and_restore_ignored_configuration(self):
        e = self.acquire()
        p = Path(e['path'])
        (p / '.env').write_text('test configuration')
        (p / 'node_modules').mkdir()
        (p / 'node_modules' / 'dependency').write_text('restorable')
        head = w.git(p, 'rev-parse', 'HEAD')
        self.age()
        self.assertEqual(w.cleanup(self.data)[0]['reason'], 'eligible (dry run)')
        self.assertTrue(p.exists())
        self.assertIn('removed;', w.cleanup(self.data, True)[0]['reason'])
        self.assertFalse(p.exists())
        self.assertEqual(w.git(self.repo, 'rev-parse', e['branch']), head)
        self.data['sessions']['run'] = {'task': TASK}
        self.acquire()
        self.assertEqual((p / '.env').read_text(), 'test configuration')
        self.assertEqual((p / 'node_modules' / 'dependency').read_text(), 'restorable')
        self.assertEqual(w.git(p, 'rev-parse', 'HEAD'), head)

    def test_failed_backup_keeps_checkout(self):
        e = self.acquire()
        self.age()
        with patch.object(w.tarfile, 'open', side_effect=OSError('disk full')):
            self.assertIn('protected', w.cleanup(self.data, True)[0]['reason'])
        self.assertTrue(Path(e['path']).exists())

    def test_changed_during_backup_keeps_checkout(self):
        e = self.acquire()
        self.age()
        with patch.object(w, 'fingerprint', side_effect=[[], [('changed',)] ]):
            self.assertIn('protected', w.cleanup(self.data, True)[0]['reason'])
        self.assertTrue(Path(e['path']).exists())

    def test_terminal_grace_and_unknown_status(self):
        e = self.acquire()
        self.data['sessions'] = {}
        e['last_use'] = time.time() - 2 * w.DAY
        with patch.object(w, 'terminal_time', return_value=None):
            self.assertEqual(w.cleanup(self.data)[0]['reason'], 'not old enough')
        with patch.object(w, 'terminal_time', return_value=time.time() - 23 * 3600):
            self.assertEqual(w.cleanup(self.data)[0]['reason'], 'not old enough')
        with patch.object(w, 'terminal_time', return_value=time.time() - 25 * 3600):
            self.assertEqual(w.cleanup(self.data)[0]['reason'], 'eligible (dry run)')

    def test_existing_uuid_checkout_requires_adoption(self):
        w.git(self.repo, 'worktree', 'add', '-b', 'task/' + TASK, str(self.root / 'existing'))
        with self.assertRaises(ValueError): self.acquire()
        self.assertEqual(len(w.inventory(self.repo)), 2)

    def test_corrupt_archive_refuses_restore(self):
        e = self.acquire()
        self.age()
        w.cleanup(self.data, True)
        Path(e['recovery']['archive']).write_bytes(b'corrupted')
        self.data['sessions']['run'] = {'task': TASK}
        with self.assertRaises(ValueError): self.acquire()
        self.assertFalse(Path(e['path']).exists())

    def test_concurrent_acquire_serializes_and_reuses(self):
        w.save(self.data)
        script = str(Path(__file__).parents[1] / 'scripts/worktrees.py')
        command = [sys.executable, script, 'acquire', '--repo', str(self.repo), '--task', TASK, '--session', 'run', '--intent', 'pr']
        env = {**os.environ, 'AIWORKER_WORKTREE_STATE': str(w.STATE)}
        processes = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        outputs = [p.communicate(timeout=20) for p in processes]
        self.assertEqual([p.returncode for p in processes], [0, 0])
        self.assertEqual(json.loads(outputs[0][0])['path'], json.loads(outputs[1][0])['path'])
        self.assertEqual(len(w.inventory(self.repo)), 2)

    def test_unmanaged_checkout_is_not_removed(self):
        p = self.root / 'manual'
        w.git(self.repo, 'worktree', 'add', '-b', 'manual', str(p))
        self.assertEqual(w.cleanup(self.data, True), [])
        self.assertTrue(p.exists())

class StatusTests(unittest.TestCase):
    def test_only_current_human_done_counts(self):
        import io
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'poll_url': 'https://example.invalid/api/v1/ai/poll', 'api_key': 'test'}))
            with patch.dict(os.environ, {'CONFIG_PATH': str(config), 'POLL_URL': '', 'API_KEY': ''}):
                # Explicit env values are removed so fixture configuration is used.
                del os.environ['POLL_URL']
                del os.environ['API_KEY']
                for status in ('DONE', 'AI_DONE', 'TODO'):
                    response = io.BytesIO(json.dumps({'id': 123, 'clientId': TASK, 'status': status, 'completedAt': '2026-01-01T00:00:00Z'}).encode())
                    with patch.object(w.urllib.request, 'build_opener') as opener:
                        opener.return_value.open.return_value = response
                        value = w.human_completion({'task': TASK})
                        self.assertEqual(value is not None, status == 'DONE')
                with patch.object(w.urllib.request, 'build_opener', side_effect=OSError('offline')):
                    self.assertIsNone(w.human_completion({'task': TASK}))

if __name__ == '__main__':
    unittest.main()
