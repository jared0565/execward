# Upstream server list

Task G.2. Started 2026-11-23. **Update this file in the same pull request as any change
that adds, removes or re-pins an upstream server or one of its tools.**

## Approved servers

None. ExecWard wraps no upstream server yet.

| Server | Publisher | Pinned version | Approved on | Approved by |
|---|---|---|---|---|
| — | — | — | — | — |

## Approved tools and their definition hashes

None. A tool's hash is the `hash` of its pin (`src/registry/registry.ts`): the SHA-256
of its name, description and schemas.

| Tool path | Server | Tier | Data class | Definition hash | Approved on |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## Planned, not approved

| Server | Purpose | Waiting on |
|---|---|---|
| GitHub, read-only | The first wrapped tools (task 1.5.1). The 15 tools are in `src/tools/github-inventory.ts`; the connector and their definitions are in `src/connectors/github.ts`, built 2026-11-23 and tested against a fake | A narrowly scoped credential in the secret store (task 1.1.2), a run against GitHub with it, and the owner's approval of the tool list |

## How to add a server

1. Record the publisher and the exact version or commit being approved.
2. Read every tool's description and schemas. Approve each with `approve()`; a
   description that fails the safety scan cannot be approved.
3. Write a policy record for each tool, carrying the pin's hash.
4. Add the server and each tool to the tables above, in the same pull request.
