# Task G.13: a client's own choice about AI use

Date: 2026-11-26. Requirements: FR-38, FR-32. Builds on 1.3.7 (project data classes) and
the client notice (G.6). Status: **slice 1 partly built. Storage and enforcement are in.
The console control is not, and slice 2 is not started.**

## Why

The draft client notice says a client can ask that AI tools are not used on their work,
or that they see less. Until now such a request would have lived in an email and been
acted on by hand. The project owner asked on 2026-11-26 whether the client could set it
themselves, and chose:

1. a page of the client's own, over the owner recording the choice for them; and
2. to build it in two slices, the first now and the second when a first client is in
   sight.

A client has no ExecWard account today. ExecWard knows one person, the owner
(1.6.1-console-sign-in.md), so a client page means a second kind of sign-in. That is
slice 2.

## The two slices

| Slice | What | State |
|---|---|---|
| 1 | The choice is stored per project and enforced by the service. The owner sets it in the console | Storage and enforcement built. Console control not built |
| 2 | The client signs in at an address of their own and sets the same stored choice | Not started. Needs a second Access application, a table linking a client to a project, and a second page |

## What a choice is

Two things, kept on the project's record (`ClientChoice` in `src/broker/exposure.ts`):

- **AI use, on or off.** Off means no script runs for that project.
- **A limit:** the highest data class the client lets AI tools handle. It may be left
  unset.

A project with no choice recorded behaves exactly as before.

## How it is enforced

- **No AI use.** The service refuses the run before anything is counted against a quota
  and before anything is read, with `policy_denied` and fixed words that say why. The
  refusal is written to the audit log like any other.
- **A limit.** A run may handle the lowest of three: the project's own class, the
  provider route's ceiling, and the client's limit. This is the same cap 1.3.7 already
  applies at the call, in discovery and at the reply, so nothing new had to be built
  below the service.
- **A choice only tightens.** A client limit above the project's class changes nothing.
- **Fail closed.** A stored choice that is not understood, or a record that cannot be
  read, refuses the run.
- **One reading per call.** The service now reads the project's record once for a call
  and uses that reading for all three questions: does the project exist, what did its
  client ask, what may it handle. Before, it was read twice.

## Storage

Two columns added to `projects` by `migrations/0007_client_choice.sql`: `client_ai_use`
(empty or `off`) and `client_limit` (empty or a data class). `setClientChoice` in
`src/storage/d1-stores.ts` writes them, only for a project that already has a record.
Setting a project's data class again, which the setup scripts do on every run, leaves
the choice as it was.

## Evidence

`test/exposure.test.ts`: the lowest-of-three rule in nine combinations, a personal plan's
ceiling not lifted by a limit, an unknown choice refused when written and when read, and
five runs through the whole service (no AI use, AI use on, a lower limit, a higher limit,
one reading per call). `test/d1-stores.test.ts`, on a real D1 database: a choice stored
and read back, refused for a project with no record, kept when the class is set again,
cleared when asked, and a row written behind the code's back refused.

## Limits

- **Nothing sets a choice in production yet.** The console control is the next pull
  request. Until then the columns are empty for every project.
- **A run already going is not stopped.** The choice is read when a run starts. A script
  that is running when the choice changes finishes, within the run's time limit. The
  owner's kill switch and pause still stop a running script at its next call.
- **The owner can change a client's choice in slice 1,** because the owner is the one
  recording it. Every change will be in the audit log. Whether the owner may raise a
  choice the client set themselves is for slice 2 to settle.
- **A restore brings back the choice as it was when the backup was taken.** A client who
  opted out after the backup is opted in again by a restore. This is the same limit as
  for retention and erasure (aramid finding `98e08b21024b`).
- **"No AI use" covers the `code` tool.** It does not reach what the owner does with a
  model outside ExecWard.
- **A project is still not tied to a client.** Slice 2 needs that link. It is not the
  same link as the one the review finding about a model moving between projects asks for
  (`0a0a21da547f`): that is about which model client may name a project.
