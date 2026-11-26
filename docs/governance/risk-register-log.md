# Risk register: the log of re-scores

Task G.3. The PRD's Governance section asks for the threat table to be re-scored every
month and after any incident. Each re-score gets one entry here, newest first. The
scores themselves live in `docs/decisions/0.1.10-threat-scores.md` and the PRD.

An entry says: the date, why it was done (monthly, incident or gate), what changed,
who decided, and when the next one is due.

| Date | Why | What changed | Who decided | Record |
|---|---|---|---|---|
| 2026-11-26 | Before Gate 2. Also counts as November's monthly re-score | No score changed. Two reviews by another model family have now found 20 gaps between them, all acted on; the scores assume controls that hold | Proposed by Claude. The project owner told Claude to carry on without waiting for approval and has not read the scores row by row | `docs/decisions/2.3.3-threat-rescore.md` |
| 2026-11-22 | First scoring | All 19 rows scored | Proposed by Claude, signed off by the project owner | `docs/decisions/0.1.10-threat-scores.md` |

**Next re-score due by 2026-12-26**, or sooner after any incident, and again before the
first tool that writes is switched on.

## Incidents

None recorded up to 2026-11-26. The drill of 2026-11-24 was a rehearsal, not an incident.
