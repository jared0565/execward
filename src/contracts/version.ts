/**
 * Version of the five interface contracts (task 0.1.4). Bump the major number for
 * any change that could break a client, a script or a stored policy record.
 */
export const CONTRACT_VERSION = "1.8.0";

/**
 * 1.1.0 (task 1.2.3): the Sandbox API names the language built-ins a script
 * may reference. Nothing a 1.0.0 script could rely on was removed.
 *
 * 1.2.0 (task 1.2.4): the `code` tool's output may carry `logs`, the captured
 * `console.log` output the Sandbox API always promised. Optional, so a 1.1.0
 * client still reads every reply.
 *
 * 1.3.0 (task 1.3.3): a policy record may carry `pathAllowlist`. Optional, so
 * every stored 1.2.0 record is still valid, and absent means no path is allowed.
 *
 * 1.4.0 (task 1.3.6): completed and error replies may carry `untrusted`,
 * `dataClass` and `masked`. Optional, so a 1.3.0 client still reads every reply.
 *
 * 1.5.0 (task 1.7.4): the run report may carry `criteria`. Optional, so a
 * 1.4.0 client still reads every report. `verification` keeps its four values;
 * `unreviewed` and `failed` are now actually used.
 *
 * 1.6.0 (task 2.1.4): every reply may carry `notices`, plain lines from the
 * server about the call itself. Optional, so a 1.5.0 client still reads every reply.
 *
 * 1.7.0 (task 2.2.2): the Sandbox API gains `critical()`, and the run report may
 * carry `crossChecks`. Both are additions: a 1.6.0 script runs as before, and a
 * 1.6.0 client still reads every report. The `paused` reply, in the contract
 * since 1.0.0, is now actually sent: when a critical figure disagrees.
 *
 * 1.8.0 (task 2.2.3): a new error code, `review_blocked`, and the report's
 * `verification` value `passed` is now actually used. A 1.7.0 client that
 * checks error codes against a fixed list must learn the new one.
 */
