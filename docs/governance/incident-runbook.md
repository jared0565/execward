# Incident runbook

Task G.4. Written 2026-11-23, before Gate 1, as the PRD requires. **Not yet tested.**
The first drill is owed before Gate 1 and then every quarter (flag 13, task 4.1.4).

An incident is anything that suggests ExecWard did, or was made to do, something it
should not: a security exception in the queue, a credential that may have leaked, data
that reached somewhere it should not have, or a sandbox fault with no plain cause.

**Read this first.** Today ExecWard is not deployed, wraps no real tool and holds no
credential. Steps marked "not built yet" describe the control that will exist; until it
does, the fallback beside it is what to do.

## 1. Stop it

Do this first, before finding out what happened.

| Step | How | If that is not built yet |
|---|---|---|
| Throw the kill switch | Owner console, kill switch. It needs no reason and no model | Delete the Worker's deployment in the Cloudflare dashboard, or disable its route |
| Confirm it took | Start any run. It must be refused with `code_mode_off` | Confirm the Worker no longer answers |

The kill switch stops every project. A security exception has already paused its own
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

1. **Do not run retention, and do not delete a project's logs.** Pause the daily
   housekeeping schedule.
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
4. Clear the kill switch, with a written reason. Resume the schedule.
5. Watch the first runs.

## 7. Review

Within a week, write down: what happened, how it was found, how long each step took,
what would have caught it sooner, and what changes. Re-score the risk register (task G.3).
Add an adversarial test for the way in, so the same route fails the suite from now on.

## Gaps in this runbook today

- No console pages exist, so step 1's first row cannot be done by clicking.
- No export tool for the audit log exists. Step 3.2 means a database query for now.
- Backup and restore are built and tested (task 1.4.5), but no daily schedule runs yet,
  so there is still no second copy of production to compare against.
- No alerting exists (task 3.1.10). An incident is found by reading the queue or by
  being told.
- The contact details of the owner, the providers and the ICO are not written here. The
  owner should keep them where they can be reached with the system down.
