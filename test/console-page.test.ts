import { describe, expect, it } from "vitest";
import { consolePage } from "../src/console/page";

const page = consolePage("n");
const body = page.slice(page.indexOf("<body>"), page.indexOf("<script"));
const at = (text: string): number => {
  const found = body.indexOf(text);
  expect(found, text).toBeGreaterThan(-1);
  return found;
};

describe("the console page's layout (the design pass of 2026-11-25)", () => {
  it("puts what is waiting first, then stopping, before any figures", () => {
    const order = ["Waiting for you", "Kill switch", "Code Mode", "Paused projects", "Blocked tools", "Net saving after verification", "Stats", "Onboarding", "Email", "GitHub"].map((heading) => at(`<h2>${heading}</h2>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("says the state of the kill switch and Code Mode in one line at the top", () => {
    expect(at('id="summary"')).toBeLessThan(at("<section>"));
    expect(page).toContain('$("summary").textContent');
  });

  it("keeps the result of an action in view: the status line stays at the top of the window", () => {
    expect(page).toMatch(/#message \{[^}]*position: sticky; top: 0;/);
    expect(body).toContain('<p id="message" role="status" aria-live="polite"></p>');
  });

  it("styles with classes only, because the content policy refuses a style written on an element", () => {
    expect(body).not.toMatch(/\sstyle=/);
    expect(page).not.toMatch(/\.style\b/);
    expect(page).not.toContain("cssText");
  });

  it("labels every field", () => {
    const fields = [...body.matchAll(/<(?:input|select) id="([^"]+)"/g)].map((match) => match[1]);
    expect(fields.sort()).toEqual(["killReason", "profile", "project", "projectReason", "tool", "toolReason", "writeRepo"]);
    for (const id of fields) expect(body, id).toMatch(new RegExp(`<label>[^<]*<(?:input|select) id="${id}"`));
  });

  it("has one stop button, and red is used for nothing but stopping and failure", () => {
    expect(body.match(/class="stop"/g)).toHaveLength(1);
    const style = page.slice(page.indexOf("<style"), page.indexOf("</style>"));
    const usesOfRed = [...style.matchAll(/([^{}]+)\{[^}]*var\(--(?:stop|stop-hover|bad)\)[^}]*\}/g)].map((match) => match[1]?.trim());
    expect(usesOfRed.sort()).toEqual(["#message.bad", "button.stop", "button.stop:hover, button.stop:active"]);
  });

  it("does not let a request be sent twice: buttons are off while one is on its way", () => {
    expect(page).toContain("busy(true)");
    expect(page.match(/finally \{ busy\(false\); \}/g)).toHaveLength(2);
  });

  it("shows figures in tables, with numbers to the right, and a remark under the name it belongs to", () => {
    for (const id of ["saving", "stats-project", "stats-client", "stats-model", "stats-session"]) expect(body).toContain(`<table id="${id}"`);
    expect(page).toContain("font-variant-numeric: tabular-nums");
    expect(page).toContain('tr.firstChild.append(el("div", row.note, "note"))');
  });

  it("lets a table's headings wrap, so a table fits a desk-width screen (seen cut off on production, 2026-11-25)", () => {
    expect(page).toContain("th.num { white-space: normal; }");
    expect(page).not.toMatch(/th\.num \{[^}]*min-width/);
  });

  it("shows the recorded governance profile in the dropdown, not always the first one", () => {
    expect(page).toContain('if (state.onboarding) $("profile").value = state.onboarding.profile;');
  });

  it("keeps secondary text at full strength instead of making it see-through", () => {
    expect(page).toContain(".muted { color: var(--muted); }");
    expect(page).not.toMatch(/\.muted \{[^}]*opacity/);
  });
});
