# Brief for a human security review of the sandbox

Task G.10. Written 2026-11-26. **A draft the project owner can send to a security firm or
freelancer to ask for a quote. Nothing has been commissioned.** The owner's decision of
2026-11-26: the review is done before the first paying client, not now.

## What ExecWard is

A service that lets an AI model do a multi-step task by writing one short JavaScript
script. The script runs in a Cloudflare Dynamic Worker isolate with no network. Its only
way out is a broker in the host Worker, which checks every tool call against a policy
table before calling the tool. It is served to command-line AI clients as a remote MCP
server behind Cloudflare Access.

Today every tool only reads, the only upstream is GitHub through a read-only GitHub App,
and there is one user, the owner. TypeScript, about 70 test files, public repository.

## What the review is for

To find out whether a hostile script, or a model following text an attacker planted in a
tool result, can:

1. Reach anything other than the broker: the network, the host, another run, a credential.
2. Call a tool the policy does not allow, or get data above the project's allowed level.
3. Get data out through a tool's arguments, an error message, a log or a timing channel.
4. Exhaust the host or the owner's budget past the quotas.
5. Make a wrong result count as verified, or switch the verifying model off.
6. Take over the owner's console, or act as the owner over MCP.

## What already exists

- A threat table of 19 threats with scores (`docs/decisions/0.1.10-threat-scores.md`).
- An adversarial suite of 40 scripted attacks, run against the deployed system: 35
  defended, 5 on parts not built yet, none open (2026-11-26).
- Two reviews by an AI model from another family: nine findings at Gate 1 and eleven at
  Gate 2, all acted on. Both records list what was left open
  (`docs/reviews/1.9.7-sandbox-review.md`, `docs/reviews/2.3.3-sandbox-review.md`).

A human review is wanted because those are reviews of source by a model, not attempts
to break a running system.

## What is asked for

- A penetration test of the deployed test Worker, with a script-submission endpoint and
  credentials supplied for the purpose. Production is not to be tested.
- A source review of the sandbox, static check, broker, code tool, verification and MCP
  server: about 25 files.
- Particular attention to what the model reviews could not see: Cloudflare's isolation
  and transport limits as actually deployed, how sign-in is checked at the Worker's
  entry, the GitHub connector and its token, whether the stored retry count is safe when
  two requests arrive together, and the audit log.
- A written report: each finding with severity, a proof and a suggested fix; and a
  retest of the fixes.

## What the owner needs back in a quote

- Price and how many days, for the test with and without the retest.
- Who would do the work, and their experience with JavaScript sandboxes or Cloudflare
  Workers.
- When it could start.
- Whether findings may be published in the repository once fixed.

## Done means

A report filed in `docs/reviews/` with no open critical finding, before any tool that
writes is switched on and before any real client data. The plan's estimate of cost is
several hundred to a few thousand dollars; no budget has been approved.
