# Version checks and authorized Pharaoh rebuilds

Guidance can become stale as Pharaoh evolves. Inspect the configured installation before proposing a migration or diagnosing routing behavior. Updating source and rebuilding are optional maintenance actions requiring authorization, not prerequisites for every production job.

## Discover before changing

Configure `PHARAOH_ROOT` for the checkout and `PH` for the executable actually used by the workflow. Consult the current README and build instructions; do not assume a specific build directory, default branch, package manager, or GPU.

For a Git checkout, read-only checks include:

```bash
git -C "$PHARAOH_ROOT" status --short --branch
git -C "$PHARAOH_ROOT" rev-parse HEAD
git -C "$PHARAOH_ROOT" remote -v
git -C "$PHARAOH_ROOT" branch -vv
"$PH" --version
```

Remote-tracking refs may be stale. Fetch only when authorized and network access is appropriate. Once a tracking ref has been verified, inspect both local-only and incoming changes using its actual name. Do not assume `origin/master` or any other branch exists.

Record a recovery point in an approved project-managed note or backup before an authorized update. Understand local modifications and repository policy. Never discard another contributor's work or perform an unconditional pull. Choose an explicit merge/rebase/fast-forward policy only after reviewing divergence and obtaining any needed approval.

## Verify behavior, not keyword counts

A removed engine can leave deliberate backward-compatibility fields or metadata readers. Classify remaining references by function: active routing, schema compatibility, historical asset interpretation, tests, or documentation. A raw search count cannot establish whether live generation still uses an old engine.

For suspected fallback, read persisted voice assignment and take provenance. File times are supporting evidence, not proof of which routing gate ran. Some tested versions gated cloning on a non-empty reference path while older ones used a legacy pipeline field; inspect the active implementation rather than applying either rule universally.

## Build only by the checkout's current instructions

Use the documented toolchain, dependency versions, and build entry point for the selected revision. No fixed build duration, CPU count, debug/release path, or installed dependency set is assumed here. A release binary can be stale; a debug binary can be current. Trust verified provenance and capabilities rather than the directory label alone.

Wait for the real build process's exit status and inspect its output. If using a runner with background-job support, track the build command itself, not a detached shell launcher. A launcher exiting successfully does not mean compilation finished.

After a successful build:

- Configure `PH` to the intended artifact explicitly.
- Run version and capability smoke checks relevant to the production task.
- Confirm the artifact belongs to the expected revision using available build metadata; a modification time alone is insufficient.
- Run a small representative test before a bulk generation or render.
- Update version-sensitive guidance if behavior changed, documenting uncertainty where provenance cannot be established.

An upstream change may already implement a planned migration or fix. Read current source/docs before designing new changes; updating the checkout is not required merely to inspect it. Source edits, commits, and pushes require their own authorization.
