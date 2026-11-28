import { describe, expect, it } from "vitest";
import { memoryQuotaStore } from "../src/broker/quotas";
import type { Email } from "../src/console/notify";
import { ERROR_CODES, type ErrorCode } from "../src/contracts/errors";
import { ALERT_EVENT, ALERT_KINDS, ALERT_SUBJECT, alertEmail, alertFor, alertingSink, raiseAlert, type AlertDeps, type AlertKind } from "../src/metrics/alerts";
import { memoryMetricsSink, type RunMetric } from "../src/metrics/metrics";
import { productionAlerts } from "../src/mcp/production";

const HOUR = 60 * 60 * 1000;
const BASE = "https://console.example.com";

function metric(errorCode?: ErrorCode, overrides: Partial<RunMetric> = {}): RunMetric {
  return {
    runId: "run-1",
    project: "demo",
    status: errorCode === undefined ? "completed" : "error",
    ...(errorCode === undefined ? {} : { errorCode }),
    securityEvent: errorCode !== undefined && ERROR_CODES[errorCode].security,
    durationMs: 12,
    toolCalls: 1,
    failedCalls: 0,
    recordsRead: 0,
    retries: 0,
    verification: "not_applicable",
    ...overrides,
  };
}

function setup(options: { mailer?: "none" | "broken"; clock?: { now: number } } = {}) {
  const sent: Email[] = [];
  const lines: Record<string, unknown>[] = [];
  const clock = options.clock ?? { now: 10 * HOUR };
  const deps: AlertDeps = {
    write: (line) => void lines.push({ ...line }),
    ...(options.mailer === "none"
      ? {}
      : {
          mailer: {
            send: async (email) => {
              if (options.mailer === "broken") throw new Error("the mail service is down");
              sent.push(email);
            },
          },
        }),
    baseUrl: BASE,
    counts: memoryQuotaStore(),
    now: () => clock.now,
  };
  return { deps, sent, lines, clock };
}

const KINDS = Object.keys(ALERT_KINDS) as AlertKind[];

describe("alerts (task 3.1.10)", () => {
  it("covers exactly the five events the task names", () => {
    expect(KINDS.sort()).toEqual(["circuit_open", "definition_changed", "policy_denied", "quota_exceeded", "sandbox_fault"]);
  });

  it.each(KINDS)("fires for a run that ended on %s: a log line and an email", async (kind) => {
    const { deps, sent, lines } = setup();
    const inner = memoryMetricsSink();
    await alertingSink(inner, deps).export(metric(kind, { runId: "run-7", project: "work" }));
    expect(lines).toEqual([{ event: ALERT_EVENT, kind, runId: "run-7", project: "work", email: "sent" }]);
    expect(sent).toEqual([alertEmail(kind, BASE)]);
    // The metric itself still goes where it went before.
    expect(inner.metrics.map((entry) => entry.errorCode)).toEqual([kind]);
  });

  it("raises nothing for a run that completed, or that ended on any other code", async () => {
    const others = (Object.keys(ERROR_CODES) as ErrorCode[]).filter((code) => !KINDS.includes(code as AlertKind));
    expect(others.length).toBeGreaterThan(0);
    const { deps, sent, lines } = setup();
    const sink = alertingSink(memoryMetricsSink(), deps);
    await sink.export(metric());
    for (const code of others) await sink.export(metric(code));
    expect(lines).toEqual([]);
    expect(sent).toEqual([]);
    expect(alertFor(metric())).toBeUndefined();
    // A name every object has is not an alert kind.
    expect(alertFor({ errorCode: "toString" as ErrorCode, runId: "r", project: "p" })).toBeUndefined();
  });

  it("says only the kind of event in an email: no project, no run, no error text", () => {
    for (const kind of KINDS) {
      const email = alertEmail(kind, BASE);
      expect(email.subject).toBe(ALERT_SUBJECT);
      expect(email.body).toContain(ALERT_KINDS[kind]);
      expect(email.body).toContain("https://console.example.com/console");
    }
    expect(() => alertEmail("policy_denied", "http://console.example.com")).toThrow("https");
  });

  it("keeps the project and run out of the email even when they are sent in the alert", async () => {
    const { deps, sent } = setup();
    await raiseAlert({ kind: "policy_denied", runId: "run-SECRET-RUN", project: "client-acme-payroll" }, deps);
    expect(JSON.stringify(sent)).not.toContain("SECRET-RUN");
    expect(JSON.stringify(sent)).not.toContain("acme");
  });

  it("sends one email an hour for each kind, and logs every alert", async () => {
    const { deps, sent, lines, clock } = setup();
    const raise = (kind: AlertKind) => raiseAlert({ kind, runId: "r", project: "p" }, deps);
    expect((await raise("policy_denied")).email).toBe("sent");
    expect((await raise("policy_denied")).email).toBe("held");
    expect((await raise("policy_denied")).email).toBe("held");
    // Another kind has its own count.
    expect((await raise("sandbox_fault")).email).toBe("sent");
    expect(sent.length).toBe(2);
    expect(lines.map((line) => line.email)).toEqual(["sent", "held", "held", "sent"]);
    // The next clock hour starts a new count.
    clock.now += HOUR;
    expect((await raise("policy_denied")).email).toBe("sent");
    expect(sent.length).toBe(3);
  });

  it("still logs the alert when email is not set up", async () => {
    const { deps, sent, lines } = setup({ mailer: "none" });
    expect((await raiseAlert({ kind: "circuit_open", runId: "r", project: "p" }, deps)).email).toBe("off");
    expect(lines).toEqual([{ event: ALERT_EVENT, kind: "circuit_open", runId: "r", project: "p", email: "off" }]);
    expect(sent).toEqual([]);
  });

  it("never throws: not when the mail fails, the count fails, the log fails or the metric sink fails", async () => {
    const broken = setup({ mailer: "broken" });
    expect((await raiseAlert({ kind: "quota_exceeded", runId: "r", project: "p" }, broken.deps)).email).toBe("failed");
    expect(broken.lines.map((line) => line.email)).toEqual(["failed"]);

    const { deps, sent } = setup();
    const noCount: AlertDeps = { ...deps, counts: { ...memoryQuotaStore(), add: async () => Promise.reject(new Error("the database is down")) } };
    expect((await raiseAlert({ kind: "quota_exceeded", runId: "r", project: "p" }, noCount)).email).toBe("failed");
    // An email that cannot be counted is not sent: an uncounted email could be one of thousands.
    expect(sent).toEqual([]);

    const noLog: AlertDeps = {
      ...deps,
      write: () => {
        throw new Error("the log is down");
      },
    };
    await expect(raiseAlert({ kind: "sandbox_fault", runId: "r", project: "p" }, noLog)).resolves.toMatchObject({ email: "sent" });

    const after = setup();
    const failingInner = { export: async () => Promise.reject(new Error("metrics are down")) };
    await expect(alertingSink(failingInner, after.deps).export(metric("policy_denied"))).resolves.toBeUndefined();
    // The metric was lost. The alert was not.
    expect(after.sent.length).toBe(1);
  });

  it("is built in production without email when the binding or the owner's address is missing", () => {
    const db = { prepare: () => ({}) };
    expect(productionAlerts({ LOADER: {}, DB: db }, () => 0).mailer).toBeUndefined();
    expect(productionAlerts({ LOADER: {}, DB: db, EMAIL: { send: async () => undefined } }, () => 0).mailer).toBeUndefined();
    const full = productionAlerts({ LOADER: {}, DB: db, EMAIL: { send: async () => undefined }, OWNER_EMAIL: "owner@example.com" }, () => 0);
    expect(full.mailer).toBeDefined();
    expect(full.baseUrl).toBe("https://console.execward.com");
  });
});
