# Task G.7: the first-real-client-data gate

Date: 2026-11-26. Status: **closed. It was not opened, and this says why.**

## What the gate is

Until it is cleared, no project and no provider route may handle client personal data.
It is one value in the code, `CLIENT_DATA_GATE` in `src/broker/exposure.ts`, and changing
it is the act of clearing the gate.

## What was asked, and what was done

On 2026-11-26 the project owner, going through the governance tasks, said of this one:
"just go ahead with this". The same message put the paid security review (G.10) off
until before the first paying client, and asked for the notice (G.6) and the data
protection paperwork (G.11) as drafts for review and approval.

**The gate was not opened.** Opening it would let client personal data reach model
providers, and the three things it waits on are not done. The owner's own plan in the
same message has two of them finishing later. So "go ahead" was taken to mean: get
everything ready, and open the gate when its conditions are met. If the owner meant the
gate to be opened now regardless, that needs saying outright, with these conditions in
view.

## What the gate waits on

The task names four: 0.1.6, 0.1.7, G.6 and G.10. G.11 is listed with them because its
own row sets the same deadline: before any project is classed client personal data.

| Needed | State on 2026-11-26 |
|---|---|
| 0.1.6 Providers' data terms read | Done 2026-11-22. API routes approved; personal plans not |
| 0.1.7 Personal data duties checked | Done 2026-11-22. A DPIA is needed before client personal data |
| G.6 Client notice | Drafted and brought up to date. Five blanks are the owner's. Not approved |
| G.11 DPIA and transfer risk assessment | Drafted. Conclusion and sign-off are the owner's. Not approved |
| G.10 Paid human security review | Not started. The owner's decision: before the first paying client |

## Also needed, found while preparing it

These are not in the task's list, and the drafts rest on them.

- **How the owner's Claude Code is signed in.** A personal plan has no data processing
  terms. ExecWard cannot see this; today it treats every connected client as not
  approved, which caps results at internal data whatever the gate says. Clearing the
  gate alone would therefore not let client personal data through to a client signed in
  that way: the provider route has to be established too.
- **That the reviewer's OpenAI key is from an account under business terms.** Asked on
  2026-11-25; not confirmed in words.
- **All four providers looked up on the official Data Privacy Framework list**, which
  would not load for the research.

## How it will be cleared

In one pull request that changes `CLIENT_DATA_GATE` to cleared, marks G.7 Done, and
names in its description each record above with the date the owner approved it. Not
before.
