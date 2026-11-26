# The aramid model review's findings, sorted (2026-11-26)

aramid is the gate on this repository. Besides its fixed checks it has a model read each
change, and what the model reports is kept in aramid's ledger. On 2026-11-26 the ledger
held 131 open findings: 23 from the model review, 106 test mutants that no test caught,
and two notes on a research script. Nobody had read the 23. This is the record of reading
them.

Each of the 23 was checked against the code as it stood that day, except where a row
says otherwise. The project owner chose to fix the six that were real, on the live path
and cheap. The other seventeen are listed here so that none is lost. They stay open in
the ledger. None was overridden or resolved by hand.

The short name in the first column is the start of the finding's ID in the ledger
(`aramid ledger filter --status open`).

## Fixed on 2026-11-26

| Finding | Where | What was wrong | Fixed in |
|---|---|---|---|
| `f60d785cf1e1` | `src/tools/github-inventory.ts` | Seven GitHub tools classed internal and not sensitive passed GitHub's whole reply on: issue bodies, pull request descriptions, release notes, whole commit messages, email addresses | PR 122 |
| `671ebce3fbc4` | `src/code-tool/stored-attempts.ts` | A run that succeeded late could erase a retry-limit closure written while it ran | PR 123 |
| `eabb92e5f441` | `src/mcp/adapter.ts` | A failed project lookup in the adapter gave the service a count that is not stored | PR 123 |
| `f5ef0d788660` | `src/worker/scheduled.ts` | A backup that worked marked the day as done although a clean-up job had failed | PR 124 |
| `9b364b4be18a` | `src/worker/scheduled.ts` | The daily round deleted first and wrote its audit entry last | PR 124 |
| `f33467432a67` | `src/console/page.ts` | The stop button was switched off while any console request was on its way, and requests had no time limit | PR 125 |

## Real, less urgent, not fixed

| Finding | Where | What it says | Note |
|---|---|---|---|
| `58915a7aefae` | `.github/workflows/release.yml` | The release job holds a token that can write to the repository while it installs dependencies and runs the tests. `advisories.yml` has the same pattern | Split into a read-only build job and a publish job. No release has been tagged through it as far as this reading knows |
| `db75312e210b` | `test/deployed/github.deployed.ts` | The write-refusal test accepts a 404, which a wrong repository name also gives | The console's GitHub write check is a second control for the same question |
| `09213084a80a` | `src/executor/dynamic-worker.ts` | A sandbox failure is classed as a CPU or memory limit by matching text anywhere in the error message. A script that could make the runner fail with those words would turn a security fault into an ordinary limit | Whether a script can do that was not tested |
| `ef7e6be88484` | `src/broker/broker.ts` | A sensitive tool's rejected result still tells the script which of two error codes applied, and is not counted as a sensitive read | Small while no outbound tool exists |
| `eafe3706f800` | `src/service.ts` | Refusing a project with no record is something an entry point must ask for. The default lets it run as `public` | The code graph lists production and the adversarial target as the only builders outside tests, so nothing live is open. A new entry point would be |
| `c42d2eb11512` | `docs/decisions/production-schedule.md` | Nothing ties the code that is live to a commit that was reviewed | Deploys are made by hand from `main` after a merged pull request |
| `1a8dc5ed3d70` | `src/worker/deployed-check.ts` | `check:deployed` compares bindings, secrets and the compatibility date. It does not look at routes, custom domains or a workers.dev address | The finding's premise, that production has no public address, is out of date: it is served on two domains behind sign-in |

## Limits of the design, to decide before client data

| Finding | Where | What it says |
|---|---|---|
| `2eaede924aa0` | `src/backup.ts` | A backup's hash is kept beside the backup, so it catches damage but not someone who can rewrite both |
| `98e08b21024b` | `src/backup.ts` | A restore brings back text that retention or an erasure request removed after the backup was taken, and nothing applies them again |
| `6ddb83252d9d`, `0a0a21da547f` | `src/mcp/adapter.ts`, `src/mcp/production.ts` | A project is checked for having a record, not for belonging to the caller. A model could move to another known project for a fresh retry limit. There is one owner and two projects today |
| `fd7bd87f778b` | `src/static-check/check.ts` | The list of names that count as probing misses some Workers globals. A script that uses one is still refused; it is told it may try again. The project owner chose this split on 2026-11-23 |
| `da7146f34b13`, `c9f696c571ab` | `test/workers/wrangler.deployed.jsonc`, `test/deployed/github.deployed.ts` | The test Worker has a public address behind one shared secret, runs scripts with limits the caller chooses, and holds a read-only GitHub token |
| `ec8a4d0dd128` | `docs/reviews/2.3.3-sandbox-review.md` | Quota credits refunded after midnight lower the next day's count. Already recorded as left open by the second sandbox review |

## Needing nothing now

| Finding | Where | Why |
|---|---|---|
| `d42981e700cf` | `docs/decisions/1.6-control-state.md` | It says direct calls go round the broker when Code Mode is off. On the MCP server a direct call is turned into a script and goes through the same service. The decision record's line is about the earlier test app, which this reading did not check |
| `0171b65105a7` | `docs/decisions/1.3.3-argument-validation.md` | It is about an allowlisted host resolving to an internal address. Every tool's destination list is empty and the one connector sends only to GitHub's API host. It applies when a tool that fetches a URL is added |

## The other 108

106 are test mutants that survived: a number or a condition was changed and no test
failed. They measure how strong the tests are and are not faults in themselves. Two are
a lint note and a missing-test note on `docs/research/data/compare-arms.py`. None was
read one by one.
