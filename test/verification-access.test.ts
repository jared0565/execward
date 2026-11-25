import { describe, expect, it } from "vitest";
import { memoryQuotaStore, type QuotaStore } from "../src/broker/quotas";
import { VERIFICATION_BUDGET } from "../src/limits";
import { memoryMeterSink } from "../src/meter/meter";
import { ALLOWED_OUTBOUND_HOSTS, outboundFetch } from "../src/net/outbound";
import {
  costMicros,
  memoryVerificationSink,
  verificationAccess,
  VERIFICATION_HOSTS,
  VERIFICATION_MODELS,
  VERIFICATION_PROVIDER,
  VerificationFailed,
  VerificationRefused,
  type ModelPrice,
  type VerificationDeps,
  type VerificationRequest,
} from "../src/verify/model-access";
import { ALLOWED_SECRETS } from "../src/worker/bindings";

// A made-up key and a made-up model with a made-up price: nothing here is real.
const KEY = "fake-verification-key-000";
const MODEL = "test-model";
const PRICE: ModelPrice = { usdPerMillionInputTokens: 2, usdPerMillionOutputTokens: 8 };
const DAY = 24 * 60 * 60_000;

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function reply(text: string, inputTokens = 100, outputTokens = 20): unknown {
  return {
    status: "completed",
    output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function setup(options: { readonly respond?: () => Response; readonly quotas?: QuotaStore; readonly credential?: string | undefined; readonly budget?: VerificationDeps["budget"]; readonly cleared?: boolean } = {}) {
  const sent: Sent[] = [];
  const sink = memoryVerificationSink();
  const quotas = options.quotas ?? memoryQuotaStore();
  let now = 10 * DAY;
  const inner = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return options.respond ? options.respond() : Response.json(reply("agreed"));
  }) as typeof fetch;
  const access = verificationAccess({
    credential: () => ("credential" in options ? options.credential : KEY),
    fetch: outboundFetch(VERIFICATION_HOSTS, inner),
    quotas,
    sink,
    now: () => now,
    models: { [MODEL]: PRICE },
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.cleared === undefined ? {} : { gate: { cleared: options.cleared } }),
  });
  return { access, sent, sink, quotas, advance: (ms: number) => void (now += ms), now: () => now };
}

const REQUEST: VerificationRequest = {
  purpose: "cross_check",
  project: "acme",
  runId: "run-1",
  dataClass: "internal",
  model: MODEL,
  instructions: "Recompute the total.",
  input: "rows: 1, 2, 3",
  maxOutputTokens: 500,
};

async function refusal(work: Promise<unknown>): Promise<VerificationRefused> {
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(VerificationRefused);
  return error as VerificationRefused;
}

/** What is counted against the day's budget now, read by adding nothing. */
async function spentToday(quotas: QuotaStore, now: number): Promise<number> {
  return quotas.add("verification-spend", DAY, 0, now);
}

describe("verification's model access (task 2.2.1, FR-51)", () => {
  it("sends one request to the provider with the dedicated key and returns the answer", async () => {
    const { access, sent } = setup();
    const result = await access.call(REQUEST);
    expect(result.text).toBe("agreed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(VERIFICATION_PROVIDER.endpoint);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.body).toEqual({ model: MODEL, instructions: REQUEST.instructions, input: REQUEST.input, max_output_tokens: 500, store: false });
  });

  it("meters each call in its own record, with the provider's counts, apart from the token meter", async () => {
    const { access, sink, now } = setup();
    const workingModelMeter = memoryMeterSink();
    const result = await access.call(REQUEST);
    expect(sink.records).toEqual([
      { at: now(), purpose: "cross_check", project: "acme", runId: "run-1", provider: "openai", route: "openai_api_business", model: MODEL, inputTokens: 100, outputTokens: 20, measured: true, usdMicros: 100 * 2 + 20 * 8 },
    ]);
    expect(result.record).toEqual(sink.records[0]);
    expect(result.metered).toBe(true);
    // Nothing of it reaches the working model's meter.
    expect(workingModelMeter.records).toEqual([]);
  });

  it("still returns the answer when the record cannot be written, and says so", async () => {
    const { access, sink } = setup();
    sink.write = async () => {
      throw new Error("sink down");
    };
    const result = await access.call(REQUEST);
    expect(result.text).toBe("agreed");
    expect(result.metered).toBe(false);
  });

  it("uses a key that is on the Worker's secret allowlist and is not any other credential", () => {
    expect(ALLOWED_SECRETS).toContain(VERIFICATION_PROVIDER.secret);
    expect(ALLOWED_SECRETS.filter((name) => name === VERIFICATION_PROVIDER.secret)).toHaveLength(1);
  });

  it("has its own reach: the connectors' fetch cannot call the provider, and this one cannot call theirs", async () => {
    expect(VERIFICATION_HOSTS).toEqual([new URL(VERIFICATION_PROVIDER.endpoint).hostname]);
    for (const host of VERIFICATION_HOSTS) expect(ALLOWED_OUTBOUND_HOSTS).not.toContain(host);
    const never = (async () => {
      throw new Error("sent");
    }) as unknown as typeof fetch;
    await expect(outboundFetch(ALLOWED_OUTBOUND_HOSTS, never)(VERIFICATION_PROVIDER.endpoint)).rejects.toThrow("not sent");
    await expect(outboundFetch(VERIFICATION_HOSTS, never)("https://api.github.com/")).rejects.toThrow("not sent");
  });

  it("approves one model, at the price the owner was shown, and refuses any other", async () => {
    // $0.10 a million input tokens and $0.50 a million output tokens: the owner's choice of 2026-11-25.
    expect(VERIFICATION_MODELS).toEqual({ "gpt-6-luna": { usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0.5 } });
    const sent: unknown[] = [];
    const access = verificationAccess({
      credential: () => KEY,
      fetch: async (url) => {
        sent.push(url);
        return Response.json(reply("x"));
      },
      quotas: memoryQuotaStore(),
      sink: memoryVerificationSink(),
      now: () => 0,
    });
    expect((await refusal(access.call(REQUEST))).reason).toBe("model_not_approved");
    expect(sent).toEqual([]);
  });

  it("refuses a model that has no price, even one named like an object's own members", async () => {
    const { access, sent } = setup();
    for (const model of ["other-model", "constructor", "__proto__", "toString"]) {
      expect((await refusal(access.call({ ...REQUEST, model }))).reason).toBe("model_not_approved");
    }
    expect(sent).toEqual([]);
  });

  it("follows the provider rule: confidential data may go, client personal data may not while the gate is uncleared", async () => {
    const { access, sent } = setup();
    await access.call({ ...REQUEST, dataClass: "confidential" });
    expect(sent).toHaveLength(1);
    const error = await refusal(access.call({ ...REQUEST, dataClass: "client_personal" }));
    expect(error.reason).toBe("provider_not_approved_for_data");
    expect(sent).toHaveLength(1);
  });

  it("lets client personal data go once the gate is cleared", async () => {
    const { access, sent } = setup({ cleared: true });
    await access.call({ ...REQUEST, dataClass: "client_personal" });
    expect(sent).toHaveLength(1);
  });

  it("refuses without a credential, and sets nothing aside", async () => {
    for (const credential of [undefined, ""]) {
      const { access, sent, quotas, now } = setup({ credential });
      expect((await refusal(access.call(REQUEST))).reason).toBe("no_credential");
      expect(sent).toEqual([]);
      expect(await spentToday(quotas, now())).toBe(0);
    }
  });

  it("refuses an output limit that is not a whole number in range", async () => {
    const { access, sent } = setup();
    for (const maxOutputTokens of [0, -1, 1.5, 16_001, Number.NaN]) {
      expect((await refusal(access.call({ ...REQUEST, maxOutputTokens }))).reason).toBe("bad_request");
    }
    expect(sent).toEqual([]);
  });

  it("refuses a request larger than it sends", async () => {
    const { access, sent } = setup();
    expect((await refusal(access.call({ ...REQUEST, input: "x".repeat(300 * 1024) }))).reason).toBe("bad_request");
    expect(sent).toEqual([]);
  });

  it("counts what the call used, not the larger amount set aside for it", async () => {
    const { access, quotas, now } = setup();
    await access.call(REQUEST);
    expect(await spentToday(quotas, now())).toBe(costMicros(PRICE, 100, 20));
  });

  it("stops at the daily budget without sending, and takes the refused amount off again", async () => {
    // Room for the amount one call sets aside, and not for two.
    const { access, sent, quotas, now } = setup({ budget: { usdPerDay: 0.006, usdPerMonth: 10 }, respond: () => Response.json(reply("ok", 300, 500)) });
    await access.call(REQUEST);
    const afterOne = await spentToday(quotas, now());
    expect(afterOne).toBe(costMicros(PRICE, 300, 500));
    const error = await refusal(access.call(REQUEST));
    expect(error.reason).toBe("budget_exceeded");
    expect(error.message).toContain("a day");
    expect(sent).toHaveLength(1);
    expect(await spentToday(quotas, now())).toBe(afterOne);
  });

  it("opens again the next day", async () => {
    const { access, sent, advance } = setup({ budget: { usdPerDay: 0.006, usdPerMonth: 10 }, respond: () => Response.json(reply("ok", 300, 500)) });
    await access.call(REQUEST);
    await refusal(access.call(REQUEST));
    advance(DAY);
    await access.call(REQUEST);
    expect(sent).toHaveLength(2);
  });

  it("stops at the monthly budget even when each day is under its own", async () => {
    const { access, sent, advance } = setup({ budget: { usdPerDay: 1, usdPerMonth: 0.012 }, respond: () => Response.json(reply("ok", 300, 500)) });
    await access.call(REQUEST);
    advance(DAY);
    await access.call(REQUEST);
    advance(DAY);
    const error = await refusal(access.call(REQUEST));
    expect(error.reason).toBe("budget_exceeded");
    expect(error.message).toContain("a month");
    expect(sent).toHaveLength(2);
  });

  it("refuses when the budget cannot be counted", async () => {
    const broken: QuotaStore = {
      add: async () => {
        throw new Error("database down");
      },
      acquire: async () => false,
      release: async () => undefined,
    };
    const { access, sent } = setup({ quotas: broken });
    expect((await refusal(access.call(REQUEST))).reason).toBe("budget_unavailable");
    expect(sent).toEqual([]);
  });

  it("uses the owner's budget when none is given: $1 a day and $10 a month", () => {
    expect(VERIFICATION_BUDGET).toEqual({ usdPerDay: 1, usdPerMonth: 10 });
  });

  it("keeps the amount set aside when the provider fails, and passes on its status only", async () => {
    const { access, quotas, now, sink } = setup({ respond: () => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 }) });
    const error = await access.call(REQUEST).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(VerificationFailed);
    expect((error as Error).message).toBe("the verification provider answered 401");
    expect(await spentToday(quotas, now())).toBeGreaterThan(costMicros(PRICE, 100, 20));
    expect(sink.records).toEqual([]);
  });

  it("fails when the reply does not say what it used", async () => {
    const { access } = setup({ respond: () => Response.json({ status: "completed", output: [] }) });
    await expect(access.call(REQUEST)).rejects.toBeInstanceOf(VerificationFailed);
  });

  it("meters a reply that was cut short or refused, and then fails", async () => {
    for (const body of [
      { status: "incomplete", output: [], usage: { input_tokens: 100, output_tokens: 500 } },
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 100, output_tokens: 5 } },
    ]) {
      const { access, sink } = setup({ respond: () => Response.json(body) });
      await expect(access.call(REQUEST)).rejects.toBeInstanceOf(VerificationFailed);
      expect(sink.records).toHaveLength(1);
    }
  });

  it("never lets the key into a reply, a record or an error", async () => {
    const { access, sink } = setup({ respond: () => Response.json(reply(`the key is ${KEY}`)) });
    const result = await access.call(REQUEST);
    expect(result.text).toBe("the key is [removed]");
    expect(JSON.stringify(sink.records)).not.toContain(KEY);

    const unreachable = verificationAccess({
      credential: () => KEY,
      fetch: async () => {
        throw new Error(`could not send Bearer ${KEY}`);
      },
      quotas: memoryQuotaStore(),
      sink: memoryVerificationSink(),
      now: () => 0,
      models: { [MODEL]: PRICE },
    });
    const error = await unreachable.call(REQUEST).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(VerificationFailed);
    expect(String((error as Error).message)).not.toContain(KEY);
  });
});
