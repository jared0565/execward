# Upstream server list

Task G.2. Started 2026-11-23. **Update this file in the same pull request as any change
that adds, removes or re-pins an upstream server or one of its tools.** A test
(`test/upstream-servers-doc.test.ts`) fails when the tool table below and the code
disagree, so a changed definition cannot merge with this list left behind.

## Approved servers

One: GitHub, read-only.

| Server | Publisher | Pinned version | Approved on | Approved by |
|---|---|---|---|---|
| `github` | GitHub (the REST API at `api.github.com`). The connector and every tool definition are ExecWard's own code, `src/connectors/github.ts`; no third-party MCP server is wrapped | REST API version `2022-11-28`, sent on every request | 2026-11-24 | The project owner |

What "pinned" means here:

- **The API.** Every request names the REST API version above, goes to
  `api.github.com` and nowhere else, and is a GET. Changing the version constant
  (`GITHUB_API_VERSION`) is a re-pin and needs this file updated.
- **The definitions.** ExecWard wrote the tool names, descriptions and schemas itself.
  The hashes below therefore guard against a change to ExecWard's own definitions that
  nobody approved, not against a publisher changing its text. A wrapped third-party
  server would be different: its hash would pin what that publisher says.
- **The credential.** On production it is a GitHub App with read-only permissions on
  chosen repositories (task 2.1.10, `docs/decisions/1.1.2-github-credential.md`).

Approval on record: the owner chose the 15 read-only tools and one project on
2026-11-24 (task 2.1.10). `npm run setup:github` wrote them to production's policy
table that day; it is audit entry 7. On 2026-11-26 a second project, `bytes-web`
(internal), was added with the same command (audit entry 74, task 2.3.2). No tool or
hash changed.

## Approved tools and their definition hashes

A tool's hash is the `hash` of its pin (`src/registry/registry.ts`): the SHA-256 of its
name, description and schemas. The hashes come from `githubPinsAndPolicy()` in
`src/connectors/github.ts`.

| Tool path | Server | Tier | Data class | Definition hash | Approved on |
|---|---|---|---|---|---|
| `github_get_repository` | github | 0 | internal | `13bcf65acef138ce12d634afc2adfe21636ab73814cc01f8c2fc7e6b671ab845` | 2026-11-24 |
| `github_list_branches` | github | 0 | internal | `2b2f0c54bf4a9614a8b6f817d825b28fcadf4e08fb614e7b37ff84b24c5ced07` | 2026-11-24 |
| `github_list_commits` | github | 0 | internal | `8ec28368535fe9b416e2fd61191cc7d1887cbebb70f9f58e67de0ea8de75de94` | 2026-11-24 |
| `github_get_commit` | github | 0 | confidential | `45b6d82763449310bf782141434c6079a81967af75b2b06521897917f53bc8ed` | 2026-11-24 |
| `github_get_file_contents` | github | 0 | confidential | `acb54c6116e8cb7176f1d87cbeb076b92c32deafa42f4df49be73d656f398f27` | 2026-11-24 |
| `github_search_code` | github | 0 | confidential | `7d339b9c7edbe302614f4b6117ef97aef8e874161b7101804aa667f0437b23fc` | 2026-11-24 |
| `github_list_issues` | github | 0 | internal | `88b326850097e62b12815f986e792248c8b100780bc458114a562a2f2216ef17` | 2026-11-24 |
| `github_get_issue` | github | 0 | confidential | `cc4d9c4f95d97785c600195567ac6cd84a3f6c5a074d771eb98cdaa21f9146d2` | 2026-11-24 |
| `github_list_issue_comments` | github | 0 | confidential | `2c4127b86557dedfb10b6be8ede7d0b4ae0f0ea5bef8e10768680f021e88ec66` | 2026-11-24 |
| `github_search_issues` | github | 0 | confidential | `1ba1fe41f623aae5249de1bf4f10afc502634a6e1adcfa44a51d608fc26acd8b` | 2026-11-24 |
| `github_list_pull_requests` | github | 0 | internal | `c2df3b58cc9a279c45a51edc0c32971e07f907949a1f719e4b57fd5d607e92a9` | 2026-11-24 |
| `github_get_pull_request` | github | 0 | confidential | `a75bd456e3f42d0d930c3c54910c70024dd382d5dbdd8e27cc2bfcacb16dd214` | 2026-11-24 |
| `github_list_pull_request_files` | github | 0 | confidential | `cad2641c7503b9da31f2c23f4c23a3be6aa515a77adb85beb54f614f10e352bb` | 2026-11-24 |
| `github_list_releases` | github | 0 | internal | `0bb3146fd86be6dbebcfb3c94a0897eddd2e745613c6694e297ef9c4f5e889b8` | 2026-11-24 |
| `github_list_workflow_runs` | github | 0 | internal | `5409abc9fae97aae94621beaa49b1d7cddd27fc38f61212db9835f2dd8dd53fc` | 2026-11-24 |

Checked 2026-11-25: all 15 records in production's `policy` table were read and each
is the same, field for field, as the record the code at `125d125` computes. The rows
there were written on 2026-11-24 between 11:56:08Z and 11:56:43Z.

What the test does not cover: it compares this file with the code, not with
production. Production is compared with the code when a tool is called (a call whose
stored hash differs from the pin is refused as `definition_changed`, FR-22), and by
hand as above.

## Planned, not approved

None.

## How to add a server

1. Record the publisher and the exact version or commit being approved.
2. Read every tool's description and schemas. Approve each with `approve()`; a
   description that fails the safety scan cannot be approved.
3. Write a policy record for each tool, carrying the pin's hash.
4. Add the server and each tool to the tables above, in the same pull request.
