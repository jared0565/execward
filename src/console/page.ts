/**
 * The owner console's one page (tasks 1.6.1 to 1.6.5).
 *
 * Plain HTML with one script and one style block, both carrying the nonce the
 * response's content policy names. It loads nothing from anywhere else.
 * Everything shown is written as text, never as markup, so a project or tool
 * name cannot become part of the page.
 */

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
section { border-top: 1px solid #8884; padding-top: .5rem; }
button { font: inherit; padding: .5rem 1rem; margin: .25rem .25rem .25rem 0; cursor: pointer; }
button.stop { background: #b00020; color: #fff; border: 0; font-weight: 600; }
input, select { font: inherit; padding: .4rem; margin: .25rem .25rem .25rem 0; max-width: 100%; }
#message { min-height: 1.5rem; font-weight: 600; }
#message.bad { color: #b00020; }
ul { padding-left: 1.2rem; }
.muted { opacity: .7; }
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
const load = async () => { try { await reply(await fetch("/console/state")); } catch { say("The console could not be reached.", true); } };
const act = async (body, done) => {
  say("Working...");
  try {
    const response = await fetch("/console/action", { method: "POST", headers: { "content-type": "application/json", "x-execward-console": "1" }, body: JSON.stringify(body) });
    if (await reply(response)) say(done);
  } catch { say("The console could not be reached. Nothing is known to have changed.", true); }
};
const val = (id) => $(id).value.trim();
$("kill").onclick = () => act({ action: "kill", reason: val("killReason") }, "Stopped.");
$("clearKill").onclick = () => act({ action: "clear_kill", reason: val("killReason") }, "Kill switch cleared.");
$("on").onclick = () => act({ action: "code_mode_on" }, "Code Mode is on.");
$("off").onclick = () => act({ action: "code_mode_off" }, "Code Mode is off.");
$("onboard").onclick = () => act({ action: "complete_onboarding", profile: $("profile").value }, "Onboarding recorded.");
$("pause").onclick = () => act({ action: "pause_project", project: val("project"), reason: val("projectReason") }, "Project paused.");
$("resume").onclick = () => act({ action: "resume_project", project: val("project"), reason: val("projectReason") }, "Project resumed.");
$("block").onclick = () => act({ action: "block_tool", tool: val("tool"), reason: val("toolReason") }, "Tool blocked.");
$("unblock").onclick = () => act({ action: "unblock_tool", tool: val("tool"), reason: val("toolReason") }, "Tool unblocked.");
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
<p id="message" role="status" aria-live="polite"></p>

<section>
<h2>Kill switch</h2>
<p id="killed">Loading...</p>
<label>Reason <input id="killReason" maxlength="200" size="40"></label><br>
<button class="stop" id="kill">Stop everything now</button>
<button id="clearKill">Clear the kill switch</button>
<p class="muted">Stopping never waits for a reason. Clearing needs one.</p>
</section>

<section>
<h2>Code Mode</h2>
<p>Currently: <strong id="codeMode">Loading...</strong></p>
<button id="on">Switch on</button>
<button id="off">Switch off</button>
</section>

<section>
<h2>Onboarding</h2>
<p id="onboarding">Loading...</p>
<label>Governance profile
<select id="profile"><option value="lightweight">Lightweight</option><option value="formal">Formal</option></select></label>
<button id="onboard">Record onboarding</button>
<p class="muted">Both profiles run the same security controls. Every other setting keeps its safe default.</p>
</section>

<section>
<h2>Paused projects</h2>
<ul id="paused"></ul>
<label>Project <input id="project" maxlength="200"></label>
<label>Reason <input id="projectReason" maxlength="200" size="30"></label><br>
<button id="pause">Pause</button>
<button id="resume">Resume</button>
</section>

<section>
<h2>Blocked tools</h2>
<ul id="blocked"></ul>
<label>Tool <input id="tool" maxlength="200"></label>
<label>Reason <input id="toolReason" maxlength="200" size="30"></label><br>
<button id="block">Block</button>
<button id="unblock">Unblock</button>
</section>

<p class="muted">Every change is numbered and written to the audit log. Current number: <span id="version">-</span>.</p>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
