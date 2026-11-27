# Incident drill, 2026-11-24

The first test of the incident runbook (task G.4). It was a partial drill, on the live
production system, with no real incident and no client data involved.

**How it came about, honestly:** the kill switch steps were done by the project owner
as the first test of the new console, not as a planned drill. The evidence step was
then run on purpose, the same day. Together they exercise three of the runbook's seven
steps. The next drill should be planned as one, start to finish.

## What was exercised

| Runbook step | What was done | Result |
|---|---|---|
| 1. Stop it | The owner signed in to the console and pressed "Stop everything now". | Set at 01:50:00 UTC. Version 1 of the switches, with an audit log entry. No reason was asked for. |
| 3. Keep the evidence | `npm run audit:export` copied the production audit log to the owner's computer and ran the chain check. | 5 entries copied, 2026-11-23 13:45 to 2026-11-24 01:51 UTC. The chain verified. |
| 3. Keep the evidence (control) | One entry of a copy was altered on purpose and the copy checked again. | Refused: "entry 5: its content was changed", and the command exited with an error. |
| 6. Recover | The owner cleared the kill switch with the written reason "first test". | Cleared at 01:50:55 UTC. Version 2, with an audit log entry holding the reason. |

Time from stop to clear: 55 seconds, with the owner already signed in.

## What was not exercised

- **Step 2, cut off access.** Production holds no credential to revoke yet.
- **Step 4, find out what happened.** There was nothing to investigate.
- **Step 5, tell the people affected.** No notice was drafted or sent.
- **Step 7, review.** This note is the nearest thing.
- **Stopping a run in progress.** Production serves no runs. That the kill switch ends
  a running script is shown in tests only.
- **Restoring a backup.**
- **Being told by email.** Nothing raises an item in production, so no alert was sent.
  The test email arrived the same day.
- **Signing in from cold.** The owner was already signed in. A real incident starts
  with an email code and the authenticator.

## Findings

1. **There is no way to stop ExecWard if the owner cannot sign in.** The kill switch is
   reached only through the console, which needs the owner's mailbox and their one
   enrolled second factor. A lost phone during an incident would leave no quick stop.
   The slow stop still exists: anyone who controls the Cloudflare account can disable
   the Worker. **Decided by the owner the same day: both.** A second sign-in method
   turned out not to be possible: Access allows one authenticator app per person, and
   the owner has no security key or biometric device. Getting back in after a lost
   phone is therefore a step in the Cloudflare dashboard, now written in the runbook.
   An emergency stop command was built
   (`npm run emergency:stop`). It was run against the test database, not production:
   it set the kill switch, wrote an audit log entry on the chain with its reason intact,
   and did nothing when run a second time. It can only stop; clearing still needs the
   console.
2. **The runbook was out of date on two points,** now corrected: the console exists,
   and the export tool exists.
3. **The export is only as safe as where it is kept.** The command writes to the
   owner's computer. The runbook asks for a copy outside Cloudflare; a second copy
   somewhere else is still the owner's step, by hand.
4. **A chain cannot show that the newest entries were cut off.** It proves that what is
   there is whole. This is tested and written down. Regular exports kept elsewhere are
   what would show a shortened log.
5. **The owner's and providers' contact details are still not written anywhere** that
   can be reached with the system down.

## Next drill

Due by the end of February 2027, or sooner once the `code` tool is served in
production. It should be planned, start from signed out, and include a running script,
a credential revocation and a draft notice.

Added 2026-11-27: the `code` tool has been served in production since later on
2026-11-24, so the "sooner" condition is met. The next drill should be planned now, not
left to February.
