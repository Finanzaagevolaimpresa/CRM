# R23: one read delegated to the authenticated Codex SSH account

The effective Desktop tool now authenticates through its managed SOCKS5 proxy as
`fai-codex` (uid/gid1001) on `fai-crm-prod-02`. It has neither Docker socket access
nor sudo commands. The approved R22 observer requires `faiadmin` (uid/gid1000)
to inspect the stopped run `e67bea4040fc4aeb86a0c98ac6178e7e`.

This delta installs **one read-only sudo command**. It does not install a release
service, grant the Docker group, allow root execution, or accept a command, path,
run ID, payload or stage from the caller. Backup, migration and deployment remain
outside this delegate. PR154 is not a prerequisite for the assisted release.

## Exact scope

`sudo -n -u faiadmin /usr/bin/python3.14 -I -B -S /usr/local/lib/fai-crm-m1-r23-read/delegate.py`

The rule contains the exact executable and complete arguments, on one line,
with `NOPASSWD: NOSETENV:` and no wildcards. The installed directory and programs
belong to root and are not writable by either CRM account. The caller and target
identities, host, Python flags, Python binary hash and observer hash are checked.
A nonblocking lock permits one observation at a time; the child inherits the
lock so a disconnected controller cannot admit an overlapping observation.
The child has no stdin, a fixed environment and a 125-second timeout.

The observer reuses the previously prepared R22 source with one necessary fix:
the image-inspect JSON format now closes its outer object. Both image/container
formats have regression coverage. The old local R22 source is preserved;
the corrected observer is pinned as `94743eaa…`.
It verifies the existing package, STOP receipt and no later stage
intent, then exports only the image-store backend, the two qualified image
identities/label/layer matches, and minimal states of the two bound containers.
It does not change the existing package, intent markers, receipts or containers.
Failures are minimized; raw stderr is not returned.

## Installation and removal

The owner installer must run via the existing `faiadmin` SSH profile and
noninteractive sudo. It refuses a different host/account, changed Python,
unprotected parent directory, or any occupied installation destination.
It validates the rule and complete sudoers configuration with the installed
`visudo` before activating the new rule. No SSH configuration or key is changed.

Only `/usr/local/lib/fai-crm-m1-r23-read` (five files) and
`/etc/sudoers.d/fai-crm-m1-r23-read` are created. Partial installation rolls back
only files exclusively created by that invocation. The root-only uninstall
requires the exact installed files, rule and receipt, and refuses an observation
in progress. It removes only this delegate; historical release artifacts stay.
The owner launcher retains a separate local installation/removal receipt.

Syntax was checked read-only against the actual server's `sudo-rs 0.2.13`:
`visudo -c -f -` returned zero and `stdin: parsed OK`, without editing sudoers.
The supported exact argument matching is documented in the
[sudo-rs v0.2.13 manual](https://github.com/trifectatechfoundation/sudo-rs/blob/v0.2.13/docs/man/sudoers.5.man).
No unsupported command-digest syntax is assumed; root protection plus runtime
hash validation pins the programs instead.

## Verification and limits

Focused tests cover package substitution, extra files, exact command arguments,
output minimization, unexpected observations and both possible image ID forms.
Linux additionally checks unsafe file paths, exclusive-create preservation and
rejection of the wrong caller before spawning a process. Installation and actual
delegated observation require their own real receipts; source/CI success does
not attest either. Persistence after reopening Desktop is still a separate check.

The historical image failure identifies `INSPECT_IMAGE`, exit1, and the exact
missing candidate config digest. Containerd/manifest identity remains an
unconfirmed explanation until the R22 observation returns. The older backup
COMMAND_FAILED receipt still cannot identify its failing subcommand; this delta
does not attribute a speculative cause or consume another backup attempt.
