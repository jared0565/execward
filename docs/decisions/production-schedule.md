# The production Worker's database, backup bucket and timer

Date: 2026-11-23. Serves tasks 1.4.4, 1.4.5, 1.6.8 and 1.3.8; FR-24. Status: **deployed
and seen working on Cloudflare.**

## What changed

The production Worker had one binding, the Worker Loader. It now has three, and a timer.
(A fourth, `EMAIL`, was added on 2026-11-24: docs/decisions/1.6.7-email.md.)
Each was added to the allowlist (`src/worker/bindings.ts`) in the same change, with the
project owner's approval of the database, the R2 backups and the schedules.

| Added | What it is | Pinned to |
|---|---|---|
| `DB` | The Worker's own D1 database | The database named `execward`, by its id |
| `BACKUPS` | An R2 bucket for the daily backup | The bucket named `execward-backups` |
| Timer | Fires every five minutes | Exactly `*/5 * * * *` |

**The allowlist now pins what a binding points at, not only its name.** A binding called
`DB` that pointed at another database fails the configuration check, and so fails CI.
So does a second database, a second bucket, or any other timer.

On 2026-11-23 the Worker had no public address and held no credential. Since then it has
two addresses, each behind Cloudflare Access, and holds the GitHub App's key and
verification's model key (`ALLOWED_ROUTES`, `ALLOWED_SECRETS`).

## What the timer does (`src/worker/scheduled.ts`)

- **Every firing:** closes escalations past their time limit, and sends any reminder
  that is due.
- **The first firing of each UTC day that finds no backup for that day:** applies
  retention to the audit log, checks the reviewer model, sends the digest, sweeps old
  counters, trims old stats rows, then backs the database up to R2. (The reviewer check,
  the emails and the stats trim were added by later tasks.)

The day's backup is the marker that the daily round is done. If the backup fails, the
next firing tries again, so a failed round mends itself within five minutes.

A backup that worked does not mean every job did (changed 2026-11-26 after two review
findings). When retention, the counter sweep or the stats trim fails, a note is left
beside the day's backup (`backups/<day>.json.retry`, job names only) and each later
firing runs those three jobs again until they work, then deletes the note. Only those
three: they remove what is past its time and are safe to repeat. The digest and the
reviewer's check are not done twice. The note is deleted with its backup after seven
days if the jobs never worked.

A daily round is recorded in the audit log before it starts as well as after. If the
first record cannot be written, the round deletes nothing and takes no backup, and the
next firing tries again.

Each daily round is written to the audit log as counts. A frequent round is written only
when it did something or failed.

## Evidence

- Local runtime, 3 tests: the daily round runs once a day at the first firing; retention
  removes old text and an expired escalation is closed; a failed backup is retried.
- Configuration, 3 new tests: a second database or bucket, the right name pointed at the
  wrong resource, and any other timer are each refused.
- **On Cloudflare:** the three migrations were applied to the production database and
  the Worker deployed at 13:38 UTC. The timer first fired at 13:45:19 UTC. The audit log
  holds one `maintenance` entry for it, with all three jobs reported ok. The bucket
  holds `backups/2026-11-23.json`, 156 bytes, and its SHA-256 as downloaded matches the
  one the audit entry records.

## Limits

- **The first backup is of empty tables.** Production holds no data yet. Restoring a
  backup with real content was proven on the test Worker (task 1.4.5), not from this one.
- **Email is wired since 2026-11-24** (docs/decisions/1.6.7-email.md): reminders go out
  on every firing and the digest in the daily round. The digest still has no once-a-day
  marker of its own: a daily round that is done again because its backup failed sends it
  again.
- **Nothing alerts when the timer stops.** A missing backup is found by looking.
- **A database change needs its migration applied by hand** before the Worker that
  needs it is deployed. Nothing enforces the order.
- **Deploys are by hand.** `main` and what is deployed can differ. This change was
  deployed from its branch, then merged.
- **The Worker's bundle grew** from 2 KiB to about 1 MB, because the housekeeping pulls
  in the audit log, the queue and the schema library. Startup is 24 ms.
- **Counters and switches are used by the MCP route and the console** since Phase 2.
  When this was written no served route used them.
