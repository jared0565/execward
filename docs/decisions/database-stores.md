# Database-backed stores for counters, switches, the queue and projects

Date: 2026-11-23. Serves tasks 1.3.8, 1.3.7, 1.6.3, 1.6.5 and 1.6.6. Status: **written
and tested on a local database, and now deployed: the production MCP route, the console
and the timer are all built from these stores.** Brought up to date on 2026-11-27.

## Why

Four things were held in a Worker's memory: quota counters, the owner's switches, the
escalation queue and project data classes. A Worker's memory is not shared between
instances and does not last between requests, so none of them would have held in
production. Each now has a store on the database, behind the same interface the
in-memory one has.

Tables are in `migrations/0003_state.sql`; the stores are in `src/storage/d1-stores.ts`.

## The rule that makes them safe

**Every write that decides something is one SQL statement.**

| Decision | How it is one statement |
|---|---|
| Count a run or a call | Add to the counter and read the new total back together |
| Take a concurrent-run slot | Insert only if fewer than the limit are held |
| Change a switch | Write only if the stored version is the one that was read |

So two Workers doing the same thing at the same moment cannot both win. Tested by
sending twenty counts, ten slot requests and five switch changes at once: the counter
reads 20, exactly three slots of three are given out, and exactly one change wins.

Everything fails closed. A missing table, or a stored switch state that cannot be
understood, is an error, and every reader of the switches treats an error as "off".

## Evidence

19 tests on a local D1 database inside the local Workers runtime, run twice in a row.

## Limits

- **Local D1 is one process.** The "all at once" tests show the statements are atomic,
  not how the deployed database behaves under real concurrent Workers.
- **Wired in.** The production MCP route (`src/mcp/production.ts`), the console
  (`src/worker.ts`) and the timer (`src/worker/scheduled.ts`) construct these stores.
- **The counters table is swept** by `sweepQuotaCounters` in the timer's daily round.
  Nothing depends on the sweep for a correct count.
- **Tool pins** still have no stored form. The meter's records have a table since task
  2.3.1 (`meter_records`).
- **Reading the switches and counting on every call was slow** as first built: two to
  three database round trips per call. Since task 1.9.4 the switches are re-read at most
  every quarter of a second within a run, and calls are counted ahead in blocks of up to
  16 (docs/decisions/1.9.4-latency.md).
- **Two test files share one test Worker,** and each now has its own local database
  folder. Sharing one made them lock each other.
