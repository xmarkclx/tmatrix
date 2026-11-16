# Engine launch logs

TMatrix captures the engine's stdout and stderr in `engine-launch.log` inside its
private configuration directory, usually `~/.config/tmatrix`.

The active file is limited to 10 MiB. TMatrix keeps three numbered backups,
`engine-launch.log.1` through `engine-launch.log.3`, with `.1` holding the newest
backup. Each new rotation replaces the oldest backup. Files use owner-only
permissions. Rotation continues while the engine runs, including after a terminal
console or `tmatrix engine start` exits.

At startup, oversized historical files retain their newest 10 MiB. An active
file at the 10 MiB limit then becomes the newest backup. A smaller active file
continues receiving appends. Logging retains at most 40 MiB across the active
file and backups.

If a log write or rotation fails, the daemon requests graceful shutdown and
drains active workers before returning `engine launch log failed`. Failures
include a full disk and permission errors when rotation renames or removes files.

The daemon owns the log writer and keeps it open until the engine finishes its
shutdown. A service restart is needed to activate this behavior in an existing
installation. Rebuilding the source does not update or restart an installed
service.

Structured worker logs in `logs/` keep their existing rotation policy.
