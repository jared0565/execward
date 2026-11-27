# Using ExecWard from Claude Code

ExecWard is a single-owner Cloudflare Worker. It serves one tool, `code`, over MCP at `https://mcp.execward.com/mcp`. A model writes a short script that calls read-only GitHub tools, and ExecWard runs that script in a sandbox under the project owner's policy.

This guide connects another repository on your own computer to ExecWard, using Claude Code.

## Before you start

- Node.js and Claude Code are installed.
- This repository is checked out, and `npm ci` has been run in it.
- The other repository is a git repository, and its `origin` is on GitHub.
- You can sign in as the project owner. Cloudflare Access sends an emailed code, and the owner's authenticator app is the second factor.

## Steps

Run the commands from this repository, not from the other one. Replace `PATH` with the other repository's folder. Quote it if it has spaces.

### 1. Check, changing nothing

```bash
npm run repo:setup -- --repo PATH --check
```

The command prints one line for each step. Note any step that is not right.

### 2. Set it up

```bash
npm run repo:setup -- --repo PATH
```

Add `--add-project` only when production has no record of the project yet. You can also add `--class` to set the project's class, which defaults to internal.

```bash
npm run repo:setup -- --repo PATH --add-project
```

`--add-project` writes to the production database and to its audit log. That is why it is never done by default.

The project's name is made from the repository's name. To choose another, add `--project NAME`.

### 3. Sign in

Open Claude Code in the other repository's folder. Type `/mcp`, choose `execward`, and sign in in the browser.

### 4. Check again

```bash
npm run repo:setup -- --repo PATH --check
```

The check should end with "Ready" and the project name.

### 5. Check GitHub App access

The command cannot see whether the GitHub App can read the repository, so check it yourself. In the other repository's folder, ask Claude Code to run one ExecWard script that calls `github_get_repository` for `OWNER/REPO`.

## What the command checks

| Step | What it checks | What it does if it is wrong |
|---|---|---|
| Node | The Node version running the command | Reports it. It does not install Node |
| Claude Code | The `claude` command answers | Reports it, and stops |
| Repository | The folder is a git repository whose `origin` is on GitHub | Reports it |
| Project record | Production has a record of the project | Adds it, but only with `--add-project`, at the class given by `--class` (internal if not given) |
| MCP server | Claude Code has the ExecWard server for that folder, at the right address | Adds it. A server with the same name that points elsewhere is replaced |
| Connection | Claude Code reports the server as connected | Says how to sign in. Only a person can do that |
| CLAUDE.md | The folder's `CLAUDE.md` holds the ExecWard block, naming the project | Writes or replaces that block. Nothing else in the file changes |
| GitHub App access | Nothing. The command cannot see this | Reports it as unchecked, and says how to check (step 5) |

The command exits with 0 only when every step except the last one is right. Running it again changes nothing.

## If something goes wrong

**Sign-in ends with "Authentication failed ... invalid_request: Consent request is malformed".** This was seen once, on 2026-11-27, when the first attempt went through the full emailed-code sign-in. Trying again straight away worked, because the browser was by then signed in. The cause is not proven. The message comes from Cloudflare Access, whose managed OAuth is labelled Beta. Try again straight away. If it fails a second time, the cause is something else.

**The connection still shows FAILED.** Sign-in has not been done in this folder. Repeat step 3.

**A call is refused because the project is unknown.** The script must name the project exactly as the setup command printed it. The block the command wrote in that folder's `CLAUDE.md` gives the name.

## Limits

- Only Claude Code is set up. Codex and other clients are not.
- The command installs nothing. It reports a missing or old Node or Claude Code and says what to do.
- Run it from this repository. It is not installed in other repositories.
- The `CLAUDE.md` block is not committed for you. Whether to commit it is your decision.
- Tokens last 15 minutes and renew quietly for up to 7 days. After that, sign in again (step 3).

The reasons behind each choice are in `docs/decisions/`.
