import { expect, test } from "vitest";
import {
  CALL_LIMITS,
  CIRCUIT_BREAKER,
  PLATFORM_CEILINGS,
  PROJECT_QUOTAS,
  RUN_LIMITS,
  SCRIPT_LIMITS,
  SPEND_CAPS,
} from "../src/limits";

test("run limits stay inside what the platform allows", () => {
  expect(RUN_LIMITS.cpuMs).toBeLessThanOrEqual(PLATFORM_CEILINGS.cpuMs);
  expect(RUN_LIMITS.cpuMs).toBeLessThan(RUN_LIMITS.wallClockMs);
  expect(PROJECT_QUOTAS.concurrentRuns).toBeLessThanOrEqual(
    PLATFORM_CEILINGS.concurrentDynamicWorkers,
  );
});

test("the daily run quota cannot spend more than the daily cap", () => {
  const worstCaseDay = PROJECT_QUOTAS.runsPerDay * SPEND_CAPS.usdPerRun;
  expect(worstCaseDay).toBeLessThanOrEqual(SPEND_CAPS.usdPerDay);
});

test("the per-minute quota cannot outrun the daily quota's intent", () => {
  // A full day at the per-minute rate would be far above the daily quota, so the
  // daily quota must be the smaller, binding number.
  expect(PROJECT_QUOTAS.runsPerDay).toBeLessThan(PROJECT_QUOTAS.runsPerMinute * 60 * 24);
  expect(PROJECT_QUOTAS.upstreamCallsPerDay).toBeLessThanOrEqual(
    PROJECT_QUOTAS.runsPerDay * RUN_LIMITS.maxHostCalls,
  );
});

test("a script or result that fits its cap also fits in memory many times over", () => {
  const biggest = Math.max(
    SCRIPT_LIMITS.maxScriptBytes,
    RUN_LIMITS.maxResultBytes,
    CALL_LIMITS.maxToolResultBytes,
  );
  expect(biggest * 10).toBeLessThan(PLATFORM_CEILINGS.memoryBytes);
});

test("an argument is flagged as large before a result is rejected as too large", () => {
  expect(CALL_LIMITS.largeArgumentBytes).toBeLessThan(CALL_LIMITS.maxToolResultBytes);
});

test("every limit is a positive whole number, except prices", () => {
  const groups = [RUN_LIMITS, SCRIPT_LIMITS, CALL_LIMITS, PROJECT_QUOTAS, CIRCUIT_BREAKER, PLATFORM_CEILINGS];
  for (const group of groups) {
    for (const [name, value] of Object.entries(group)) {
      expect(Number.isInteger(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
  }
});
