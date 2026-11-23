# ExecWard build tasks

> This file is the task list of record (owner decision, 2026-11-22). Update statuses here, in the same commit as the work.
> It began as a copy of the Tasks tab of the [ExecWard PRD](https://claude.ai/artifact/WEX63ZAdngc4fwBdr6EVDh), which now points here.
> "Traces to" names PRD sections and requirement IDs.

The tasks turn the PRD's 52 requirements, its non-functional requirements, decisions and gates into buildable work, in the Build plan's security-first order. Each row traces to the PRD and names the test that proves it done. Rows waiting on an open question are marked Blocked, and Flags lists the places where the PRD needs a fix.

Task IDs extend the Build plan's workstream numbers: 1.2.3 is the third task in workstream 1.2. A task starts only when everything in its Depends on column is done, and every task waits for the previous phase's gate. Decision rows with no dependencies, such as 1.9.1 and 4.1.5, can be settled at any time.

Priority is the highest priority among the PRD requirements a task traces to; a dash means it traces to none (non-functional, governance or decision work). Status is one of Not started, In progress, Blocked or Done.

**Decided 2026-11-22.** The in-app adapter runs in a small test app in this repo (1.9.1). Gate 1's sandbox review is done by a second model family (1.9.7), and a paid human review follows before real client data or writes (G.10). The flag fixes go into the PRD as suggestions for the owner to accept (0.1.13). Dynamic Workers are confirmed as the sandbox (0.1.2). Oversized tasks are split into smaller rows when their phase starts, not before. The repo is public at github.com/jared0565/execward. Every change reaches main through a pull request with green CI; direct pushes are refused. The eval starts on the cheapest current model of each family, Claude Haiku 5.5 and GPT-6 Luna at each model's default effort, and steps up to larger models only where the results call for it, with the owner's approval. Eval calls go through OpenRouter first and fall back to the provider's own API when OpenRouter fails; the owner holds API keys for OpenRouter, Anthropic and OpenAI (see docs/decisions/0.2.2-eval-harness-and-routes.md).

**Cost reminders.** Cloudflare Workers Paid ($5 a month) is needed from the first sandbox test in Phase 1 (task 1.2.1), because Dynamic Workers run only on that plan; runs cost about $0.002 each after the first 1,000 a month. GitHub Free is enough through Phase 2. Start GitHub Pro (about $4 a month) before task 3.2.1, when ExecWard first writes code to a private repo, or earlier if private-repo Actions minutes pass half the monthly allowance (GitHub > Settings > Billing). See task 3.1.9 and flag 14. A paid human security review (G.10) comes before real client data or writes. Eval model calls are paid per token: Haiku 5.5 and GPT-6 Luna both cost $0.10 input and $0.50 output per million tokens (provider price pages, 2026-11-22), and OpenRouter charges the same plus 5.5% when credits are bought. One pass of the 30-task suite on both models cost $0.19 (measured 2026-11-22), and the Phase 0 baseline (0.2.5, 600 runs) cost $1.40. All eval work on 2026-11-22 came to about $2.93. Every paid run needs a stated cap (`--cap`), and the runner stops starting runs once it is reached. The only standing model cost is the daily golden tasks (2.2.4).

## Phase 0: Baseline

Exit: a baseline report per model and task type, and the threat model signed off, before any build starts.

### 0.1 Decisions and threat model sign-off

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 0.1.1 | Mark the nine decisions confirmed and cut Open questions to the six still open | Decisions table; Open questions; Flags 6, 7 | — | Each decision row reads confirmed; Open questions lists only open items. Done 2026-11-22 (PRD revision 195): the table's column now reads "Decision (confirmed)" for all ten rows; three rows that still said "unchecked" or "no source" now carry the results of tasks 0.1.2, 0.1.5 and 0.1.7; Open questions lists the four still open (the personal data duties check was answered by 0.1.7, so four remain, not six) | — | Done |
| 0.1.2 | Check Dynamic Workers' release status, limits and pricing | Decision: sandbox and hosting; Risk: platform dependence | — | Status, CPU, memory and time limits and price per run recorded with sources; go or no-go noted. Done: go, owner decision 2026-11-22; see docs/research/0.1.2-dynamic-workers.md | — | Done |
| 0.1.3 | Define the executor interface and name a second implementation path | Decision: sandbox and hosting; Risk: platform dependence | 0.1.2 | Interface written; a second sandbox from the Sandbox choice table checked as feasible. Done 2026-11-22: `src/executor.ts`; fallback is Cloudflare Sandbox SDK containers, see docs/decisions/0.1.3-executor-interface.md | — | Done |
| 0.1.4 | Fix the five interface contracts as versioned schemas | Interface contracts; FR-1; FR-41; Flag 3 | 0.1.3, 0.2.1 | `code` input and output, sandbox API, policy record and error codes (each marked retryable or not) checked in and signed off. Done 2026-11-22: `src/contracts/`, version 1.0.0, see docs/decisions/0.1.4-interface-contracts.md | P0 | Done |
| 0.1.5 | Inventory the GitHub read-only actions to wrap and draft a policy record for each | Decision: first wrapped tools; FR-32; FR-50 | 0.1.4 | Every action has a data class, tier, caller rule, and sensitive and outbound flags. Done 2026-11-22: 15 actions in `src/tools/github-inventory.ts`, see docs/decisions/0.1.5-github-inventory.md | P0 | Done |
| 0.1.6 | Read Anthropic's and OpenAI's data-processing terms | Owner's answer on FR-38; FR-38 | — | Each provider approved or not for confidential and client personal data, with reasons. Done 2026-11-22: API routes approved, personal plans not; see docs/research/0.1.6-provider-data-terms.md | P0 | Done |
| 0.1.7 | Check personal data duties: whether a DPIA and provider terms are needed | Decision: personal data duties | 0.1.6 | Written answer from ICO guidance or advice. Done 2026-11-22: DPIA needed before client personal data, not for Phase 1; see docs/research/0.1.7-personal-data-duties.md | — | Done |
| 0.1.8 | Clear the ExecWard name: UK and US trade marks in classes 9 and 42, domains, and the pending EXEC application | Project name | — | Clearance result and chosen domain recorded. Done 2026-11-22: no conflicting mark on the US or UK registers, the EXEC application is abandoned, nine domains unregistered; chosen domain execward.com, still to be bought by the owner. First-pass search, not legal advice; EU and international registers not searched. See docs/research/0.1.8-name-clearance.md | — | Done |
| 0.1.9 | Verify the two unverified sources and revisit the workflow and rollout diagrams | Audit log: still open; Sources | — | Claude Code Code Mode page and LangChain post opened, their PRD rows kept or removed; both diagrams match the text. Done 2026-11-22: both sources confirmed and kept, rollout diagram corrected; see docs/research/0.1.9-unverified-sources.md | — | Done |
| 0.1.10 | Re-score the threat table and sign it off | Phase 0 exit; Threat model; Governance: risk register | 0.1.4, 0.1.5 | Each threat row has a likelihood, an impact and a sign-off date. Done 2026-11-22: all 19 threats scored for the Phase 1 scope and signed off by the owner; in the PRD at revision 186 and in docs/decisions/0.1.10-threat-scores.md | — | Done |
| 0.1.12 | Set the numeric limits the tests need: sandbox CPU, memory, wall-clock and call-count limits, quotas and spend caps, and the argument size that counts as unusually large | FR-4; FR-27; FR-29; Flag 16 | 0.1.2 | Each limit is a number in the config or policy schema, with its reason. Done 2026-11-22: `src/limits.ts`, reasons in docs/decisions/0.1.12-numeric-limits.md | P0 | Done |
| 0.1.13 | Accept or reject each flag fix laid in the PRD as a suggestion | Flags | — | Every suggestion in the PRD is accepted or rejected; the Flags table records each outcome. Done 2026-11-22: the owner accepted flags 2 and 5, the last two; the PRD has no open suggestions | — | Done |
| 0.1.11 | Sign off the Phase 0 exit | Phase 0 exit | 0.1.10, 0.2.5, 0.3.2, G.1 and every other Phase 0 task | Baseline report exists, threat model is signed off and the go or no-go from 0.2.7 is recorded; no Phase 1 build task starts before this. Done 2026-11-22: signed off by the owner, with the limits of the sign-off stated; see docs/decisions/0.1.11-phase-0-exit.md | — | Done |

### 0.2 Eval harness, task suite, first golden tasks

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 0.2.1 | Add a lockfile, TypeScript as a dev dependency, and CI that blocks on any failing test to the ExecWard repo | NFR: test coverage; FR-23 | — | A deliberately failing test blocks the merge. Done 2026-11-22: Aramid blocks a failing test at push; on GitHub, main accepts only pull requests whose `test` check passed, admins included | P0 | Done |
| 0.2.2 | Build the eval harness: run a task on a model and record provider-reported usage | Evaluation plan steps 2 and 3; Token metering: measured saving | 0.2.1, 0.1.5 | One task runs on both models, recording input and output tokens, turns, wall-clock time, success and failure causes. Done 2026-11-22: harness, three adapters (OpenRouter, Anthropic, OpenAI), route fallback and a missing-key check in `src/eval/`; `scripts/eval-one.ts` ran one task on Claude Haiku 5.5 and GPT-6 Luna over every route, all four runs correct, see docs/decisions/0.2.2-eval-harness-and-routes.md | — | Done |
| 0.2.3 | Write 20 to 40 tasks with checkable outcomes on the GitHub tools | Evaluation plan step 1 | 0.1.5 | Each task has an automatic pass or fail check and a type: bounded tool-heavy or exploratory. Done 2026-11-22: 30 tasks (20 bounded tool-heavy, 10 exploratory) in `src/eval/tasks/github-tasks.ts` on the fixture GitHub backend in `src/eval/fixtures/`; one real pass scored 30 of 30 on Claude Haiku 5.5 and 29 of 30 on GPT-6 Luna for $0.19, see docs/decisions/0.2.3-fixture-github-backend.md and docs/decisions/0.2.3-eval-tasks.md | — | Done |
| 0.2.4 | Write the first golden tasks | Phase 0 scope; FR-45 | 0.2.3 | Each has a known answer that is checked automatically. Done 2026-11-22: nine tasks in `src/eval/tasks/golden.ts`, passed in 75 of 75 real runs on both models, about $0.014 per daily pass, see docs/decisions/0.2.4-golden-tasks.md | P1 | Done |
| 0.2.5 | Run the direct-call and tool-search arms, five runs per task per model, with metering at detailed | Evaluation plan step 2; Phase 0 scope; Flag 1 | 0.2.2, 0.2.3 | Baseline report per model and task type, stating the smallest drop the suite can detect. Done 2026-11-22: 600 runs on Claude Haiku 5.5 and GPT-6 Luna for $1.40; direct success 99.3% on both, tool search saves 10% to 13% of input tokens, smallest detectable drop about 5 percentage points; see docs/research/0.2.5-baseline-report.md and docs/decisions/0.2.5-tool-search-arm.md | — | Done |
| 0.2.6 | Confirm the success-metric targets and the latency budget from the baseline | Success metrics; NFR: performance | 0.2.5 | Each proposed target confirmed or changed in the PRD, including the success drop that counts as significant at Gate 1. Done 2026-11-22: the owner confirmed all ten; three were sharpened from the baseline (30% token saving per model, a 5-point success drop plus no always-failing task, latency 10% or 0.5 s); written into the PRD at revision 185, see docs/decisions/0.2.6-success-targets.md | — | Done |
| 0.2.7 | Decide which task types the code tool is worth building for | Risk: tool search alone captures most of the saving | 0.2.5 | Task types where tool results, not definitions, dominate token use are recorded. Done 2026-11-22: the owner decided to build the code tool first for bounded, list-heavy tasks and keep direct calls for lookups and exploratory work, see docs/decisions/0.2.7-code-tool-task-types.md | — | Done |

### 0.3 Adversarial suite

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 0.3.1 | Build the adversarial cases | FR-31; Threat model | 0.1.10 | Every threat-table row, reviewer injection included, maps to at least one case; fixture secrets are fake patterns that pass the repo's secret scan. Done 2026-11-22: 40 attack cases and 2 controls in src/adversarial/cases.ts; a test fails if any of the 19 rows has no case; see docs/decisions/0.3-adversarial-suite.md | P0 | Done |
| 0.3.2 | Run the suite in CI against a stub executor | FR-31; Build plan 0.3 | 0.2.1, 0.3.1 | Every case fails as expected against the stub, in CI. Done 2026-11-22: `npm run adversarial` runs in the required CI job; all 40 attacks are reported open against the defenceless stub and both controls are served | P0 | Done |
| 0.3.3 | Trigger the suite on every runtime, model or policy change | FR-31; Governance: change control | 0.3.2 | A change to the policy file or runtime pin runs the suite in CI. Done 2026-11-22: the CI workflow has no path filter, so every change runs the suite; a test fails if a filter or condition is added | P0 | Done |

## Phase 1: MVP

Exit: Gate 1. Security first: every P0 security requirement in place, the adversarial suite passing and an independent sandbox review done. Then a token saving and no significant success drop. Tier-0 (read-only) tools only.

### 1.1 Server confinement, secrets, supply chain

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.1.1 | Scaffold the core as a Worker with a pinned compatibility date and an allowlist of bindings | FR-23; FR-24; Decision: sandbox and hosting; Flag 2 | 0.1.11 | CI fails when a binding outside the allowlist is added. Done 2026-11-22: `wrangler.jsonc` with one binding (the Worker Loader) and a pinned compatibility date; a default-deny check refuses any config key that is not on the allowlist, including binding types that do not exist yet; CI also builds the Worker in a dry run. Nothing is deployed. See docs/decisions/1.1.1-worker-scaffold.md | P0 | Done |
| 1.1.2 | Put each upstream credential in the secret store, one narrowly scoped credential per server | NFR: secrets; NFR: credentials; FR-24 | 1.1.1 | The CI secret scan finds none in code or config; a write attempt with the GitHub credential is refused | P0 | Not started |
| 1.1.3 | Produce an SBOM per release and pin every dependency | FR-23 | 0.1.11 | A release build fails without a lockfile; each release carries an SBOM. Done 2026-11-22: `npm run check:supply-chain` fails on any unpinned dependency, missing or stale lockfile, or CI action not pinned to a commit; CI builds and checks a CycloneDX SBOM on every change; the release workflow attaches it. The release workflow itself is first exercised by the first tag (1.1.5). See docs/decisions/1.1.3-supply-chain-pins.md | P0 | Done |
| 1.1.4 | Set up the weekly advisory check and the 72-hour patch window | FR-23; Governance: vulnerability intake | 1.1.3 | First weekly check logged; a critical advisory gets a 72-hour deadline. Done 2026-11-22: a workflow runs `npm audit` on the pinned tree every Monday and on demand, logs the report in the run summary, and opens an issue with a patch-by time 72 hours after detection for each critical advisory; a failed audit is a failure, never a clean result. First check: no known advisories. See docs/decisions/1.1.4-advisory-check.md | P0 | Done |
| 1.1.5 | Version releases and prove rollback | NFR: recovery | 1.1.1 | A release is rolled back to the previous version in a test | — | Not started |
| 1.1.6 | Test that the core reaches nothing outside its bindings | FR-24; Build plan 1.1 | 1.1.1, 1.1.2 | Attempts to reach other bindings, environment values or the open network are refused | P0 | Not started |

### 1.2 Sandbox executor

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.2.1 | Run scripts in a Dynamic Worker behind the executor interface, with outbound network blocked | FR-4; NFR: isolation; Sandbox API contract | 0.1.3, 1.1.1 | `fetch`, environment access and any global outside the sandbox API are refused in tests. 2026-11-22: done in the local Workers runtime (`src/executor/`, 33 tests). Local runs are not proof of isolation and do not enforce the CPU limit; that proof is 1.2.2 and 1.2.8. See docs/decisions/1.2.1-dynamic-worker-executor.md | P0 | Done |
| 1.2.2 | Enforce CPU, memory, wall-clock and call-count limits | FR-4 | 1.2.1 | On a deployed test Worker, a script over each limit ends with `timeout` or `quota_exceeded`; memory is the platform's fixed 128 MB, and wall-clock and call-count limits are enforced by the host and broker | P0 | Not started |
| 1.2.3 | Check every script before it runs | FR-33 | 1.2.1 | `eval`, the Function constructor, dynamic import, WebAssembly compilation, oversized scripts and secret patterns are refused with `static_check_failed`; the script hash is recorded. 2026-11-22: the check is built and tested (`src/static-check/check.ts`, 57 tests; it stops 9 of the 40 adversarial cases on its own). Wired into the run path by 1.2.4, and run inside the local Workers runtime. Still owed: recording the hash in the audit log (1.4.1); the hash is already in every run report. See docs/decisions/1.2.3-static-check.md | P0 | In progress |
| 1.2.4 | Implement the `code` tool's input and output contract | FR-1; FR-5; Interface contracts | 1.2.1, 0.1.4 | Contract tests pass; an oversized final value comes back with a truncation notice. 2026-11-22: done (`src/code-tool/run.ts`, 27 tests, plus 4 end to end in the local Workers runtime). Contract version 1.2.0 adds optional `logs`. No route serves it yet; that needs sign-in (1.5.x). See docs/decisions/1.2.4-code-tool-contract.md | P0 | Done |
| 1.2.5 | Raise upstream errors inside the script and return script errors with line and message | FR-7 | 1.2.4 | An MCP isError result can be caught in the script; a thrown error reports its line. 2026-11-22: a thrown error reports its line, and an error from the host can be caught in the script (tested in the local Workers runtime). Still owed: turning an MCP isError result into that error, which belongs to the broker (1.3.x) | P0 | In progress |
| 1.2.6 | Add the `assert()` helper | FR-40 | 1.2.4 | A failed assertion ends the run before the next side effect, reporting the condition and values. 2026-11-22: done. A failed assertion ends the run even if the script catches it; the error gives the message, what the condition was, the line and its text; passed assertions are counted in the run report. Tested in the local Workers runtime | P0 | Done |
| 1.2.7 | End the run on any sandbox fault, never falling back to calls outside the sandbox | NFR: failure behaviour | 1.2.1 | An injected fault returns an error and makes no upstream call. 2026-11-22: done. The executor and the code tool each turn any fault into `sandbox_fault`; a test injects a failing executor and counts zero upstream calls. There is no second way to run a script in the code | — | Done |
| 1.2.8 | Pass the escape, limit and blocked-construct cases | Build plan 1.2; FR-31 | 1.2.2, 1.2.3, 0.3.2 | Those adversarial cases pass in CI against a deployed test Worker, since local runs do not enforce isolation or limits | P0 | Not started |

### 1.3 Policy table and broker

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.3.1 | Store the policy table in D1, with default deny | FR-50; FR-32; Policy record contract | 0.1.5, 1.1.1 | A tool with no record is treated as the highest data class, tier 2 and direct-only, and is refused from scripts. 2026-11-23: done on a local D1 database (`src/broker/policy-store.ts`, `migrations/0001_policy.sql`). The production database binding needs a Cloudflare account. See docs/decisions/1.3.1-policy-table-and-caller-rules.md | P0 | Done |
| 1.3.2 | Check every script-originated call at the broker against caller rules | FR-6; FR-13 | 1.3.1 | A direct-only or hook-guarded tool called from a script is refused with `policy_denied`. 2026-11-23: direct-only, unrecorded, tier-1 and tier-2 tools are refused, a refusal ends the run, and the broker fails closed (`src/broker/broker.ts`). Hook-guarded tools are covered: the contracts record them as direct-only (docs/decisions/0.1.4-interface-contracts.md), so they are refused like any direct-only tool | P0 | Done |
| 1.3.3 | Validate arguments against inputSchema and the URL and path allowlists | FR-34 | 1.3.2 | Unknown fields, schema violations and off-allowlist URLs or paths are refused. 2026-11-23: done (`src/broker/json-schema.ts`, `src/broker/allowlists.ts`). A schema mistake is `schema_invalid`, which a script may fix and retry; an off-allowlist URL or path is `policy_denied` and ends the run. Contract version 1.3.0 adds an optional `pathAllowlist`. See docs/decisions/1.3.3-argument-validation.md | P0 | Done |
| 1.3.4 | Validate results and tag each value with its source tool and data class | FR-35 | 1.3.2 | A malformed or oversized result is rejected; every value carries its tags | P0 | Not started |
| 1.3.5 | Enforce the data-flow rule, starting with an empty allowlist | FR-29; Owner's answer on the allowlist | 1.3.4 | A sensitive read followed by an outbound call escalates; unusually large arguments are flagged | P0 | Not started |
| 1.3.6 | Apply output hygiene to the final value | FR-36 | 1.3.4 | Fields above the run's class are masked; totals come with counts or samples; output is marked untrusted | P0 | Not started |
| 1.3.7 | Enforce each project's data class and the approved providers | FR-38; FR-32 | 0.1.6, 1.3.4 | Client personal data bound for an unapproved provider is refused; the provider is recorded per run; no project can be set to a client data class until G.7 is cleared | P0 | Not started |
| 1.3.8 | Add quotas, spend caps and the circuit breaker | FR-27 | 1.3.2 | Each quota, and repeated errors or denials, stop the run in tests | P0 | Not started |
| 1.3.9 | Fail closed when the policy store, audit log or quota service is down | NFR: fail closed | 1.3.2, 1.4.1 | With each service stubbed out, script-originated calls are denied | — | Not started |

### 1.4 Audit log and retention

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.4.1 | Log every execution from the broker, always on | FR-8 | 1.2.4, 1.3.2 | With metering off, each run still records script, calls, arguments, result bytes, duration and outcome | P0 | Not started |
| 1.4.2 | Make the log append-only, hash-chained and readable only by the owner | FR-28; Flag 5 | 1.4.1 | An edited row fails chain verification; the sandbox cannot write to the log; control characters are escaped | P0 | Not started |
| 1.4.3 | Redact secrets before writing | FR-21 | 1.4.1 | A known secret in call arguments is stored redacted | P0 | Not started |
| 1.4.4 | Expire records by type and delete a project's logs on request | FR-21; Script retention; Flag 5 | 1.4.2 | Full text expires at 7 days, metadata and security events at 90; after a deletion the chain still verifies | P0 | Not started |
| 1.4.5 | Back up the policy table, audit log and escalation queue daily | NFR: recovery; Flag 10 | 1.4.1 | The first daily backup exists outside D1, and one restore from it into a scratch database succeeds | — | Not started |

### 1.5 Tool registry, typings, discovery, pinning

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.5.1 | Build the GitHub read-only connector | Architecture, run step 4; NFR: credentials; Decision: first wrapped tools | 1.1.2, 1.3.1 | The credential never appears in sandbox inputs; read-only calls succeed | — | Not started |
| 1.5.2 | Generate typed async functions with sanitised names | FR-2 | 1.5.1 | Typed from outputSchema, or a generic type without one; `my-server.list-items` becomes `my_server_list_items` | P0 | Not started |
| 1.5.3 | Add `search()` and `describe()` | FR-3 | 1.5.2 | The initial context holds no catalog; `describe()` returns typed docs for one path | P0 | Not started |
| 1.5.4 | Pin each definition by hash and block changed ones | FR-22 | 1.5.2 | A changed definition returns `definition_changed`; an unchanged schema with a scan-clean description re-approves automatically; description length is capped | P0 | Not started |

### 1.6 Owner console, switches, escalation

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.6.1 | Build the owner console with two-factor sign-in, out of the model's reach | FR-49 | 1.1.1 | Requests without two-factor sign-in, or with any model-held credential, are refused | P0 | Not started |
| 1.6.2 | Add the onboarding step | FR-52 | 1.6.1 | Code Mode stays off until onboarding completes; every field starts at its safe default; the governance profile is recorded | P0 | Not started |
| 1.6.3 | Add the global on/off switch | FR-16; Flag 4 | 1.6.1, 1.9.2 | Off removes the `code` tool, and every wrapped tool can be called directly | P0 | Not started |
| 1.6.4 | End a run cleanly when Code Mode is switched off mid-run | FR-17 | 1.6.3 | The error lists side-effecting calls already made; nothing continues outside the sandbox | P0 | Not started |
| 1.6.5 | Add a kill switch that works without the model | FR-27; Build plan 1.6 | 1.6.1 | The kill switch stops runs with the model offline | P0 | Not started |
| 1.6.6 | Queue exceptions with the run report, and pause the project on a security exception | FR-44 | 1.6.1, 1.7.1 | A security exception pauses its project at once and is never batched | P0 | Not started |
| 1.6.7 | Send link-only emails for urgent items and the daily digest | Decision: escalation channel; FR-44; FR-49; Flag 11 | 1.6.6 | Emails carry only a link; a test scans each body for data | P0 | Not started |
| 1.6.8 | Offer ranked options with safe defaults and time limits | FR-46; Time limits table | 1.6.6 | Each trigger shows up to four options and the rule behind the recommendation; an unanswered item takes its safe action at its time limit | P0 | Not started |
| 1.6.9 | Version and log every console change, and offer repeated choices as proposed rules | FR-49; FR-46 | 1.6.1 | Each change has a version and a log entry; a repeated choice appears as a proposal and is never adopted on its own | P0 | Not started |

### 1.7 Run report, self-correction, release gate

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.7.1 | Return the run report beside every result | FR-39 | 1.4.1 | The report lists calls by tool, records read and written, errors, retries, assertions, side effects and the verification outcome | P0 | Not started |
| 1.7.2 | Reconcile the model's summary against the run report in the in-app adapter | FR-39 | 1.7.1, 1.9.2 | A summary with a wrong number is flagged | P0 | Not started |
| 1.7.3 | Return failed checks to the model for up to two retries, and never retry a security failure | FR-41 | 1.7.1 | A policy denial escalates at once with no retry; a third attempt is refused | P0 | Not started |
| 1.7.4 | Add the release gate with deterministic checks | FR-47; FR-48 (unreviewed marking) | 1.7.1 | A failing output is not handed over; output with no reviewer is marked unreviewed | P0 | Not started |

### 1.8 Token meter

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.8.1 | Add metering at off, summary and detailed | FR-19; NFR: metering overhead | 1.4.1 | Off runs no tokenizer; nothing is added to model context; every figure is labelled estimated | P0 | Not started |
| 1.8.2 | Compute the meter's measures | Token metering table | 1.8.1 | Script, returned, kept-out and definitions-not-loaded tokens and the estimated saving are unit-tested | — | Not started |

### 1.9 In-app adapter and Gate 1

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 1.9.1 | Record the host for the in-app adapter: a small test app in this repo (decided 2026-11-22) | FR-9; Assumptions; Flag 9 | — | The PRD's decisions table names the test app | P0 | Done |
| 1.9.2 | Build a minimal agent loop in this repo as the test app, and register the `code` tool in it with a direct-call path for the wrapped tools | FR-9; FR-16 | 1.9.1, 1.2.4 | The tool works with one Claude and one GPT model; with Code Mode off the same tools are called directly | P0 | Not started |
| 1.9.3 | Export per-run metrics to the monitoring stack | NFR: observability | 1.4.1 | Latency, outcome and security events arrive per run, plus token metrics when metering is on | — | Not started |
| 1.9.4 | Measure the latency the core adds | NFR: performance | 1.9.2, 0.2.6 | Added latency per run is reported against the budget | — | Not started |
| 1.9.5 | Run the code-tool arm of the eval | Evaluation plan; Flag 1 | 1.9.2, 0.2.5 | Five runs per task per model; the report gives the token saving and the success difference with its confidence interval; the script failure threshold is set | — | Not started |
| 1.9.6 | Check that the tool description and typings work for both model families | NFR: model portability | 1.9.5 | Both families pass the eval subset | — | Not started |
| 1.9.7 | Have a second model family review the sandbox against the threat table | Gate 1; Risk: sandbox escape; Flag 8 | 1.2.8 | A structured review by a model family other than the one that wrote the code is filed, with no open critical findings | — | Not started |
| 1.9.8 | Pass Gate 1, then set the meter default to summary | Gate 1; Owner's answer on the meter | 1.9.5, 1.9.6, 1.9.7, G.4 and every other Phase 1 task | Every P0 security requirement in place and the adversarial suite passing; then a token saving with no success drop beyond the threshold set in 0.2.6 | — | Not started |

## Phase 2: MCP adapter

Exit: Gate 2. Security review passed, every threat-table row tested and the adversarial suite passing.

### 2.1 MCP adapter and remote sign-in

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 2.1.1 | Serve the `code` tool as a remote MCP server over Streamable HTTP | FR-10; Decision: how the CLIs connect | 1.9.8 | Claude Code CLI and Codex CLI both connect | P1 | Not started |
| 2.1.2 | Add OAuth that accepts only tokens issued for this server | FR-25; FR-10 | 2.1.1 | A token issued for another service is rejected; no token passes through; scopes start read-only and step up for side effects; consent is asked per client before proxying | P1 | Not started |
| 2.1.3 | Keep the tool list stable across turns | FR-14 | 2.1.1 | The tool list is unchanged across a session that discovers new tools through `search()` | P1 | Not started |
| 2.1.4 | Add per-client, per-project and per-tool switches | FR-18; Feature switch table; Risk: mid-session toggling | 2.1.1 | `/mcp disable` and Codex `enabled = false` are honoured; the narrowest setting wins; a mid-session change warns | P1 | Not started |
| 2.1.5 | Apply the MCP-side limits on checks | FR-47; FR-39; FR-41; Flag 12 | 2.1.1 | Criteria from `intent` are marked model-supplied; the run report is returned for display; a third attempt in a session is refused | P0 | Not started |
| 2.1.6 | Pass the model name in from each CLI's config | Token metering: limits | 2.1.1 | Reports group Claude Code and Codex runs by model | — | Not started |
| 2.1.7 | Find out which provider-reported usage each CLI can hand to the stats report | Open questions | 2.1.1 | Answer recorded for Claude Code and Codex | — | Not started |

### 2.2 Model-backed verification

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 2.2.1 | Give verification its own credential, provider rule and budget | FR-51 | 1.9.8 | Verification tokens are metered separately from the working model's | P1 | Not started |
| 2.2.2 | Cross-check critical figures: money amounts and any total that goes to a client | FR-43; Owner's answer on critical figures | 2.2.1 | Agreement passes automatically; disagreement escalates with options | P1 | Not started |
| 2.2.3 | Add the independent reviewer from the other model family | FR-48 | 2.2.1, 1.7.4 | It can pass or block but never edit, and cannot approve tier 2; the reviewer-injection cases pass | P1 | Not started |
| 2.2.4 | Run the golden tasks daily on every model in use | FR-45 | 0.2.4, 2.2.1 | A failure removes that model as a default and tells the owner | P1 | Not started |
| 2.2.5 | Report the net saving after verification | Success metric: net token saving; FR-51 | 2.2.1, 1.8.2 | Net saving shown per task type; any negative one is flagged for narrowing or switch-off | P1 | Not started |

### 2.3 Stats report and Gate 2

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 2.3.1 | Build the stats report | FR-20 | 1.8.2, 2.1.6 | Grouped by session, project, client and model, with estimated and measured savings kept apart | P1 | Not started |
| 2.3.2 | Decide whether to ship the skill | Open questions; Delivery options | 2.3.1 | Decision recorded from Phase 2 usage data | — | Not started |
| 2.3.3 | Pass the Gate 2 security review | Gate 2; Risk: sandbox escape | 1.9.7, 2.1.5, 2.2.3 | Every threat-table row tested; the sandbox reviewed again; adversarial suite passing | — | Not started |
| 2.3.4 | Pass Gate 2 | Gate 2 | 2.3.1, 2.3.3 and every other Phase 2 task | All Gate 2 evidence recorded; Phase 3 can start | — | Not started |

## Phase 3: Approvals

Exit: in testing, no tier-2 action runs without approval and no write skips the dry run, with the adversarial suite passing.

### 3.1 Writes and approvals

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 3.1.1 | Choose how pause and resume work | NFR: replay and state; Risk: replay divergence | 2.3.4 | Replay with captured values, or a broker that holds the call open, chosen and tested | — | Not started |
| 3.1.2 | Add the dry run for writes | FR-42 | 2.3.4 | Writes become one change set, checked against policy, quotas and invariants, and only that set commits | P1 | Not started |
| 3.1.3 | Let tier-1 tools run from scripts through the dry run | FR-6; Tier table | 3.1.2, 3.1.10, G.10 | Each tier-1 write is logged with its compensation step | P0 | Not started |
| 3.1.4 | Pause tier-2 actions for approval in the owner console | FR-11 | 3.1.1, 3.1.2 | The broker's rendering of the exact call is shown; approve resumes and reject ends; a per-run grant covers one named tool only | P1 | Not started |
| 3.1.5 | Bind each approval to the exact call | FR-30; FR-46 | 3.1.4 | An approval replayed on a changed call is refused; an approval older than 15 minutes re-runs the checks | P0 | Not started |
| 3.1.6 | Make paused-run IDs random, bound and expiring | FR-26 | 3.1.4 | A guessed ID, or one reused by another user or project, is refused and never counts as sign-in | P1 | Not started |
| 3.1.7 | Make side-effecting calls retry-safe | FR-15 | 3.1.2 | A re-run with the same idempotency key does not repeat the action | P1 | Not started |
| 3.1.9 | Decide how merges of ExecWard-written branches are protected, and start GitHub Pro if private repos are in scope | FR-37; Flag 14 | 2.3.4 | Decision recorded: Pro with required status checks, public repos only, or manual merge on green CI; if Pro, a failing check blocks a merge on a private test repo | P1 | Not started |
| 3.1.10 | Turn on alerts for policy denials, quota hits, circuit-breaker trips, definition changes and sandbox faults | Governance: monitoring; Flag 15 | 1.9.3, 2.3.4 | Each alert fires in a test before any tier-1 write runs | — | Not started |
| 3.1.8 | Prove the Phase 3 exit | Phase 3 exit; Build plan 3.1 | 3.1.3 to 3.1.7, 3.2.2 | Tests show no tier-2 action without approval and no write without the dry run; adversarial suite passing | — | Not started |

### 3.2 Code and dependency writes

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 3.2.1 | Land code writes only on a branch, after tests and linters pass in the sandbox | FR-37 | 3.1.2, 3.1.9 | A change with a failing test never reaches a branch; merging follows the project's normal CI | P1 | Not started |
| 3.2.2 | Block package installs, and allow new dependencies only from an allowlist | FR-37; Tier table | 3.2.1, 3.1.4 | An install from a script is refused; a new dependency escalates as tier 2 | P1 | Not started |

## Phase 4: Hardening

Exit: restore test passed, alerts fired in a drill, and the multi-tenant decision recorded.

### 4.1 Saved snippets, recovery drill, multi-tenant decision

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| 4.1.1 | Add saved snippets | FR-12; Script retention | 3.1.8 | Stored by the app, take data as parameters, re-validated against current typings and policy-checked on every call; reviewed every 90 days | P2 | Not started |
| 4.1.2 | Tune the alerts turned on in 3.1.10, using Phase 3 data | Governance: monitoring | 3.1.8 | After tuning, alerts still fire on policy denials, quota hits, circuit-breaker trips, definition changes and sandbox faults | — | Not started |
| 4.1.3 | Test a restore of the policy table, audit log and escalation queue | NFR: recovery | 3.1.8 | The restore passes, and a quarterly repeat is scheduled | — | Not started |
| 4.1.4 | Run the alert and incident drill | Phase 4 exit; Governance: incident response | 4.1.2, G.4 | Alerts fired in the drill and every runbook step was completed | — | Not started |
| 4.1.5 | Record the multi-tenant decision | Phase 4 scope; Sandbox choice | — | Isolate or microVM decision recorded with reasons | — | Not started |
| 4.1.6 | Prove the Phase 4 exit | Phase 4 exit | 4.1.1 to 4.1.5 | Restore test passed, alerts fired in the drill and the multi-tenant decision recorded | — | Not started |

## Ongoing: governance and operations

These run alongside the phases, at the cadence the Governance section sets. G.4 and G.7 are gates in their own right: the runbook before Gate 1, the data checks before any real client data.

| ID | Task | Traces to | Depends on | Done when | Priority | Status |
|---|---|---|---|---|---|---|
| G.1 | Name the accountable owner for the policy table, allowlist, quotas and kill switch | Governance: accountable owner | — | The owner is named in the PRD before Phase 1. Done 2026-11-22 (PRD revision 196): the project owner is named in the Governance table as the single accountable owner for all four; no one else, and no model, changes them without the owner | — | Done |
| G.2 | Keep the upstream server list with publisher, pinned version and definition hash | Governance: upstream server approval; FR-22; FR-23 | 1.5.4 | The list is updated on every add or change | P0 | Not started |
| G.3 | Re-score the risk register monthly and after any incident | Governance: risk register | 0.1.10 | A monthly entry is logged | — | Not started |
| G.4 | Write the incident runbook and test it quarterly | Governance: incident response; FR-46; Flag 13 | 1.6.5 | Kill switch, credential revocation, log preservation, client notice and review steps are written before Gate 1 | P0 | Not started |
| G.5 | Re-run the eval subset and adversarial suite before a new model or provider becomes a default | Governance: model and provider change | 0.2.2, 0.3.3 | Each change has a passing run on record | — | Not started |
| G.6 | Write the client transparency notice | Governance: client transparency; FR-21 | 1.4.4 | It states what data Code Mode processes, how long it is kept and that scripts are AI-written | P0 | Not started |
| G.7 | Clear the first-real-client-data gate | Decision: personal data duties; Owner's answer on FR-38 | 0.1.6, 0.1.7, G.6, G.10 | All four are done and recorded; until then 1.3.7 refuses any client data class | P0 | Not started |
| G.8 | Spot-check a small random sample of runs each month (optional) | Risk: over-automation | 1.9.8 | A monthly sample is logged | — | Not started |
| G.9 | Keep the Formal-profile records, if Formal is chosen at onboarding | Governance profile; FR-52 | 1.6.2 | A written AI policy, roles, objectives and an internal audit plan exist | P0 | Not started |
| G.10 | Get a paid human security review of the sandbox | Gate 1; Risk: sandbox escape; Flag 8 | 1.9.7 | Review by a security firm or freelancer filed with no open critical findings, before any tier-1 write or real client data; budget from several hundred to a few thousand dollars | — | Not started |
| G.11 | Complete a DPIA and a transfer risk assessment, and settle the owner's role with each client | Decision: personal data duties; FR-38; task 0.1.7 | 0.1.7 | DPIA and transfer risk assessment filed, naming Anthropic, OpenAI, Cloudflare and GitHub; each provider's UK-US data bridge status and sub-processor list checked; before any project is classed client personal data | — | Not started |

## Flags

Places where the PRD contradicts itself or leaves work unplaced. The tasks above already work around each one. The PRD body is unchanged, and every fix here is proposed.

| # | Issue | Proposed fix | Tasks | PRD fix |
|---|---|---|---|---|
| 1 | Build plan 0.2 is done when all three arms have run, but the code tool does not exist in Phase 0, and the Phase 0 row names only two arms | Run two arms in Phase 0 and the code arm before Gate 1 | 0.2.5, 1.9.5 | Accepted 2026-11-22 |
| 2 | FR-23, FR-24 and Build plan 1.1 assume a container or a local process (image digests, "cannot read outside its folder"), but the chosen host is Workers | Restate them in Workers terms: binding allowlist, secret store, pinned compatibility date. The local-listener checks apply only if a local stdio server is added | 1.1.1, 1.1.6 | Accepted by the owner 2026-11-22 (PRD revision 199: FR-23, FR-24 and Build plan 1.1) |
| 3 | FR-1 lists `completed`, `paused` and `error`, but the output contract adds `refused` | Add `refused` to FR-1 | 0.1.4 | Accepted 2026-11-22 |
| 4 | FR-16 makes wrapped tools directly callable when Code Mode is off, but no workstream builds that direct-call path | Build it in the in-app adapter in Phase 1 | 1.9.2, 1.6.3 | Accepted 2026-11-22 |
| 5 | FR-28's hash chain conflicts with FR-21's expiry and per-project deletion: deleting rows breaks a simple chain | Chain record hashes and keep tombstones, so a deletion leaves the chain verifiable | 1.4.2, 1.4.4 | Accepted by the owner 2026-11-22 (PRD revision 201: FR-28) |
| 6 | Open questions still lists 12 questions the owner settled on 22 November | Keep only the six still open | 0.1.1 | Accepted 2026-11-22 |
| 7 | The MCP elicitation question looks moot, since the PRD also says approvals never happen inside a CLI | Confirm, then drop the question | 0.1.1 | Accepted 2026-11-22 |
| 8 | Gate 1 needs an independent sandbox review, but no reviewer is named, and there is a single owner | Decided: a second model family reviews for Gate 1, and a paid human review follows before real client data or writes | 1.9.7, G.10 | Accepted 2026-11-22 |
| 9 | No app is named for the in-app adapter (FR-9), and the eval's code arm needs it too | Decided: a small test app in this repo. Record it in the decisions table | 1.9.1, 1.9.2 | Accepted 2026-11-22 |
| 10 | The Build plan places only the functional requirements. The non-functional requirements and Governance controls have no workstream, and backups appear only in the Phase 4 restore test | Place them as this list does, and start daily backups in Phase 1, when the audit log first holds data | 1.4.5, G.1 to G.9 | Accepted 2026-11-22 |
| 11 | FR-44's urgent notifications need the link-only email from Phase 1, which the Build plan does not name | Build it in workstream 1.6 | 1.6.7 | Accepted 2026-11-22 |
| 12 | FR-41's per-session attempt count applies only through the MCP adapter, which arrives in Phase 2 | Build that part in Phase 2 | 2.1.5 | Accepted 2026-11-22 |
| 13 | FR-46's security-exception option opens the incident runbook from Phase 1, but the runbook is drilled only in Phase 4 | Write the runbook before Gate 1 | G.4, 1.9.8 | Accepted 2026-11-22 |
| 14 | FR-37 writes code through the GitHub API, so local commit hooks never run on it, and the owner's GitHub Free plan cannot enforce "CI must pass before merge" on private repos | Decide the merge protection before the first code write; GitHub Pro (about $4 a month) is needed only if private repos are in scope. Also upgrade if private-repo Actions minutes pass half the monthly allowance | 3.1.9, 3.2.1 | Accepted 2026-11-22 |
| 15 | Backups start in Phase 1 but the first restore test is in Phase 4, and alerts are turned on only in Phase 4, after writes go live in Phase 3 | Test one restore when backups start, and turn alerts on before the first write. The drill stays in Phase 4 | 1.4.5, 3.1.10, 4.1.2 | Accepted 2026-11-22 |
| 16 | Sandbox limits, quotas, the unusually-large argument size and the significant success drop are required but have no values | Set each as a number in Phase 0 | 0.1.12, 0.2.6 | Accepted 2026-11-22 |
