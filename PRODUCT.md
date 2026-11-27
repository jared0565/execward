# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the project owner. They run AI coding tools (Claude Code, Codex) against
their own systems and want those tools to do multi-step work without being handed
everything.

They are not an engineer watching a dashboard. They open the console now and then,
often from an email that says only that something is waiting, to do one of a few jobs:
decide a held item, stop or pause something, check what is switched on, or see what was
saved. They read plain language and act on it.

There is one owner sign-in. No team roles and no client-facing screens exist.

## Product Purpose

ExecWard lets a model do tool-heavy work by writing one script, which runs in a locked
sandbox. Tool results stay in the sandbox and out of the model's context, so the task
costs fewer tokens. Every tool call still passes the owner's rules.

Success is a real net token saving on the kinds of task it is used for, with no loss of
control: nothing reaches a tool the owner has not approved, everything is on record, and
the owner can stop any of it at once.

## Positioning

Security-first Code Mode. The saving comes from scripts in a sandbox; the difference is
what surrounds them:

- a policy table that decides which tools may be called, and how;
- an audit log of every run;
- fixed checks on every result before it is released;
- an independent reviewer, a model from a different family, that can pass or block a
  result and nothing else;
- an owner who can hold, pause or stop anything, and is asked by fixed options, never
  free text.

The saving is reported honestly: estimates apart from measurements, and a kind of run
that costs more than it saves is marked as such.

## Operating Context

- **The owner console**, at one address behind Cloudflare Access with the owner's
  sign-in. One page with sections: items waiting for the owner, proposed rules, net
  saving after verification, stats, the kill switch, Code Mode on or off, onboarding,
  paused projects, client choices (a client's request to stop or limit AI use on a
  project), blocked tools, email, and a GitHub write check.
- **Email** is link-only. An email says something is waiting and links to the console.
  It never carries content. Urgent items are emailed within five minutes, one email each; the rest
  once a day.
- **Model clients** reach ExecWard over MCP at a separate address. They see one tool,
  `code`. A client that says it runs Claude Haiku is also listed a few read-only tools
  for looking around; each such call runs as a one-line script under the same checks.
  That surface is text for a model, not a screen.
- The owner often arrives from an email, on whatever device they have, to make one
  decision and leave.

## Capabilities and Constraints

Confirmed constraints on any work on ExecWard's screens:

- **Plain language.** Every label and message is in plain words a non-engineer can act
  on. Each option says what it does and whether it can be undone.
- **Estimates are always labelled.** An estimated figure never appears without saying it
  is an estimate, and is never mixed with a measured one.
- **The page is locked down.** The console is one self-contained page: no outside
  fonts, scripts, images or trackers. Its script and style carry a per-response nonce
  under a strict content security policy, and it calls only the console's own
  addresses. Tests enforce this.
- **Stopping is always easiest.** Stopping everything comes first, never needs a reason
  and never waits: its button is the one that is never disabled. Every other change,
  pausing a project and blocking a tool included, asks for a reason.
- **Queue items offer three or four fixed options**, the safest first, one recommended
  with the rule behind the recommendation shown.
- **Content never leaves through a side door.** Emails, logs and reports carry counts,
  sizes and labels, not scripts or results.
- The console is served by a Cloudflare Worker as a single HTML string
  (`src/console/page.ts`). There is no front-end framework and no build step for it.

Terms in use: Code Mode, the kill switch, a paused project, a blocked tool, a held
result, the queue, the reviewer, estimated and measured.

Decided 2026-11-26: clients will get a page of their own to set their choice about AI
use, built when a first client is in sight (task G.13, slice 2). It does not exist yet.
Not decided: whether there will ever be more than one person signing in to the console.

## Brand Commitments

The name is ExecWard. The voice is plain and exact: it says what happened, what was not
checked, and what the reader can do. No logo or other identity asset exists.

## Evidence on Hand

- Decision records for each task: `docs/decisions/`.
- Governance records: `docs/governance/`.
- Eval reports with measured token figures: `docs/research/`, with the per-run
  records behind each report in `docs/research/data/` (other raw output, in
  `eval-results/`, is not kept in the repo).
- Live checks seen on production: `docs/decisions/2.1.8-live-checks.md`.

There are no customers, testimonials, case studies, press or pricing. Future work must
not invent any.

## Product Principles

1. Security before saving. A feature that saves tokens but weakens a control is not
   built.
2. Say what is true, including what was not checked. An estimate is called an estimate.
3. The owner decides, from fixed options, with the safe one first.
4. Anything short of a clear pass is not a pass.
5. Cost first: the cheapest thing that works, stepped up only on measured evidence.
