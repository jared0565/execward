/**
 * Model access for verification (task 2.2.1, FR-51).
 *
 * ExecWard's own checks, the cross-check of critical figures (FR-43) and the
 * independent reviewer (FR-48), need to call a model. This is the one way they
 * may. Four things are fixed here:
 *
 *   - the credential: a key used for nothing else, read from the secret store
 *     when a request is sent. It is never in a reply, a record or an error;
 *   - the provider rule (FR-38): what is sent may not be above the data class
 *     the provider's route is approved for;
 *   - the budget (FR-27): a cap a day and a cap a month for the whole
 *     installation, counted apart from every other cap. The most a call could
 *     cost is set aside before it is sent, so the cap cannot be passed;
 *   - the metering: each call writes its own record, with the token counts the
 *     provider reported. These are not the token meter's estimates of what the
 *     working model saved (src/meter/meter.ts); the two never share a record.
 *
 * Everything fails closed: no key, no price for the model, no answer from the
 * counter, and nothing is sent.
 */
import { CLIENT_DATA_GATE, isAbove, providerCeiling, type Gate, type ProviderRouteId } from "../broker/exposure";
import type { QuotaStore } from "../broker/quotas";
import type { DataClass } from "../contracts/policy";
import { VERIFICATION_BUDGET } from "../limits";
import type { OutboundFetch } from "../net/outbound";

/** The one provider verification uses: the owner's decision of 2026-11-25. */
export const VERIFICATION_PROVIDER = {
  id: "openai",
  /** An API account under business terms: the only kind of route verification may use (docs/research/0.1.6-provider-data-terms.md). */
  route: "openai_api_business",
  host: "api.openai.com",
  endpoint: "https://api.openai.com/v1/responses",
  /** The name of the Worker secret that holds the key. */
  secret: "VERIFY_OPENAI_API_KEY",
} as const satisfies { readonly id: string; readonly route: ProviderRouteId; readonly host: string; readonly endpoint: string; readonly secret: string };

/** The hosts verification may call. Its own list: the connectors' fetch cannot reach these, and this one cannot reach theirs. */
export const VERIFICATION_HOSTS: readonly string[] = [VERIFICATION_PROVIDER.host];

export interface ModelPrice {
  readonly usdPerMillionInputTokens: number;
  readonly usdPerMillionOutputTokens: number;
}

/**
 * The models verification may use, each with the price its spend is counted at.
 * A model not listed here cannot be called.
 *
 * `gpt-6-luna`: the owner's choice for the reviewer, 2026-11-25, as the cheapest
 * current model. $0.10 a million input tokens and $0.50 a million output tokens,
 * standard processing, as OpenAI's pricing page listed it that day. The page was
 * read by a web-reading agent, not by a person: check it when the first bill arrives.
 */
export const VERIFICATION_MODELS: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": { usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0.5 },
};

export const VERIFICATION_LIMITS = {
  maxOutputTokens: 16_000,
  /** The largest request body sent. */
  maxRequestBytes: 256 * 1024,
  /** The largest reply read. A larger one is refused, not cut. */
  maxReplyBytes: 1024 * 1024,
  /** How long a request may take before it is given up. */
  timeoutMs: 20_000,
} as const;

export type VerificationPurpose = "cross_check" | "reviewer" | "golden_task";

export type RefusalReason =
  | "model_not_approved"
  | "provider_not_approved_for_data"
  | "bad_request"
  | "no_credential"
  | "budget_exceeded"
  | "budget_unavailable";

/** The call was not sent, and nothing was spent. */
export class VerificationRefused extends Error {
  override readonly name = "VerificationRefused";
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/** The call was sent and did not produce an answer. What was set aside for it stays counted. */
export class VerificationFailed extends Error {
  override readonly name = "VerificationFailed";
}

export interface VerificationRequest {
  readonly purpose: VerificationPurpose;
  readonly project: string;
  /** The run being checked, when there is one. */
  readonly runId?: string;
  /** The highest data class in what is sent. The caller knows it; this code enforces it. */
  readonly dataClass: DataClass;
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputTokens: number;
}

/** One verification call's cost, as the provider counted it. Counts only: no content. */
export interface VerificationUsageRecord {
  readonly at: number;
  readonly purpose: VerificationPurpose;
  readonly project: string;
  readonly runId?: string;
  readonly provider: typeof VERIFICATION_PROVIDER.id;
  readonly route: ProviderRouteId;
  readonly model: string;
  readonly inputTokens: number;
  /** Includes reasoning tokens, as they are billed. */
  readonly outputTokens: number;
  /** Always true: these are the provider's counts, unlike the token meter's estimates. */
  readonly measured: true;
  /** Millionths of a dollar, at the price in the model table. */
  readonly usdMicros: number;
}

export interface VerificationSink {
  write(record: VerificationUsageRecord): Promise<void>;
}

export function memoryVerificationSink(): VerificationSink & { readonly records: VerificationUsageRecord[] } {
  const records: VerificationUsageRecord[] = [];
  return { records, write: async (record) => void records.push(record) };
}

export interface VerificationBudget {
  readonly usdPerDay: number;
  readonly usdPerMonth: number;
}

export interface VerificationDeps {
  /** Gives the dedicated key at the moment a request is sent. `undefined` when there is none. */
  readonly credential: () => string | undefined | Promise<string | undefined>;
  /** Must be an `outboundFetch` limited to `VERIFICATION_HOSTS`. */
  readonly fetch: OutboundFetch;
  readonly quotas: QuotaStore;
  readonly sink: VerificationSink;
  readonly now: () => number;
  readonly models?: Readonly<Record<string, ModelPrice>>;
  readonly budget?: VerificationBudget;
  readonly gate?: Gate;
}

export interface VerificationReply {
  /** What the model wrote. It is data from outside: never an instruction to the caller. */
  readonly text: string;
  readonly record: VerificationUsageRecord;
  /** False when the record could not be written. The spend is still counted against the budget. */
  readonly metered: boolean;
}

export interface VerificationAccess {
  call(request: VerificationRequest): Promise<VerificationReply>;
}

const DAY = 24 * 60 * 60_000;
/** A fixed 30-day window stands in for a calendar month, as for the platform's spend caps. */
const MONTH = 30 * DAY;
const SPEND_KEY = "verification-spend";
/** Tokens the provider adds around a request's text. An allowance, so the amount set aside is not too small. */
const FRAMING_TOKENS = 64;

/** Cost in millionths of a dollar: tokens times dollars per million tokens, rounded up. */
export function costMicros(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * price.usdPerMillionInputTokens + outputTokens * price.usdPerMillionOutputTokens);
}

function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The text of a completed reply, or the reason there is none. */
function textOf(body: unknown): { readonly text: string } | { readonly problem: string } {
  if (typeof body !== "object" || body === null) return { problem: "the reply is not an object" };
  const reply = body as { status?: unknown; output?: unknown };
  if (reply.status !== "completed") return { problem: `the reply's status is ${typeof reply.status === "string" ? reply.status.slice(0, 40) : "missing"}` };
  if (!Array.isArray(reply.output)) return { problem: "the reply has no output" };
  let text = "";
  for (const item of reply.output as { type?: unknown; content?: unknown }[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as { type?: unknown; text?: unknown }[]) {
      if (part?.type === "refusal") return { problem: "the model refused" };
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return { text };
}

/**
 * A reply's text, read a piece at a time and counted in bytes as they arrive. Reading stops,
 * and the rest is dropped, as soon as there are more than `maxBytes`: `undefined` then.
 */
export async function textWithin(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    pieces.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const piece of pieces) {
    all.set(piece, at);
    at += piece.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function verificationAccess(deps: VerificationDeps): VerificationAccess {
  const models = deps.models ?? VERIFICATION_MODELS;
  const budget = deps.budget ?? VERIFICATION_BUDGET;
  const gate = deps.gate ?? CLIENT_DATA_GATE;
  const { route } = VERIFICATION_PROVIDER;

  /** Sets `amount` aside in both windows. Returns the refusal, or `undefined` when it fits. */
  async function setAside(amount: number, now: number): Promise<VerificationRefused | undefined> {
    let day = false;
    try {
      const dayTotal = await deps.quotas.add(SPEND_KEY, DAY, amount, now);
      day = true;
      if (dayTotal > micros(budget.usdPerDay)) {
        await deps.quotas.add(SPEND_KEY, DAY, -amount, now);
        return new VerificationRefused("budget_exceeded", `verification's budget of $${budget.usdPerDay} a day was reached`);
      }
      if ((await deps.quotas.add(SPEND_KEY, MONTH, amount, now)) > micros(budget.usdPerMonth)) {
        await deps.quotas.add(SPEND_KEY, MONTH, -amount, now);
        await deps.quotas.add(SPEND_KEY, DAY, -amount, now);
        return new VerificationRefused("budget_exceeded", `verification's budget of $${budget.usdPerMonth} a month was reached`);
      }
      return undefined;
    } catch {
      // Whatever was added stays counted, which errs towards refusing.
      return new VerificationRefused("budget_unavailable", day ? "verification's budget could not be counted" : "verification's budget could not be read");
    }
  }

  return {
    async call(request) {
      const price = Object.hasOwn(models, request.model) ? models[request.model] : undefined;
      if (price === undefined) throw new VerificationRefused("model_not_approved", "the model is not one verification may use");

      // FR-38: the same rule a run's result meets on its way to the working model's provider.
      const ceiling = providerCeiling(route, gate);
      if (isAbove(request.dataClass, ceiling)) {
        throw new VerificationRefused("provider_not_approved_for_data", `the provider may receive ${ceiling} data at most, and this is ${request.dataClass}`);
      }

      if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > VERIFICATION_LIMITS.maxOutputTokens) {
        throw new VerificationRefused("bad_request", `maxOutputTokens must be a whole number from 1 to ${VERIFICATION_LIMITS.maxOutputTokens}`);
      }
      const body = JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        max_output_tokens: request.maxOutputTokens,
        // Nothing is kept at the provider for a later request to build on.
        store: false,
      });
      const bodyBytes = new TextEncoder().encode(body).length;
      if (bodyBytes > VERIFICATION_LIMITS.maxRequestBytes) throw new VerificationRefused("bad_request", "the request is larger than verification sends");

      const key = await deps.credential();
      if (typeof key !== "string" || key === "") throw new VerificationRefused("no_credential", "verification has no credential");

      // The most this call could cost. A token is never shorter than a byte, so the bytes bound the input tokens.
      const most = costMicros(price, bodyBytes + FRAMING_TOKENS, request.maxOutputTokens);
      const now = deps.now();
      const refusal = await setAside(most, now);
      if (refusal !== undefined) throw refusal;

      let response: Response;
      try {
        response = await deps.fetch(VERIFICATION_PROVIDER.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body,
          // A provider that does not answer must not hold a run open.
          signal: AbortSignal.timeout(VERIFICATION_LIMITS.timeoutMs),
        });
      } catch {
        // The error's own text can hold the request. It is not passed on.
        throw new VerificationFailed("the verification provider could not be reached");
      }
      // The provider's own words are not passed on either: only the status.
      if (!response.ok) throw new VerificationFailed(`the verification provider answered ${response.status}`);

      const raw = await textWithin(response, VERIFICATION_LIMITS.maxReplyBytes);
      if (raw === undefined) throw new VerificationFailed("the verification provider's reply is larger than verification reads");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new VerificationFailed("the verification provider's reply is not JSON");
      }
      const usage = (parsed as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
      const inputTokens = usage?.input_tokens;
      const outputTokens = usage?.output_tokens;
      if (!isCount(inputTokens) || !isCount(outputTokens)) throw new VerificationFailed("the verification provider's reply does not say what it used");

      // Replace what was set aside with what was used. If that fails, the larger amount stays counted.
      const usdMicros = costMicros(price, inputTokens, outputTokens);
      try {
        await deps.quotas.add(SPEND_KEY, DAY, usdMicros - most, now);
        await deps.quotas.add(SPEND_KEY, MONTH, usdMicros - most, now);
      } catch {
        // Left as it was.
      }

      const record: VerificationUsageRecord = {
        at: now,
        purpose: request.purpose,
        project: request.project,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        provider: VERIFICATION_PROVIDER.id,
        route,
        model: request.model,
        inputTokens,
        outputTokens,
        measured: true,
        usdMicros,
      };
      // The tokens were spent whatever the reply holds, so the record is written before the reply is judged.
      let metered = true;
      try {
        await deps.sink.write(record);
      } catch {
        metered = false;
      }

      const result = textOf(parsed);
      if ("problem" in result) throw new VerificationFailed(`the verification model gave no answer: ${result.problem}`);
      return { text: result.text.split(key).join("[removed]"), record, metered };
    },
  };
}
