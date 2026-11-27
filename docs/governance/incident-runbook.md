# Incident runbook

Task G.4. Written 2026-11-23, before Gate 1, as the PRD requires. **Tested in part:**
the first drill, on 2026-11-24, covered steps 1, 3 and 6
(docs/governance/drills/2026-11-24-first-drill.md). The next is due by the end of
February 2027, then every quarter (flag 13, task 4.1.4). Brought up to date with the
system on 2026-11-27.

An incident is anything that suggests ExecWard did, or was made to do, something it
should not: a security exception in the queue, a credential that may have leaked, data
that reached somewhere it should not have, or a sandbox fault with no plain cause.

**Read this first.** ExecWard is deployed, at `console.execward.com` and
`mcp.execward.com`. It wraps GitHub, read-only, and holds two credentials: the GitHub
App's private key and the reviewer's OpenAI key (`VERIFY_OPENAI_API_KEY`). Section 2
applies to both. What is still missing is listed under "Gaps" at the end.

## 1. Stop it

Do this first, before finding out what happened.

| Step | How | If you cannot sign in to the console |
|---|---|---|
| Throw the kill switch | Owner console at console.execward.com, "Stop everything now". It needs no reason and no model | From a computer signed in to the Cloudflare account, in this repository: `npm run emergency:stop -- --yes --reason "why"`. Last resort: disable the Worker in the Cloudflare dashboard |
| Confirm it took | The console shows "STOPPED". Any run must be refused with `code_mode_off` | The command prints "STOPPED" and the version number |

The emergency stop can only stop. Clearing the kill switch always needs the console,
so getting back in comes next.

**If the authenticator is lost** (checked 2026-11-24): sign in to the Cloudflare
dashboard, which uses the Cloudflare account's own login and not the console's second
factor. Go to Zero Trust, Team & Resources, Users, select the user, and under MFA
devices choose Delete. Then open the console: Access asks for a new authenticator to be
enrolled. This cannot be done through Cloudflare's API alone, because the API does not
list a device's ID.

The kill switch stops every project. A new run is refused at once; a script already running stops within a quarter of a second. A security exception has already paused its own
project by the time you read about it; the kill switch is for when you do not yet know
how far it goes.

## 2. Cut off access

For each upstream server that could be involved:

1. Revoke its credential **at the provider**: for GitHub, delete the fine-grained token
   or uninstall the app. Removing it from ExecWard's secret store is not enough, because
   a copied credential still works.
2. Then remove it from the secret store.
3. If a model provider's key could be involved, revoke it in that provider's console.

Do not issue replacements yet.

## 3. Keep the evidence

1. **Do not delete a project's logs.** Retention still runs: the kill switch does not
   stop the timer's daily round, and nothing in the console pauses it. At the first
   firing of the next UTC day it removes text older than 7 days. So export the log
   first (the next step). To stop the round itself, take the cron trigger out of
   `wrangler.jsonc` and deploy, and put it back in step 6; `ALLOWED_TRIGGERS` and the
   configuration check must change with it.
2. Export the audit log for the affected period and store the copy outside Cloudflare.
3. Run the chain check on the export. A chain that does not verify is itself a finding.
   Write down the result either way.
4. Note the time, what you saw and each thing you did, as you go.

The log keeps full text for 7 days, and for 90 days for any run that included a security
event. An incident found late may have lost its script text; the outline and the hashes
remain.

## 4. Find out what happened

From the audit log, for each affected run: the script, every call and its outcome, what
data class was read, which provider route the reply went to, and whether the release gate
passed it. Answer four questions:

1. Did data leave? To a tool, to a model provider, or in an email?
2. Whose data, and of what class?
3. Was a control bypassed, or did every control work and the policy allow it?
4. Is it still happening anywhere else?

## 5. Tell the people affected

- **If client personal data may have been exposed,** UK data protection law can require
  a report to the Information Commissioner's Office within 72 hours of becoming aware,
  and telling the people affected if the risk to them is high. Whether you report as the
  controller or tell your client so they can is set by your contract with that client.
  This runbook is not legal advice; take advice before the clock runs out, not after.
- **Tell each affected client** what happened, what data was involved, what you have
  done, and what they should do. Plainly, and before they hear it elsewhere.
- **Tell the provider** whose credential or service was involved, if their side matters.

## 6. Recover

Only when step 4 has an answer:

1. Fix the cause. If it was a policy gap, change the policy; if a tool, block it.
2. Issue new, narrowly scoped credentials.
3. Resolve the item in the escalation queue with a written reason.
4. Clear the kill switch, with a written reason. If the timer was taken out in step 3,
   put it back.
5. Watch the first runs.

## 7. Review

Within a week, write down: what happened, how it was found, how long each step took,
what would have caught it sooner, and what changes. Re-score the risk register (task G.3).
Add an adversarial test for the way in, so the same route fails the suite from now on.

## Gaps in this runbook today

- The console exists (2026-11-24), at console.execward.com: step 1 is the "Stop
  everything now" button. If the owner cannot sign in, the quick stop is the emergency stop
  command in step 1 (added 2026-11-24, the owner's decision). It needs control of the
  Cloudflare account. **There is one sign-in method and no second.** Access allows one
  authenticator app per person, and the owner has no security key or biometric device.
  The cover is the emergency stop, and the dashboard step in section 1 for getting back
  in. A backup of the same authenticator is possible only by saving its setup key when
  it is enrolled; that has not been done.
- The export tool exists (2026-11-24): `npm run audit:export` does steps 3.2 and 3.3,
  and `npm run audit:export -- --check FILE` checks a copy again. It writes to the
  owner's computer; the copy kept somewhere else is still made by hand.
- The first drill was held on 2026-11-24 and covered steps 1, 3 and 6 only. See
  docs/governance/drills/2026-11-24-first-drill.md. Next drill due by the end of
  February 2027.
- A daily backup of production now runs (task 1.4.5) and is kept seven days. Restoring
  one is a function, with no command to run it yet.
- The alerts of task 3.1.10 (policy denials, quota hits, circuit-breaker trips,
  definition changes, sandbox faults) are not built. What exists: a security exception
  raises an urgent queue item, and a link-only email is sent within five minutes and
  then every hour; other items go in a daily digest. Anything that raises no queue item
  is found only by reading the log or by being told.
- There is no switch to pause the timer's daily round (see step 3.1).
- The contact details of the owner, the providers and the ICO are not written here. The
  owner should keep them where they can be reached with the system down.
