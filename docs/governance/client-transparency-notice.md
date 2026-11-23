# Client transparency notice (draft)

Task G.6. Drafted 2026-11-23. **A draft for the project owner to review, not a notice in
use.** It is not legal advice. Nothing here should be sent to a client until the owner
has checked it, filled in the marked gaps, and the first-real-client-data gate (G.7) is
cleared. It describes ExecWard as built today; if the system changes, this must too.

---

## How AI tools are used on your work

Some of the work I do for you is carried out with the help of AI models. This notice
explains what that involves for your data.

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

Each source is labelled with how sensitive its data is. A task is only allowed to handle
data up to the level set for your project.

### Who else receives it

The result of a script goes to the AI model that asked for it, so it is processed by
that model's provider. I use these providers only through their business services,
under terms where they act on my instructions and do not use the data to train their
models:

- [the owner to list: the model providers in use, and the service each is used through]
- Cloudflare, which runs the service and stores its records.
- GitHub, where the repositories are held.

Some of this processing takes place in the United States, under the safeguards each
provider's data processing terms set out.

Notification emails about this system contain only a link. They never contain your data.

### How long it is kept

| What | Kept for |
|---|---|
| The full text of scripts and what they asked for | 7 days |
| A record that each action happened, without its content | 90 days |
| The full text for any task that raised a security concern | 90 days |

Each provider keeps what it receives for its own period, set out in its terms.
[the owner to add: each provider's retention period, checked on the day this is sent]

Backup copies of these records are kept for 7 days and then deleted.

You can ask me to delete the records of work done for you at any time. The content is
removed straight away from the live records; it remains in backup copies for up to 7
days. A content-free outline remains for up to 90 days, because the records are linked
together so that tampering can be detected.

### What is checked by a person

Most tasks run without a person reviewing each step. I am asked to decide when the
automatic checks cannot, and whenever a security check fails. Results are checked
automatically for certain problems, such as containing a password. **They are not
otherwise reviewed for correctness before I use them**, and I treat them as a draft to
be checked, as I would any other source.

### Your choices

You can ask me not to use AI tools on your work, or to limit which data they may see.
[the owner to add: how to ask, and who to contact]

---

## Notes for the owner, not for the client

- **Check each statement against the system on the day you send this.** Three are true
  only because of how ExecWard is configured: read-only tools, business-terms provider
  routes, and the retention periods.
- **"Do not use the data to train their models"** rests on task 0.1.6, which read the
  providers' terms through a web-reading agent on 2026-11-22. Re-read them yourself.
- **Your role with each client** (task G.11) decides whether this is your notice to
  give, or information you owe the client so that they can tell their own people.
- **The "outline remains for 90 days" sentence** is a real limit of the design, stated
  in docs/decisions/1.4.4-retention.md. If a client needs faster complete deletion, that
  is a design change, not a wording change.
- **Backups** are kept 7 days (docs/decisions/1.4.5-backups.md). The notice says so. If
  the keep time changes, change the notice. The daily schedule is not running yet.
