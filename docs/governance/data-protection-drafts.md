# Data protection drafts: the DPIA and the transfer risk assessment

Task G.11. Drafted 2026-11-26. **Drafts for the project owner to review. Not signed, not
in force, and not legal advice.**

The full drafts are a Claude Doc, where the owner reviews and edits them:
https://claude.ai/artifact/4kqc4Yun5mjXD2A6CuyBaT. This file records what they rest on
and what they found, so that the repository holds the facts even if the document
changes.

## What was drafted

| Part | What | State |
|---|---|---|
| A | A data protection impact assessment, following the seven steps of the regulator's guidance | Drafted. The conclusion and sign-off are left blank for the owner |
| B | Which rule each provider's transfer to the United States rests on, and a transfer risk assessment for the two that need one | Drafted |
| C | The owner's role with each client | Cannot be drafted: it is a fact about each contract |

## What the research found

Read on 2026-11-26 from the providers' and the regulator's own pages, by a web-reading
agent that quoted each one. The quotes were not re-read by the author.

| Provider | Says it is in the UK-US data bridge | Contract includes the UK Addendum | Route the transfer rests on | Transfer risk assessment |
|---|---|---|---|---|
| Cloudflare | Yes, on its own pages | Yes | Data bridge | Not asked for on that route, by the regulator's page read |
| GitHub | Yes, in its own name | Yes | Data bridge | Same |
| Anthropic | Not found on any page read | Yes | The contract safeguard | Needed. Drafted |
| OpenAI | Not found on any page read | Yes | The contract safeguard | Needed. Drafted |

- "Not found" means the pages read do not mention it. It does not mean it is known to be
  absent.
- **The official list of who is in the framework did not load.** The two "Yes" answers
  are the companies' own statements. The regulator says the data bridge may be relied on
  only for a company shown as active on that list, signed up to the UK Extension, and
  registered for the kind of data sent. The owner has to look all four up.
- All four data processing agreements are part of the provider's business terms without
  a separate signature, as read. OpenAI also offers a form to sign.
- Sub-processors listed on the day: Anthropic 22, OpenAI 16, Cloudflare 12, GitHub 23.

## The nine risks in the draft DPIA

Disclosure to a provider under the wrong terms; planted text steering the model;
sandbox escape; a secret copied into a result; records kept too long; access by United
States authorities; a wrong result acted on; console takeover; special kinds of data
turning up in a repository. Likelihood and severity are the author's judgments.

The draft's reading, for the owner to accept or change: none is both likely and serious
while tools only read, provided three things are true first: the owner's Claude Code is
on an organisation account under Anthropic's Commercial Terms, a human security review
has been done (task G.10), and each client has been told and their contract allows it.

## What is the owner's

- Read the DPIA and write its conclusion and sign-off.
- Confirm how Claude Code is signed in, and that the OpenAI key is from a business account.
- Look up all four companies on the official framework list.
- Decide whether a data protection professional reads these before the first client.
- State, for each client, whether the owner is the controller or the client's processor.

## What was not read

- The official Data Privacy Framework list: only its title loaded.
- The regulator's DPIA template and its transfer risk assessment tool document. Only the
  pages describing them, so the tool's guidance under each question is missing.
- Cloudflare's and GitHub's agreements were cut off about two thirds of the way through.
- Anthropic's Commercial Terms.
- Two answers in the transfer risk assessment (whether the transfer raises the risk of a
  human rights breach, and whether the safeguard can be enforced) are the author's
  reasoning with no source behind them.
- The regulator marks its DPIA guidance as under review.
