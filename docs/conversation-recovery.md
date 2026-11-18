# Recovery after a forced stop

TMatrix holds a lock while a handoff owns its conversation. After a crash, TMatrix must confirm that the previous runtime and its child processes have stopped before it resumes that conversation.

On Linux with writable cgroup v2 support, each new Codex handoff gets a separate kernel process group. The managed systemd user service enables delegation for these groups. Detached child processes stay in the handoff's cgroup.

Recovery stops the old group and removes it before it clears the conversation lock. A launcher that was delayed until after recovery cannot enter the removed group and exits without starting Codex. Normal runtime shutdown also checks the group before it acknowledges completion.

This avoids inspecting the environments of unrelated processes. Protected SSH or PHP processes no longer block recovery for these handoffs. Conversation history and reply routing remain intact.

Older locks and hosts without writable cgroup v2 support retain the previous conservative recovery checks. TMatrix does not clear a lock merely because it is old. If those checks cannot prove shutdown, the offline recovery command still requires confirmation that the runtime stopped.

## Verify recovery on Linux

Run the process tests inside an isolated delegated systemd scope. These tests use fictional tasks and temporary state. They kill only their fixture processes.

```sh
systemd-run --user --scope --quiet --property=Delegate=yes \
  --unit=tmatrix-recovery-check \
  env TMATRIX_TEST_CGROUPS=1 \
  ./node_modules/.bin/vitest run test/conversation-cgroup-process.test.ts
```

The tests kill a fixture owner, recover its conversation, and verify that detached descendants stop while unrelated work survives. They also delay a launcher until after recovery and verify that its payload cannot run.

The process tests require Linux cgroup v2, `cgroup.kill`, and a systemd user manager that permits delegation. The regular test suite skips these tests unless `TMATRIX_TEST_CGROUPS=1` is set.
