/**
 * Version of the five interface contracts (task 0.1.4). Bump the major number for
 * any change that could break a client, a script or a stored policy record.
 */
export const CONTRACT_VERSION = "1.2.0";

/**
 * 1.1.0 (task 1.2.3): the Sandbox API names the language built-ins a script
 * may reference. Nothing a 1.0.0 script could rely on was removed.
 *
 * 1.2.0 (task 1.2.4): the `code` tool's output may carry `logs`, the captured
 * `console.log` output the Sandbox API always promised. Optional, so a 1.1.0
 * client still reads every reply.
 */
