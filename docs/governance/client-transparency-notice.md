# Client transparency notice (draft)

Task G.6. First drafted 2026-11-23; brought up to date 2026-11-26. **A draft for the
project owner to review, not a notice in use.** It is not legal advice. Nothing here
should be sent to a client until the owner has checked it, filled in the marked gaps,
and the first-real-client-data gate (G.7) is cleared. It describes ExecWard as built
today; if the system changes, this must too.

The owner's review copy is a Claude Doc:
https://claude.ai/artifact/AvviTkT9J8WzGsfZQa5atv. It held the same text as this file
on 2026-11-26. If the two differ, the owner's edits there are the newer.

Changed here on 2026-11-27, after a check of this file against the code, and **not yet
carried into the review copy**: what the second AI model is sent (three places), one more
row in "How long it is kept", and two new notes for the owner at the end.

## Blanks only the owner can fill

Everything in **[square brackets]** below.

| # | Blank | Why it is the owner's |
|---|---|---|
| 1 | The business's name and its admin email address. The owner said on 2026-11-26 that a client asks by email, to admin; the address itself is not written here yet | It is the owner's notice |
| 2 | How the owner's Claude Code is signed in: a personal plan, or an organisation account under Anthropic's Commercial Terms | Only the owner can see the account. A personal plan is not approved for client data |
| 3 | That the OpenAI key stored for the reviewer is from an account under business terms | Asked on 2026-11-25; not confirmed in words |
| 4 | The owner's role with each client | A fact about each contract (task G.11) |
| 5 | Each provider's retention period, re-read on the day the notice is sent | The periods below were read by a web-reading agent, not by a person |

---

## How AI tools are used on your work

Some of the work **[your business name]** does for you is carried out with the help of
AI models. This notice explains what that involves for your data.

### What happens

When a task needs information from several places, an AI model writes a short program
(a script) that fetches and combines it. **The scripts are written by AI, not by a
person.** Each one runs in a locked-down environment that can reach only the specific
tools I have approved, and only to read. It cannot browse the internet, reach other
systems, or change, send or delete anything.

Before a script runs it is checked automatically. Every action it takes is checked
against a list of what is allowed, and is recorded.

### What data is processed

- The data in the sources a task reads. At present that is source code repositories and
  their issues, pull requests and history.
- The script itself, and a record of each action it took.
- The result the script produced.
- Where a task comes with a list of what its result must satisfy, the task's
  description, the list, the result and a summary of what the script did are also sent
  to a second AI model, which checks one against the other. Today the AI model doing
  the work writes that list.

Each source is labelled with how sensitive its data is. A task is only allowed to handle
data up to the level set for your project.

### Who else receives it

The result of a script goes to the AI model that asked for it, so it is processed by
that model's provider. I use these providers only through their business services,
under terms where they act on my instructions and do not use the data to train their
models.

| Who | What they do | What they receive |
|---|---|---|
| Anthropic | Runs the AI model that writes the scripts and reads their results **[confirm: through an organisation account under the Commercial Terms, not a personal plan]** | The task, the script and its result |
| OpenAI | Runs the second AI model that checks a result against written requirements **[confirm: an API account under business terms]** | The task's description, the requirements, the result and a summary of what the script did |
| Cloudflare | Runs the service and stores its records | Scripts, results and the record of each action |
| GitHub | Holds the repositories the scripts read | Nothing new: it already holds this data |

All four are United States companies, so some of this processing takes place in the
United States, under the safeguards set out in each provider's data processing terms.

Notification emails about this system contain only a link. They never contain your data.

### How long it is kept

| What | Kept for |
|---|---|
| The full text of scripts and what they asked for | 7 days |
| A record that each action happened, without its content | 90 days |
| The full text for any task that raised a security concern | 90 days |
| Items waiting for my decision, with the error or figures they are about | No time limit yet **[see the notes for the owner]** |
| Backup copies of these records | 7 days, then deleted |

Each provider keeps what it receives for its own period, set out in its terms.
**[Re-read on the day this is sent. As read on 2026-11-22: Anthropic deletes within 30
days, and keeps content flagged for safety for up to 2 years; OpenAI keeps
abuse-monitoring logs for up to 30 days.]**

You can ask me to delete the records of work done for you at any time. The content is
removed straight away from the live records; it remains in backup copies for up to 7
days. A content-free outline remains for up to 90 days, because the records are linked
together so that tampering can be detected.

### What is checked by a person, and what is not

Most tasks run without a person reviewing each step. I am asked to decide when the
automatic checks cannot, and whenever a security check fails.

Results are checked automatically for certain problems, such as containing a password.
Where a task comes with a list of what its result must satisfy, a second AI model from a
different provider checks it against that, and can stop a result that does not meet it. That check
is made by an AI model and can be wrong. **Results are not otherwise reviewed for
correctness before I use them**, and I treat them as a draft to be checked, as I would
any other source.

### Your choices

You can ask me not to use AI tools on your work, or to limit which data they may see.
To ask, send an email to **[the admin email address]**.

---

## Notes for the owner, not for the client

- **Check each statement against the system on the day you send this.** Three are true
  only because of how ExecWard is set up today: read-only tools, business-terms provider
  routes, and the retention periods.
- **"Do not use the data to train their models"** rests on task 0.1.6, which read the
  providers' terms through a web-reading agent on 2026-11-22. Re-read them yourself.
- **The Anthropic row is the weak one.** ExecWard cannot see how a connected Claude Code
  is signed in, so today it treats every client as not approved and holds results to
  internal data. For this notice to be true with client data, the account must be an
  organisation account under the Commercial Terms.
- **Your role with each client** (task G.11) decides whether this is your notice to
  give, or information you owe the client so that they can tell their own people.
- **The "outline remains for 90 days" sentence** is a real limit of the design, stated
  in docs/decisions/1.4.4-retention.md. If a client needs faster complete deletion, that
  is a design change, not a wording change.
- **Backups** are kept 7 days (docs/decisions/1.4.5-backups.md). The notice says so. If
  the keep time changes, change the notice.
- **Deleting a client's records has no command yet** (found 2026-11-27). The notice
  says you can do it "at any time". The function exists and is tested
  (`deleteProjectLogs` in `src/audit/log.ts`), but nothing in the console or in
  `scripts/` runs it, and it clears the audit log only. Build that before sending this
  notice, or change the sentence.
- **Items in your queue are never removed** (found 2026-11-27). An item can hold an
  error's text, the run report and, for a figure that failed its cross-check, both
  values. Nothing deletes from that table, retention does not cover it, deletion on
  request does not cover it, and it is in the daily backup. That is a gap in the design,
  not in the wording; the row added to "How long it is kept" says what is true today.
- **Who writes the requirements.** Through Claude Code the list of what a result must
  satisfy is written by the AI model doing the work, not by you. The notice now says so.
