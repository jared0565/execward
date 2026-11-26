/**
 * The owner console's one page (tasks 1.6.1 to 1.6.5).
 *
 * Plain HTML with one script and one style block, both carrying the nonce the
 * response's content policy names. It loads nothing from anywhere else.
 * Everything shown is written as text, never as markup, so a project or tool
 * name cannot become part of the page.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --surface: #ffffff; --text: #1a1c1e; --muted: #5b6068;
  --line: #d9dce0; --control: #8b9099; --hover: #f0f1f2; --press: #e4e6e8;
  --stop: #b00020; --stop-hover: #8f001a; --on-stop: #ffffff; --bad: #b00020;
  --radius: .375rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131416; --surface: #1b1d20; --text: #e8e9eb; --muted: #a3a8b0;
    --line: #33363b; --control: #7a808a; --hover: #25282c; --press: #2e3136;
    --bad: #ff8a98;
  }
}
* { box-sizing: border-box; }
body { font: 1rem/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; accent-color: var(--text); caret-color: var(--text); }
::selection { background: var(--text); color: var(--bg); }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0; }
h2 { font-size: 1.125rem; line-height: 1.3; margin: 0 0 .5rem; }
h3 { font-size: 1rem; margin: 1.25rem 0 .25rem; }
p { margin: .5rem 0; }
#summary { margin: .25rem 0 0; color: var(--muted); }
#message { position: sticky; top: 0; z-index: 1; min-height: 2.5rem; margin: .5rem 0 0; padding: .5rem 0; background: var(--bg); font-weight: 600; border-bottom: 1px solid transparent; }
#message:not(:empty) { border-bottom-color: var(--line); }
#message.bad { color: var(--bad); }
section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.25rem; }
#message + section { border-top: 0; margin-top: 0; padding-top: .5rem; }
button, input, select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--control); border-radius: var(--radius); min-height: 2.75rem; }
button { padding: .5rem .9rem; cursor: pointer; }
button:hover { background: var(--hover); }
button:active { background: var(--press); }
button.stop { background: var(--stop); border-color: var(--stop); color: var(--on-stop); font-weight: 600; }
button.stop:hover, button.stop:active { background: var(--stop-hover); border-color: var(--stop-hover); }
button:disabled { opacity: .55; cursor: default; }
input, select { padding: .5rem .6rem; width: 100%; max-width: 100%; }
::placeholder { color: var(--muted); opacity: 1; }
:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
label { display: grid; gap: .25rem; font-size: .875rem; font-weight: 600; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .75rem; margin: .75rem 0; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0; }
ul { padding-left: 1.2rem; margin: .5rem 0; }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: .875rem; }
.item { background: var(--surface); border: 1px solid var(--line); border-radius: .5rem; padding: 1rem; margin: .75rem 0; }
.item strong { display: block; }
.item strong::first-letter { text-transform: uppercase; }
.item label { max-width: 28rem; margin: .75rem 0; }
.option { display: grid; grid-template-columns: minmax(0, 14rem) minmax(0, 1fr); gap: .25rem .75rem; align-items: center; margin: .5rem 0; }
.option button { width: 100%; text-align: left; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: .4rem .75rem .4rem 0; border-bottom: 1px solid var(--line); }
th { font-size: .875rem; font-weight: 600; color: var(--muted); }
th:last-child, td:last-child { padding-right: 0; }
th:first-child, td:first-child { width: 100%; min-width: 9rem; }
th.num { white-space: normal; }
td .note { font-weight: 400; margin-top: .25rem; }
.num { text-align: right; white-space: nowrap; }
.flag td:first-child { font-weight: 600; }
@media (max-width: 30rem) { .option { grid-template-columns: 1fr; } }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const say = (text, bad) => { $("message").textContent = text; $("message").className = bad ? "bad" : ""; };
const list = (id, items, none) => {
  const el = $(id); el.replaceChildren();
  if (items.length === 0) { const li = document.createElement("li"); li.textContent = none; li.className = "muted"; el.append(li); return; }
  for (const item of items) { const li = document.createElement("li"); li.textContent = item; el.append(li); }
};
const show = (state) => {
  $("killed").textContent = state.killed ? "STOPPED. Nothing runs until the kill switch is cleared." : "Not set.";
  $("codeMode").textContent = state.codeMode ? "On" : "Off";
  $("summary").textContent = (state.killed ? "Kill switch: STOPPED" : "Kill switch: not set") + ". Code Mode: " + (state.codeMode ? "on" : "off") + ".";
  if (state.onboarding) $("profile").value = state.onboarding.profile;
  $("onboarding").textContent = state.onboarding ? "Done (" + state.onboarding.profile + " profile)" : "Not done. Code Mode cannot be switched on until it is.";
  $("version").textContent = String(state.version);
  list("paused", state.pausedProjects, "No project is paused.");
  list("blocked", state.blockedTools, "No tool is blocked.");
};
const reply = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { say(body.message || "That did not work.", true); return; }
  show(body.state); return body.state;
};
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const count = (n) => Number(n).toLocaleString("en");
// A table of text cells. Each row is a list of values; a number is set to the right. A row may be { cells, flag, note }.
const table = (id, head, rows, none) => {
  const box = $(id); box.replaceChildren();
  const top = el("tr"); for (const name of head) { const th = el("th", name); th.scope = "col"; top.append(th); }
  const thead = el("thead"); thead.append(top);
  const tbody = el("tbody");
  if (rows.length === 0) { const td = el("td", none, "muted"); td.colSpan = head.length; const tr = el("tr"); tr.append(td); tbody.append(tr); }
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : row.cells;
    const tr = el("tr", undefined, row.flag ? "flag" : "");
    for (const cell of cells) tr.append(typeof cell === "number" ? el("td", count(cell), "num") : el("td", cell));
    // The note sits under the name, in the one column that wraps, so it is never off the side of a narrow screen.
    if (row.note) tr.firstChild.append(el("div", row.note, "note"));
    tbody.append(tr);
  }
  // An empty table is one line saying so, with no headings over it.
  if (rows.length === 0) box.append(tbody); else box.append(thead, tbody);
  for (const th of top.children) if (rows.length > 0 && typeof (Array.isArray(rows[0]) ? rows[0] : rows[0].cells)[[...top.children].indexOf(th)] === "number") th.className = "num";
};
// The stop button is never switched off: a request that hangs must not take the kill switch away.
const busy = (on) => { for (const button of document.querySelectorAll("button")) if (button.id !== "kill") button.disabled = on; };
// How long an action waits for the server before the page gives up and the buttons come back.
const ACTION_TIMEOUT_MS = 30000;
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const showQueue = (body) => {
  const box = $("queue"); box.replaceChildren();
  if (body.items.length === 0) box.append(el("p", "Nothing is waiting for you.", "muted"));
  for (const item of body.items) {
    const card = el("div", undefined, "item");
    card.append(el("strong", (item.urgent ? "URGENT: " : "") + item.trigger.replaceAll("_", " ") + " in project " + item.project));
    card.append(el("p", "Raised " + when(item.createdAt) + (item.expiresAt ? ". Closes by itself " + when(item.expiresAt) : "") + (item.toolPath ? ". Tool: " + item.toolPath : "") + (item.errorCode ? ". Code: " + item.errorCode : "") + "."));
    card.append(el("p", "Already done to keep things safe: " + item.safeAction));
    for (const figure of item.figures || []) card.append(el("p", "Figure " + figure.name + ", the " + figure.op + " of " + figure.rows + " numbers: the script said " + figure.declared + " and the server got " + figure.recomputed + (figure.agrees ? ". They agree." : ". They differ.")));
    if (item.acknowledgedAt) card.append(el("p", "You chose to keep it this way on " + when(item.acknowledgedAt) + ". It stays here until you choose something that closes it."));
    const reason = el("input"); reason.maxLength = 200;
    const reasonLabel = el("label", "Reason (needed for some choices)"); reasonLabel.append(reason);
    card.append(reasonLabel);
    for (const option of item.options) {
      const button = el("button", option.label + (option.id === item.recommended.optionId ? " (recommended)" : ""));
      button.title = option.effect;
      button.onclick = async () => { await act({ action: "resolve", id: item.id, option: option.id, reason: reason.value.trim() }, "Recorded: " + option.label); loadQueue(); };
      const line = el("div", undefined, "option");
      line.append(button, el("span", option.effect + (option.reversible ? "" : " Cannot be undone.") + (option.needsReason ? " Needs a reason." : ""), "note"));
      card.append(line);
    }
    card.append(el("p", "Why that one is recommended: " + item.recommended.rule, "note"));
    box.append(card);
  }
  list("proposals", body.proposals.map((p) => p.proposal + " (chosen " + p.timesChosen + " times)"), "No rule is proposed.");
};
const loadQueue = async () => {
  try { const response = await fetch("/console/queue"); const body = await response.json().catch(() => ({})); if (response.ok) showQueue(body); else say(body.message || "The queue could not be read.", true); }
  catch { say("The queue could not be reached.", true); }
};
const KINDS = { bounded_tool_heavy: "Runs that called tools", exploratory: "Runs that looked for tools first", no_tools: "Runs that used no tool" };
const showSaving = (saving) => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  $("savingPeriod").textContent = "From " + day(saving.periodStart) + " to " + day(saving.periodEnd) + ".";
  table("saving", ["Kind of run", "Runs", "Verified", "Estimated saving", "Verification used", "Net"], saving.lines.filter((line) => line.runs > 0).map((line) => ({
    cells: [(line.flagged ? "NEGATIVE: " : "") + (KINDS[line.kind] || line.kind), line.runs, line.verifiedRuns, line.estimatedSavingTokens, line.verificationTokens, line.netSavingTokens],
    flag: line.flagged, note: line.advice })), "No run has been counted in this period.");
};
const loadSaving = async () => {
  try { const response = await fetch("/console/saving"); const body = await response.json().catch(() => ({})); if (response.ok && body.saving) showSaving(body.saving); else table("saving", [""], [], "The figures could not be read."); }
  catch { table("saving", [""], [], "The figures could not be read."); }
};
const showStats = (stats) => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  $("statsPeriod").textContent = "From " + day(stats.from) + " to " + day(stats.to) + ".";
  for (const by of ["project", "client", "model", "session"]) {
    table("stats-" + by, ["Name", "Runs", "Estimated saving", "Measured: verified runs", "Measured: verification tokens"], (stats.by[by] || []).map((group) =>
      [group.key, group.runs, group.estimated.savingTokens, group.measured.verifiedRuns, group.measured.verificationTokens]), "No run in this period.");
  }
  list("statsNotes", stats.notes || [], "");
};
const loadStats = async () => {
  try { const response = await fetch("/console/stats"); const body = await response.json().catch(() => ({})); if (response.ok && body.stats) showStats(body.stats); else list("statsNotes", [], "The stats could not be read."); }
  catch { list("statsNotes", [], "The stats could not be read."); }
};
const CLASSES = { public: "Public", internal: "Internal", confidential: "Confidential", client_personal: "Client personal data" };
const showProjects = (projects) => {
  table("projects", ["Project", "Project's own class", "AI use", "Client's limit"], projects.map((record) => ({
    cells: [record.project, CLASSES[record.dataClass] || record.dataClass, record.clientChoice && record.clientChoice.aiUse === "off" ? "OFF" : "On", record.clientChoice && record.clientChoice.limit ? (CLASSES[record.clientChoice.limit] || record.clientChoice.limit) : "None"],
    flag: Boolean(record.clientChoice && record.clientChoice.aiUse === "off") })), "No project has a record.");
};
const loadProjects = async () => {
  try { const response = await fetch("/console/projects"); const body = await response.json().catch(() => ({})); if (response.ok && body.projects) showProjects(body.projects); else table("projects", [""], [], "The projects could not be read."); }
  catch { table("projects", [""], [], "The projects could not be read."); }
};
const load = async () => { try { await reply(await fetch("/console/state")); } catch { say("The console could not be reached.", true); } loadQueue(); loadProjects(); loadSaving(); loadStats(); };
const act = async (body, done) => {
  say("Working..."); busy(true);
  try {
    const response = await fetch("/console/action", { method: "POST", signal: AbortSignal.timeout(ACTION_TIMEOUT_MS), headers: { "content-type": "application/json", "x-execward-console": "1" }, body: JSON.stringify(body) });
    if (await reply(response)) say(done);
  } catch { say("The console did not answer. Nothing is known to have changed; reload to see the current state.", true); }
  finally { busy(false); }
};
const val = (id) => $(id).value.trim();
$("kill").onclick = () => act({ action: "kill", reason: val("killReason") }, "Stopped.");
$("clearKill").onclick = () => act({ action: "clear_kill", reason: val("killReason") }, "Kill switch cleared.");
$("on").onclick = () => act({ action: "code_mode_on" }, "Code Mode is on.");
$("off").onclick = () => act({ action: "code_mode_off" }, "Code Mode is off.");
$("onboard").onclick = () => act({ action: "complete_onboarding", profile: $("profile").value }, "Onboarding recorded.");
$("pause").onclick = () => act({ action: "pause_project", project: val("project"), reason: val("projectReason") }, "Project paused.");
$("resume").onclick = () => act({ action: "resume_project", project: val("project"), reason: val("projectReason") }, "Project resumed.");
$("choice").onclick = async () => { await act({ action: "set_client_choice", project: val("choiceProject"), aiUse: $("choiceUse").value, limit: $("choiceLimit").value, reason: val("choiceReason") }, "The client's choice is recorded."); loadProjects(); };
$("block").onclick =() => act({ action: "block_tool", tool: val("tool"), reason: val("toolReason") }, "Tool blocked.");
$("testEmail").onclick = () => act({ action: "test_email" }, "Test email sent. Check your inbox, and your spam folder.");
$("unblock").onclick = () => act({ action: "unblock_tool", tool: val("tool"), reason: val("toolReason") }, "Tool unblocked.");
$("writeCheck").onclick = async () => {
  say("Working..."); busy(true);
  try {
    const response = await fetch("/console/action", { method: "POST", signal: AbortSignal.timeout(ACTION_TIMEOUT_MS), headers: { "content-type": "application/json", "x-execward-console": "1" }, body: JSON.stringify({ action: "github_write_check", repository: val("writeRepo") }) });
    const body = await response.json().catch(() => ({}));
    say(body.message || "The check could not be run.", !(response.ok && body.writeCheck && body.writeCheck.outcome === "refused"));
  } catch { say("The console could not be reached.", true); }
  finally { busy(false); }
};
load();
`;

export function consolePage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>ExecWard console</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1>ExecWard console</h1>
<p id="summary">Loading...</p>
<p id="message" role="status" aria-live="polite"></p>

<section>
<h2>Waiting for you</h2>
<div id="queue"><p class="muted">Loading...</p></div>
<h3>Proposed rules</h3>
<ul id="proposals"></ul>
<p class="note">A choice you have made several times is listed here as a proposal. Nothing is adopted by itself.</p>
</section>

<section>
<h2>Kill switch</h2>
<p id="killed">Loading...</p>
<div class="fields"><label>Reason <input id="killReason" maxlength="200"></label></div>
<div class="actions">
<button class="stop" id="kill">Stop everything now</button>
<button id="clearKill">Clear the kill switch</button>
</div>
<p class="note">Stopping never waits for a reason. Clearing needs one.</p>
</section>

<section>
<h2>Code Mode</h2>
<p>Currently: <strong id="codeMode">Loading...</strong></p>
<div class="actions">
<button id="on">Switch on</button>
<button id="off">Switch off</button>
</div>
</section>

<section>
<h2>Paused projects</h2>
<ul id="paused"></ul>
<div class="fields">
<label>Project <input id="project" maxlength="200"></label>
<label>Reason <input id="projectReason" maxlength="200"></label>
</div>
<div class="actions">
<button id="pause">Pause</button>
<button id="resume">Resume</button>
</div>
</section>

<section>
<h2>Client choices</h2>
<p>A client can ask that AI tools are not used on their work, or that they see less. Record it here and it is enforced from the next run.</p>
<div class="scroll"><table id="projects"><tbody><tr><td class="muted">Loading...</td></tr></tbody></table></div>
<div class="fields">
<label>Project <input id="choiceProject" maxlength="200"></label>
<label>AI use
<select id="choiceUse"><option value="on">On</option><option value="off">Off: run nothing for this project</option></select></label>
<label>Most the client lets AI tools see
<select id="choiceLimit"><option value="">No limit of their own</option><option value="public">Public data only</option><option value="internal">Internal data</option><option value="confidential">Confidential data</option></select></label>
<label>Reason: who asked, and when <input id="choiceReason" maxlength="200"></label>
</div>
<div class="actions"><button id="choice">Record the client's choice</button></div>
<p class="note">A client's limit can only lower what a run may handle, never raise it above the project's own class. A script that is already running finishes.</p>
</section>

<section>
<h2>Blocked tools</h2>
<ul id="blocked"></ul>
<div class="fields">
<label>Tool <input id="tool" maxlength="200"></label>
<label>Reason <input id="toolReason" maxlength="200"></label>
</div>
<div class="actions">
<button id="block">Block</button>
<button id="unblock">Unblock</button>
</div>
</section>

<section>
<h2>Net saving after verification</h2>
<p id="savingPeriod" class="note"></p>
<div class="scroll"><table id="saving"><tbody><tr><td class="muted">Loading...</td></tr></tbody></table></div>
<p class="note">The saving is an estimate from a rough rule of one token per four bytes. Verification tokens are the provider's own count. A kind of run marked NEGATIVE uses more tokens than it saves.</p>
</section>

<section>
<h2>Stats</h2>
<p id="statsPeriod" class="note"></p>
<h3>By project</h3><div class="scroll"><table id="stats-project"></table></div>
<h3>By client</h3><div class="scroll"><table id="stats-client"></table></div>
<h3>By model</h3><div class="scroll"><table id="stats-model"></table></div>
<h3>By session</h3><div class="scroll"><table id="stats-session"></table></div>
<ul id="statsNotes" class="note"></ul>
</section>

<section>
<h2>Onboarding</h2>
<p id="onboarding">Loading...</p>
<div class="fields"><label>Governance profile
<select id="profile"><option value="lightweight">Lightweight</option><option value="formal">Formal</option></select></label></div>
<div class="actions"><button id="onboard">Record onboarding</button></div>
<p class="note">Both profiles run the same security controls. Every other setting keeps its safe default.</p>
</section>

<section>
<h2>Email</h2>
<p>Urgent items are emailed to you at once, and the rest once a day. An email only ever says that something is waiting, with a link to this console.</p>
<div class="actions"><button id="testEmail">Send me a test email</button></div>
</section>

<section>
<h2>GitHub</h2>
<p>ExecWard may only read from GitHub. This tries one harmless write, which GitHub should refuse, and records the answer in the audit log.</p>
<div class="fields"><label>Repository <input id="writeRepo" placeholder="owner/repository" autocomplete="off"></label></div>
<div class="actions"><button id="writeCheck">Check that GitHub refuses a write</button></div>
</section>

<p class="note">Every change is numbered and written to the audit log. Current number: <span id="version">-</span>.</p>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
