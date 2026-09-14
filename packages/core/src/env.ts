/**
 * Runtime-portable environment probe. Generated SDKs must typecheck and run
 * in contexts without Node types (publish builds use `types: []`, and
 * consumers include browsers and edge workers), so `process.env` is read
 * through `globalThis` instead of the Node-typed global.
 */

interface EnvProcess {
  readonly env?: Record<string, string | undefined>;
}

const env = (): Record<string, string | undefined> | undefined =>
  (globalThis as { process?: EnvProcess }).process?.env;

/** `DISTILLED_DEBUG_HTTP` set — log request/response lines to stderr. */
export const debugHttp = (): boolean => {
  const value = env()?.DISTILLED_DEBUG_HTTP;
  return value !== undefined && value !== "" && value !== "0";
};
