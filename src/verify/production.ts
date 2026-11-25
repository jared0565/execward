/**
 * The reviewer as production builds it (tasks 2.2.3 and 2.2.4): on
 * verification's own key, host list and budget, with its usage on its own log
 * line, and switched off while the daily check says it is failing.
 *
 * Built in one place because two parts of the Worker use it: the run path,
 * and the daily check on the timer. They must be the same reviewer.
 */
import type { QuotaStore } from "../broker/quotas";
import { outboundFetch } from "../net/outbound";
import { quotaGoldenStore, reviewerIsOff, type GoldenStore } from "./golden";
import { verificationAccess, VERIFICATION_HOSTS, type VerificationSink } from "./model-access";
import { reviewer, type Reviewer } from "./reviewer";

/** Each verification call's measured usage, as its own line in the platform's log: never mixed into the meter's (FR-51). */
export const logVerificationSink: VerificationSink = {
  async write(record) {
    console.log({ event: "execward_verification", ...record });
  },
};

export interface ProductionReviewer {
  /** For the run path: gives no verdict while the daily check has it switched off. */
  readonly forRuns: Reviewer;
  /** For the daily check: always asks the model, so a reviewer that is off can show it has recovered. */
  readonly forTheCheck: Reviewer;
  readonly golden: GoldenStore;
}

export function productionReviewer(deps: { readonly key: () => string | undefined; readonly quotas: QuotaStore; readonly now: () => number; readonly sink?: VerificationSink; readonly fetch?: typeof fetch }): ProductionReviewer {
  const access = verificationAccess({
    credential: deps.key,
    fetch: outboundFetch(VERIFICATION_HOSTS, deps.fetch),
    quotas: deps.quotas,
    sink: deps.sink ?? logVerificationSink,
    now: deps.now,
  });
  const forTheCheck = reviewer({ access });
  const golden = quotaGoldenStore(deps.quotas);
  return {
    forTheCheck,
    golden,
    forRuns: {
      async review(input) {
        if (await reviewerIsOff(golden, deps.now())) return { outcome: "unreviewed", reason: "reviewer_off" };
        return forTheCheck.review(input);
      },
    },
  };
}
