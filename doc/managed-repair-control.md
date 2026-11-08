# Managed repair control

Opt-in enforcement for issues that a board operator enrolls. Ordinary issues have no row in `issue_managed_repairs` and keep the previous behavior.

This document is the install and rollback note for the user-owned fork. It is not a production change.

## Provenance

The installed release is npm `paperclipai@2026.1012.0`.

- Registry tarball: `https://registry.npmjs.org/paperclipai/-/paperclipai-2026.1012.0.tgz`
- Integrity: `sha512-dFAKM7DbuO/S+akBnDLgNShdnsP5vN+XrLi22ec4dEnla3pAgW7gcmaRyDkzJO26T51fbEYerOE+014v3u4udA==`
- Shasum: `90c6a5d832ee4540c8cb33ba1cc2fcc993d396b8`
- The packument has no `gitHead`.
- SLSA provenance (https://slsa.dev/provenance/v1) for `paperclipai` and `@paperclipai/server` records GitHub Actions workflow `.github/workflows/release.yml` on `refs/heads/master`, git commit `82274853729f8c5b0f812da08595020f7eb64d66`, invocation `https://github.com/paperclipai/paperclip/actions/runs/38291141170/attempts/1`.

That commit is the base of this branch. It is not current `master`. It is not git tag `v2026.1012.0`.

| Ref | Commit | Relation |
| --- | --- | --- |
| Published source | `82274853729f8c5b0f812da08595020f7eb64d66` | This branch base |
| Tag `v2026.1012.0` | `bba6a45f0d364cfd962ac59b3bdf2426a8222adb` | Not an ancestor of the published commit |
| Merge base of tag and published commit | `22a3ea3414e9039a538fbb0374b3cfa7fc4371eb` | Tag has 2 commits the published commit lacks. The published commit has 225 commits the tag lacks. |

The source package version in git is `0.3.1`. The release workflow stamps `2026.1012.0` at publish time. Do not fast-forward this branch onto current `master`. Do not treat the git tag as the installed bytes.

## What the gate does

Enrollment starts with `liveHold = true`. A hold stays until an explicit board grant or hold call clears it. Issue status changes do not clear it. Comment text, `authorType`, a reviewer PASS, a run id, a quoted instruction, and a coordinator claim do not grant scope and do not clear a hold.

Live execution (`todo`, `in_progress`, checkout, and a live wake) needs all of the following:

- a durable owner (`ownerUserId` or `ownerAgentId`)
- a concrete next step (trimmed length at least 8, and it contains whitespace)
- no evidenced blocker
- an active authorization (`explicit_board_grant`, version greater than 0, granted by a user)
- `liveHold = false`
- scope that allows the live action (`execute_next_step`, `mutate_status`, or `checkout`)
- dispatch not halted

A live hold denies that live work only. It does not block a same-status update, a non-executing status such as `in_review` or `blocked`, or a dispatch whose grant scope is `read` or `offline`. Those paths leave `liveHold` true. `done` still needs independent QA of the exact saved result. A board operator can set `cancelled` without that evidence. An agent cancel still needs the verified stage. The route sets the board stop only from `actor.type === "board"`. A request body cannot set it.

An in-flight managed-repair wake does not merge a second trigger into the running task, and it does not queue a second run. The same intent joins that run and does not change its context. A different intent is stored as `deferred_issue_execution` and is claimed once when it is later promoted. This also applies when the in-flight run is already running and a comment would otherwise queue a follow-up. Ordinary issues keep the previous coalesce and follow-up behavior.

Scope names:

- `execute_next_step` allows wakes and status changes
- `mutate_status` allows status changes
- `checkout` allows checkout

`done` and `cancelled` are allowed only from stage `independently_verified` or `closed`. `applied` needs `savedResultVersion` and `savedResultEvidenceRef`. Verification needs a latest QA verdict with `kind = qa`, `source = independent_review`, outcome `PASS`, and `artifactVersion` equal to the saved result version. A later FAIL for that version replaces the PASS. Monitor notes are not QA. The owner cannot verify their own result. An agent reviewer is self-approval and is rejected.

Wake claims use the unique key `(issue_id, intent_key)`. The same direct wake, comment, idle next step, or automatic retry either wins the claim or is a replay. One failure halts further dispatch until a board grant sets `clearHalt`. The idle scan uses the existing `tickTimers` loop. The default idle threshold is 20 minutes (`1_200_000` ms). There is no second scheduler.

Board routes live under `/api/companies/:companyId/issues/:issueId/managed-repair`. The actor comes from the authenticated board session. The request body cannot supply `authorType`, comment text, or an authority source. Schemas are strict.

## What the gate does not do

`MANAGED_REPAIR_DISPATCH_GATE_SCOPE` is `native_paperclip_issue_mutation_and_wake`.

The gate does not stop shell commands, browser actions, or other side effects outside Paperclip issue mutation and heartbeat/wake dispatch. It is not marketplace-wide protection. A database superuser can still write rows directly. A second managed-repair trigger does not merge into an in-flight run. The same intent joins that run without changing its context. A different intent is deferred and claimed once on promotion. Unassigned idle next steps are not woken, because there is no assignee. Timer heartbeats with no issue id are outside the gate. Agents cannot enroll or grant scope.

## Schema

Migration `0335_managed_repair_control` adds three tables:

- `issue_managed_repairs`
- `managed_repair_verdicts`
- `managed_repair_wake_claims`

It does not alter existing tables. Old application code ignores the new tables. New application code queries them on every gated wake, including ordinary issues. Apply the migration in the same install as this build. If the new code starts before the migration, ordinary wakes fail on the missing relation.

Rollback of the application can leave the tables in place. Do not drop them as the rollback step. Restore a database backup when you need the previous schema.

## Build a pinned package

Do this on a machine that is not the production Mac mini, or in a directory that is not `~/.paperclip`.

1. Check out this branch. Confirm `git rev-parse HEAD` is this branch and `git merge-base --is-ancestor 82274853729f8c5b0f812da08595020f7eb64d66 HEAD` succeeds.
2. Install and build from this checkout. Do not `npm install -g paperclipai`. The repo engines field asks for Node `>=24.11.0`. This checkout installed with Node `v22.23.4` because `.npmrc` does not set `engine-strict`. Use Node 24 for the package you install.
3. Pack the built CLI with the package manager this repo uses (`pnpm pack` in `cli/` after the repo build). Record the tarball checksum.
4. Keep the npm tarball `paperclipai-2026.1012.0.tgz` (integrity above) as the rollback artifact.

`pnpm install --frozen-lockfile` completed on this checkout. `pnpm --filter @paperclipai/shared typecheck` and `pnpm --filter @paperclipai/db typecheck` passed. The database check includes migration numbering and migration safety. `pnpm --filter @paperclipai/server typecheck` compiled the runner, then `tsc` reported the errors fixed in this revision. `pnpm --dir server exec tsc --noEmit --pretty false` then passed. A full `pnpm build` and `pnpm pack` were not run.

## Backup, install, and rollback

Do not run these steps against the live instance until an independent review accepts the build. They are the procedure for that later install.

Backup, before any install:

1. Stop is not part of this change. When you later choose a maintenance window, stop the LaunchAgent only then.
2. Dump the local Postgres database for the `default` instance.
3. Copy the instance directory that `paperclipai run --instance default` uses.
4. Copy `~/.paperclip/cli/installs/npm/2026.1012.0` and `~/.local/bin/paperclipai`.
5. Confirm the dump restores on a scratch database before you change the live files.

Install, later:

1. Point the managed CLI pin at the packed tarball from this branch. Do not edit files inside the installed `2026.1012.0` directory.
2. Apply migration `0335` with that build's migrator.
3. Start the instance only after the migration succeeds.
4. Enroll one synthetic issue. Confirm `liveHold` is true and a comment does not start a run.

Rollback:

1. Stop the instance in the maintenance window.
2. Put back `~/.local/bin/paperclipai` and the `2026.1012.0` payload from the backup.
3. Restore the Postgres dump if the new tables or any other writes must disappear. Leaving the new tables in place is safe for the old code.
4. Start the previous LaunchAgent command: `~/.local/bin/paperclipai run --instance default`.

## Tests run here

Policy suite, 14 passed, 0 failed, Node `v22.23.4`:

```sh
node --experimental-strip-types --test packages/shared/src/managed-repair-control.suite.ts
pnpm --filter @paperclipai/shared exec tsc --ignoreConfig --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --types node src/managed-repair-control.suite.ts
```

The suite file imports `./managed-repair-control.ts` so Node can run it without a build. `packages/shared/tsconfig.json` excludes `src/**/*.suite.ts` so the package typecheck keeps the normal `.js` import rule.

Isolated Postgres, HTTP, and service tests, 6 passed, 0 failed:

```sh
pnpm install --frozen-lockfile
node scripts/ensure-plugin-build-deps.mjs
pnpm --dir server exec vitest run --config vitest.config.ts src/services/managed-repair-control.integration.test.ts
```

That file applies migration `0335` on a scratch database, checks that it follows journal entry `0334_rare_slipstream` from commit `82274853729f8c5b0f812da08595020f7eb64d66`, and checks that `ALTER TABLE` touches only the three new tables. It uses `deploymentMode: "authenticated"`. A missing bearer is 401. An agent key cannot enroll. A body with `authorType` or comment text is 400. A board key can enroll. `read` and `offline` scope can dispatch while `liveHold` stays true, and that dispatch creates no heartbeat run. Checkout and `in_progress` stay denied. A user comment does not change `authorizationVersion`. Board `cancelled` does not need saved-result evidence and does not clear the hold. `done` still needs independent QA. A succeeded run does not halt. A later `failed` run halts once. A repeated failure note does not increment again. An enqueue denial does not halt. Two concurrent claim transactions leave one row and one 409 replay. A second comment on a queued or running managed-repair run does not create a second run and does not change the in-flight context. The same comment joins. A different comment is `deferred_issue_execution`. An ordinary issue still coalesces into one run.

Not run: `pnpm verify`, `pnpm -r typecheck`, `pnpm build`, `pnpm pack`, and any check of the installed npm payload or the production database. No production access, restart, deploy, or merge was performed. Independent review and a real install check come after this pull request.
