/**
 * Sandbox id normalization — hand-written.
 *
 * The bridge validates every `{id}` path segment against
 * `^[a-z2-7]{1,128}$` (base32 lowercase — its own random ids are 16 bytes
 * base32-encoded). Callers addressing a sandbox by an arbitrary name must
 * map it into that alphabet first; this helper is the deterministic,
 * idempotent transform the wire demands:
 *
 *   - names already matching the charset pass through verbatim (so bridge-
 *     minted ids and prior outputs are stable),
 *   - anything else is encoded `s` + base32hex(utf8(name)) — injective,
 *     deterministic, and confined to the wire alphabet,
 *   - names whose encoding would exceed 127 characters are rejected
 *     (fail-fast beats a silently colliding truncation).
 *
 * Note the charset is the BRIDGE's rule, not the SDK's `getSandbox` one —
 * the SDK accepted 1-63 chars including hyphens and case (DNS rules), so
 * legacy names like `esbx-01J…` are exactly the ones this encodes.
 */
const WIRE_ID = /^[a-z2-7]{1,128}$/;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const base32 = (bytes: Uint8Array): string => {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];

  return out;
};

const text = new TextEncoder();

export const MAX_WIRE_ID_LENGTH = 128;

/** Whether `value` is a valid bridge sandbox id as-is. */
export const isWireSandboxId = (value: string): boolean => WIRE_ID.test(value);

/**
 * Deterministically map an arbitrary caller name to a bridge-valid sandbox
 * id. Returns `undefined` when the encoding cannot fit the 128-char wire
 * limit — callers surface that as a configuration error.
 */
export const toWireSandboxId = (name: string): string | undefined => {
  if (WIRE_ID.test(name)) return name;

  const encoded = `s${base32(text.encode(name))}`;

  return encoded.length <= MAX_WIRE_ID_LENGTH ? encoded : undefined;
};
