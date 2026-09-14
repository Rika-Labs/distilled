/**
 * Schema-driven protobuf wire codec — shared by `application/grpc`
 * protocol layers (e.g. modal's binary control plane).
 *
 * Generated member schemas carry `T.ProtoField` annotations (the
 * `com.distilled.proto#field` trait emitted by `core/codegen/proto`) that
 * describe each member's field number and wire kind. This module walks the
 * Effect Schema AST — using the same `getProps`/`resolveNode` helpers as
 * `core/protocol-http` — and produces/consumes proto3 binary accordingly.
 * Members without a `ProtoField` annotation are ignored in both directions.
 *
 * Value conventions mirror proto3 JSON — which is what the generated TS
 * types describe: 64-bit ints are decimal strings, `bytes` are base64
 * strings, enums are their wire-name strings, `Timestamp`/`Duration`/
 * `FieldMask` are strings, wrapper types are scalars, `Struct`/`Value`/
 * `ListValue` are plain JSON, and `Any` is `{ typeUrl?, value? }` with
 * base64 `value`.
 *
 * Decode is forward-compatible: unknown field numbers and unexpected wire
 * types are skipped per the protobuf spec, and absent fields are omitted
 * from the output object (proto3 implicit presence).
 */
import * as Encoding from "effect/Encoding";
import type * as AST from "effect/SchemaAST";
import { getPropAnn, getProps, resolveNode } from "./protocol-http.ts";
import { protoFieldSymbol, type ProtoFieldDesc } from "./trait.ts";

/** Raised on malformed wire data or values that cannot be encoded. */
export class ProtoCodecError extends Error {
  readonly _tag = "ProtoCodecError";
  constructor(message: string) {
    super(message);
    this.name = "ProtoCodecError";
  }
}

// =============================================================================
// Reader / writer primitives
// =============================================================================

const te = new TextEncoder();
const td = new TextDecoder();

export const writeVarint = (out: number[], v: bigint): void => {
  let x = BigInt.asUintN(64, v);
  do {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    out.push(x > 0n ? b | 0x80 : b);
  } while (x > 0n);
};

const writeTag = (out: number[], n: number, wt: number): void => {
  writeVarint(out, BigInt((n << 3) | wt));
};

const writeLen = (out: number[], payload: Uint8Array): void => {
  writeVarint(out, BigInt(payload.length));
  for (const b of payload) out.push(b);
};

const scratch = new DataView(new ArrayBuffer(8));

export class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.end) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new ProtoCodecError("varint too long");
    }
    throw new ProtoCodecError("truncated varint");
  }
  u64(): bigint {
    if (this.pos + 8 > this.end) throw new ProtoCodecError("truncated u64");
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return dv.getBigUint64(0, true);
  }
  u32(): number {
    if (this.pos + 4 > this.end) throw new ProtoCodecError("truncated u32");
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return dv.getUint32(0, true);
  }
  f64(): number {
    if (this.pos + 8 > this.end) throw new ProtoCodecError("truncated f64");
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return dv.getFloat64(0, true);
  }
  f32(): number {
    if (this.pos + 4 > this.end) throw new ProtoCodecError("truncated f32");
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return dv.getFloat32(0, true);
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.end)
      throw new ProtoCodecError("truncated bytes");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  /** Skip one field of the given wire type (unknown-field tolerance). */
  skip(wt: number): void {
    switch (wt) {
      case 0:
        this.varint();
        return;
      case 1:
        this.u64();
        return;
      case 2: {
        const len = Number(this.varint());
        if (len < 0 || this.pos + len > this.end)
          throw new ProtoCodecError("truncated field");
        this.pos += len;
        return;
      }
      case 5:
        this.u32();
        return;
      default:
        throw new ProtoCodecError(`unsupported wire type ${wt}`);
    }
  }
}

// =============================================================================
// Scalar payload codecs (tag/length handled by callers)
// =============================================================================

const isPackable = (t: string): boolean =>
  t !== "string" &&
  t !== "bytes" &&
  t !== "message" &&
  t !== "map" &&
  t !== "wkt";

const wireTypeOf = (t: string): number => {
  switch (t) {
    case "double":
    case "fixed64":
    case "sfixed64":
      return 1;
    case "float":
    case "fixed32":
    case "sfixed32":
      return 5;
    case "string":
    case "bytes":
    case "message":
    case "map":
    case "wkt":
      return 2;
    default:
      return 0;
  }
};

const asBigInt = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v))
      throw new ProtoCodecError(`expected integer, got ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new ProtoCodecError(`expected integer value, got ${typeof v}`);
};

const writeScalarPayload = (
  out: number[],
  desc: ProtoFieldDesc,
  value: unknown,
  memberAst: AST.AST | undefined,
): void => {
  switch (desc.t) {
    case "double":
      scratch.setFloat64(0, Number(value), true);
      for (let i = 0; i < 8; i++) out.push(scratch.getUint8(i));
      return;
    case "float":
      scratch.setFloat32(0, Number(value), true);
      for (let i = 0; i < 4; i++) out.push(scratch.getUint8(i));
      return;
    case "fixed32":
      scratch.setUint32(0, Number(value) >>> 0, true);
      for (let i = 0; i < 4; i++) out.push(scratch.getUint8(i));
      return;
    case "sfixed32":
      scratch.setInt32(0, Number(value) | 0, true);
      for (let i = 0; i < 4; i++) out.push(scratch.getUint8(i));
      return;
    case "fixed64":
      scratch.setBigUint64(0, BigInt.asUintN(64, asBigInt(value)), true);
      for (let i = 0; i < 8; i++) out.push(scratch.getUint8(i));
      return;
    case "sfixed64":
      scratch.setBigInt64(0, BigInt.asIntN(64, asBigInt(value)), true);
      for (let i = 0; i < 8; i++) out.push(scratch.getUint8(i));
      return;
    case "int32":
    case "int64":
      // Negative values sign-extend to 64 bits per proto semantics.
      writeVarint(out, BigInt.asIntN(64, asBigInt(value)));
      return;
    case "uint32":
    case "uint64":
      writeVarint(out, BigInt.asUintN(64, asBigInt(value)));
      return;
    case "sint32": {
      const v = asBigInt(value);
      writeVarint(out, BigInt.asUintN(32, (v << 1n) ^ (v >> 31n)));
      return;
    }
    case "sint64": {
      const v = asBigInt(value);
      writeVarint(out, BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)));
      return;
    }
    case "bool":
      writeVarint(out, value ? 1n : 0n);
      return;
    case "enum": {
      writeVarint(out, enumToInt(desc, value));
      return;
    }
    case "string":
      writeLen(out, te.encode(String(value)));
      return;
    case "bytes": {
      if (value instanceof Uint8Array) {
        writeLen(out, value);
        return;
      }
      const decoded = Encoding.decodeBase64(String(value));
      if (decoded._tag !== "Success")
        throw new ProtoCodecError("invalid base64 in bytes field");
      writeLen(out, decoded.success);
      return;
    }
    case "message": {
      if (memberAst === undefined)
        throw new ProtoCodecError("message field lacks member schema");
      writeLen(out, encodeMessage(memberAst, value));
      return;
    }
    case "wkt":
      writeLen(out, encodeWkt(desc.w, value));
      return;
    default:
      throw new ProtoCodecError(`unsupported proto kind ${desc.t}`);
  }
};

const enumToInt = (desc: ProtoFieldDesc, value: unknown): bigint => {
  const table = desc.e ?? {};
  if (typeof value === "string") {
    const n = table[value];
    if (n !== undefined) return BigInt(n);
    if (/^-?\d+$/.test(value)) return BigInt(value);
    throw new ProtoCodecError(`unknown enum value ${JSON.stringify(value)}`);
  }
  if (typeof value === "number") return BigInt(value);
  throw new ProtoCodecError(`enum value must be a string, got ${typeof value}`);
};

const readScalarPayload = (
  r: Reader,
  desc: ProtoFieldDesc,
  memberAst: AST.AST | undefined,
): unknown => {
  switch (desc.t) {
    case "double":
      return r.f64();
    case "float":
      return r.f32();
    case "fixed32":
      return r.u32();
    case "sfixed32":
      return r.u32() | 0;
    case "fixed64":
      return String(r.u64());
    case "sfixed64":
      return String(BigInt.asIntN(64, r.u64()));
    case "int32":
      return Number(BigInt.asIntN(32, r.varint()));
    case "uint32":
      return Number(BigInt.asUintN(32, r.varint()));
    case "int64":
      return String(BigInt.asIntN(64, r.varint()));
    case "uint64":
      return String(BigInt.asUintN(64, r.varint()));
    case "sint32": {
      const v = r.varint();
      return Number(BigInt.asIntN(32, (v >> 1n) ^ -(v & 1n)));
    }
    case "sint64": {
      const v = r.varint();
      return String(BigInt.asIntN(64, (v >> 1n) ^ -(v & 1n)));
    }
    case "bool":
      return r.varint() !== 0n;
    case "enum": {
      const n = BigInt.asIntN(64, r.varint());
      const table = desc.e ?? {};
      for (const [name, num] of Object.entries(table)) {
        if (BigInt(num) === n) return name;
      }
      return String(n);
    }
    case "string":
      return td.decode(r.bytes());
    case "bytes":
      return Encoding.encodeBase64(r.bytes());
    case "message": {
      if (memberAst === undefined)
        throw new ProtoCodecError("message field lacks member schema");
      const sub = r.bytes();
      return decodeMessage(memberAst, sub);
    }
    case "wkt": {
      const sub = r.bytes();
      return decodeWkt(desc.w, sub);
    }
    default:
      throw new ProtoCodecError(`unsupported proto kind ${desc.t}`);
  }
};

// =============================================================================
// Message member traversal
// =============================================================================

/** Element AST for `repeated` members; value AST for `map` members. */
const memberAstOf = (prop: AST.PropertySignature): AST.AST | undefined => {
  const node = resolveNode(prop.type);
  if (node._tag === "Arrays") return node.rest[0];
  if (node._tag === "Objects" && node.indexSignatures.length > 0)
    return node.indexSignatures[0]!.type;
  return node;
};

const fieldDesc = (prop: AST.PropertySignature): ProtoFieldDesc | undefined =>
  getPropAnn(prop, protoFieldSymbol) as ProtoFieldDesc | undefined;

interface FieldEntry {
  readonly prop: AST.PropertySignature;
  readonly desc: ProtoFieldDesc;
}

/** field-number → member lookup, memoized per message AST. */
const fieldTables = new WeakMap<AST.AST, Map<number, FieldEntry>>();

const fieldTable = (ast: AST.AST): Map<number, FieldEntry> => {
  const node = resolveNode(ast);
  const cached = fieldTables.get(node);
  if (cached) return cached;
  const table = new Map<number, FieldEntry>();
  for (const prop of getProps(ast)) {
    const desc = fieldDesc(prop);
    if (desc !== undefined && desc.n !== undefined && desc.n > 0)
      table.set(desc.n, { prop, desc });
  }
  fieldTables.set(node, table);
  return table;
};

// =============================================================================
// Map entries
// =============================================================================

const encodeMapEntry = (
  keyDesc: ProtoFieldDesc,
  valueDesc: ProtoFieldDesc,
  valueAst: AST.AST | undefined,
  k: string,
  v: unknown,
): Uint8Array => {
  const out: number[] = [];
  const key = encodeMapKey(keyDesc, k);
  writeTag(out, 1, wireTypeOf(keyDesc.t));
  writeScalarPayload(out, keyDesc, key, undefined);
  writeTag(out, 2, wireTypeOf(valueDesc.t));
  writeScalarPayload(out, valueDesc, v, valueAst);
  return Uint8Array.from(out);
};

/** Map keys arrive as JS object keys (strings); coerce back per key kind. */
const encodeMapKey = (desc: ProtoFieldDesc, k: string): unknown => {
  switch (desc.t) {
    case "bool":
      return k === "true";
    case "string":
      return k;
    default:
      return k; // numeric kinds: asBigInt/asIntN handle numeric strings
  }
};

const mapKeyToString = (desc: ProtoFieldDesc, v: unknown): string => {
  if (desc.t === "bool") return v ? "true" : "false";
  return String(v);
};

const decodeMapEntry = (
  r: Reader,
  desc: ProtoFieldDesc,
  valueAst: AST.AST | undefined,
): [string, unknown] | undefined => {
  const keyDesc: ProtoFieldDesc = { n: 1, t: desc.k ?? "string" };
  const valueDesc: ProtoFieldDesc = { n: 2, t: "string", ...desc.v };
  let key: unknown;
  let value: unknown;
  while (r.pos < r.end) {
    const tag = r.varint();
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (n === 1 && wt === wireTypeOf(keyDesc.t)) {
      key = readScalarPayload(r, keyDesc, undefined);
    } else if (n === 2 && wt === wireTypeOf(valueDesc.t)) {
      value = readScalarPayload(r, valueDesc, valueAst);
    } else {
      r.skip(wt);
    }
  }
  if (key === undefined) return undefined;
  return [mapKeyToString(keyDesc, key), value];
};

// =============================================================================
// Well-known types
// =============================================================================

const WRAPPER_KINDS: Record<string, string> = {
  BoolValue: "bool",
  StringValue: "string",
  BytesValue: "bytes",
  Int32Value: "int32",
  UInt32Value: "uint32",
  Int64Value: "int64",
  UInt64Value: "uint64",
  FloatValue: "float",
  DoubleValue: "double",
};

const encodeWkt = (w: string | undefined, value: unknown): Uint8Array => {
  switch (w) {
    case "Empty":
      return new Uint8Array(0);
    case "Timestamp": {
      const s = String(value);
      const ms = Date.parse(s);
      if (!Number.isFinite(ms))
        throw new ProtoCodecError(
          `invalid Timestamp value ${JSON.stringify(s)}`,
        );
      const sec = Math.floor(ms / 1000);
      const frac = /\.(\d{1,9})/.exec(s)?.[1] ?? "";
      const nanos = frac
        ? Number(frac.padEnd(9, "0"))
        : Math.round((ms - sec * 1000) * 1e6);
      const out: number[] = [];
      if (sec !== 0) {
        writeTag(out, 1, 0);
        writeVarint(out, BigInt.asIntN(64, BigInt(sec)));
      }
      if (nanos !== 0) {
        writeTag(out, 2, 0);
        writeVarint(out, BigInt.asIntN(32, BigInt(nanos)));
      }
      return Uint8Array.from(out);
    }
    case "Duration": {
      const m = /^(-?\d+)(?:\.(\d{1,9}))?s$/.exec(String(value));
      if (!m)
        throw new ProtoCodecError(
          `invalid Duration value ${JSON.stringify(String(value))}`,
        );
      const sec = BigInt(m[1]!);
      const nanos = m[2] ? BigInt(m[2].padEnd(9, "0")) : 0n;
      const out: number[] = [];
      if (sec !== 0n) {
        writeTag(out, 1, 0);
        writeVarint(out, BigInt.asIntN(64, sec));
      }
      if (nanos !== 0n) {
        writeTag(out, 2, 0);
        writeVarint(out, BigInt.asIntN(32, nanos));
      }
      return Uint8Array.from(out);
    }
    case "FieldMask": {
      const paths = String(value)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const out: number[] = [];
      for (const p of paths) {
        writeTag(out, 1, 2);
        writeLen(out, te.encode(p));
      }
      return Uint8Array.from(out);
    }
    case "Any": {
      const v = (value ?? {}) as Record<string, unknown>;
      const out: number[] = [];
      const typeUrl = v.typeUrl ?? v["type_url"];
      if (typeof typeUrl === "string" && typeUrl) {
        writeTag(out, 1, 2);
        writeLen(out, te.encode(typeUrl));
      }
      if (v.value !== undefined) {
        writeTag(out, 2, 2);
        if (v.value instanceof Uint8Array) writeLen(out, v.value);
        else {
          const decoded = Encoding.decodeBase64(String(v.value));
          if (decoded._tag !== "Success")
            throw new ProtoCodecError("invalid base64 in Any.value");
          writeLen(out, decoded.success);
        }
      }
      return Uint8Array.from(out);
    }
    case "Struct":
    case "Value":
    case "ListValue":
      return encodeStructValue(w, value);
    default: {
      const kind = w !== undefined ? WRAPPER_KINDS[w] : undefined;
      if (kind === undefined)
        throw new ProtoCodecError(`unsupported well-known type ${w}`);
      const out: number[] = [];
      const inner: ProtoFieldDesc = { n: 1, t: kind };
      if (value !== undefined && value !== null) {
        writeTag(out, 1, wireTypeOf(kind));
        writeScalarPayload(out, inner, value, undefined);
      }
      return Uint8Array.from(out);
    }
  }
};

const decodeWkt = (w: string | undefined, buf: Uint8Array): unknown => {
  switch (w) {
    case "Empty":
      return {};
    case "Timestamp": {
      const { sec, nanos } = readSecondsNanos(buf);
      return new Date(Number(sec) * 1000 + Number(nanos) / 1e6).toISOString();
    }
    case "Duration": {
      const { sec, nanos } = readSecondsNanos(buf);
      const neg = nanos < 0n;
      const frac = String(neg ? -nanos : nanos)
        .padStart(9, "0")
        .replace(/0+$/, "");
      const sign = neg && sec === 0n ? "-" : "";
      return frac ? `${sign}${sec}.${frac}s` : `${sign}${sec}s`;
    }
    case "FieldMask": {
      const paths: string[] = [];
      const r = new Reader(buf);
      while (r.pos < r.end) {
        const tag = r.varint();
        const n = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (n === 1 && wt === 2) paths.push(td.decode(r.bytes()));
        else r.skip(wt);
      }
      return paths.join(",");
    }
    case "Any": {
      const out: Record<string, unknown> = {};
      const r = new Reader(buf);
      while (r.pos < r.end) {
        const tag = r.varint();
        const n = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (n === 1 && wt === 2) out.typeUrl = td.decode(r.bytes());
        else if (n === 2 && wt === 2)
          out.value = Encoding.encodeBase64(r.bytes());
        else r.skip(wt);
      }
      return out;
    }
    case "Struct": {
      const out: Record<string, unknown> = {};
      const r = new Reader(buf);
      while (r.pos < r.end) {
        const tag = r.varint();
        const n = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (n === 1 && wt === 2) {
          const [k, v] = readStructEntry(r.bytes());
          out[k] = v;
        } else r.skip(wt);
      }
      return out;
    }
    case "Value":
      return decodeJsonValue(buf);
    case "ListValue": {
      const out: unknown[] = [];
      const r = new Reader(buf);
      while (r.pos < r.end) {
        const tag = r.varint();
        const n = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (n === 1 && wt === 2) out.push(decodeJsonValue(r.bytes()));
        else r.skip(wt);
      }
      return out;
    }
    default: {
      const kind = w !== undefined ? WRAPPER_KINDS[w] : undefined;
      if (kind === undefined)
        throw new ProtoCodecError(`unsupported well-known type ${w}`);
      const r = new Reader(buf);
      let value: unknown;
      const inner: ProtoFieldDesc = { n: 1, t: kind };
      while (r.pos < r.end) {
        const tag = r.varint();
        const n = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (n === 1 && wt === wireTypeOf(kind)) {
          value = readScalarPayload(r, inner, undefined);
        } else r.skip(wt);
      }
      return value;
    }
  }
};

const readSecondsNanos = (buf: Uint8Array): { sec: bigint; nanos: bigint } => {
  let sec = 0n;
  let nanos = 0n;
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (n === 1 && wt === 0) sec = BigInt.asIntN(64, r.varint());
    else if (n === 2 && wt === 0) nanos = BigInt.asIntN(32, r.varint());
    else r.skip(wt);
  }
  return { sec, nanos };
};

// =============================================================================
// google.protobuf.{Struct,Value,ListValue} as plain JSON
// =============================================================================

const encodeStructValue = (w: string, value: unknown): Uint8Array => {
  const out: number[] = [];
  if (w === "Struct") {
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const entry: number[] = [];
      writeTag(entry, 1, 2);
      writeLen(entry, te.encode(k));
      writeTag(entry, 2, 2);
      writeLen(entry, encodeJsonValue(v));
      writeTag(out, 1, 2);
      writeLen(out, Uint8Array.from(entry));
    }
    return Uint8Array.from(out);
  }
  if (w === "ListValue") {
    for (const v of Array.isArray(value) ? value : []) {
      writeTag(out, 1, 2);
      writeLen(out, encodeJsonValue(v));
    }
    return Uint8Array.from(out);
  }
  return encodeJsonValue(value);
};

const encodeJsonValue = (v: unknown): Uint8Array => {
  const out: number[] = [];
  if (v === null || v === undefined) {
    writeTag(out, 1, 0);
    writeVarint(out, 0n);
  } else if (typeof v === "number") {
    writeTag(out, 2, 1);
    scratch.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) out.push(scratch.getUint8(i));
  } else if (typeof v === "string") {
    writeTag(out, 3, 2);
    writeLen(out, te.encode(v));
  } else if (typeof v === "boolean") {
    writeTag(out, 4, 0);
    writeVarint(out, v ? 1n : 0n);
  } else if (Array.isArray(v)) {
    writeTag(out, 6, 2);
    writeLen(out, encodeStructValue("ListValue", v));
  } else {
    writeTag(out, 5, 2);
    writeLen(out, encodeStructValue("Struct", v));
  }
  return Uint8Array.from(out);
};

const readStructEntry = (buf: Uint8Array): [string, unknown] => {
  let key = "";
  let value: unknown;
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (n === 1 && wt === 2) key = td.decode(r.bytes());
    else if (n === 2 && wt === 2) value = decodeJsonValue(r.bytes());
    else r.skip(wt);
  }
  return [key, value];
};

const decodeJsonValue = (buf: Uint8Array): unknown => {
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    switch (n) {
      case 1:
        if (wt === 0) {
          r.varint();
          return null;
        }
        break;
      case 2:
        if (wt === 1) return r.f64();
        break;
      case 3:
        if (wt === 2) return td.decode(r.bytes());
        break;
      case 4:
        if (wt === 0) return r.varint() !== 0n;
        break;
      case 5:
        if (wt === 2) return decodeWkt("Struct", r.bytes());
        break;
      case 6:
        if (wt === 2) return decodeWkt("ListValue", r.bytes());
        break;
      default:
        break;
    }
    r.skip(wt);
  }
  return undefined;
};

// =============================================================================
// Message codec
// =============================================================================

const encodeField = (
  out: number[],
  prop: AST.PropertySignature,
  desc: ProtoFieldDesc,
  n: number,
  value: unknown,
): void => {
  const memberAst = memberAstOf(prop);
  if (desc.t === "map") {
    if (value === null || typeof value !== "object") return;
    const valueDesc: ProtoFieldDesc = { n: 2, t: "string", ...desc.v };
    const keyDesc: ProtoFieldDesc = { n: 1, t: desc.k ?? "string" };
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      writeTag(out, n, 2);
      writeLen(out, encodeMapEntry(keyDesc, valueDesc, memberAst, k, v));
    }
    return;
  }
  if (desc.rep) {
    if (!Array.isArray(value)) return;
    if (value.length === 0) return;
    if (isPackable(desc.t)) {
      const packed: number[] = [];
      for (const v of value) writeScalarPayload(packed, desc, v, memberAst);
      writeTag(out, n, 2);
      writeLen(out, Uint8Array.from(packed));
      return;
    }
    for (const v of value) {
      writeTag(out, n, wireTypeOf(desc.t));
      writeScalarPayload(out, desc, v, memberAst);
    }
    return;
  }
  writeTag(out, n, wireTypeOf(desc.t));
  writeScalarPayload(out, desc, value, memberAst);
};

/**
 * Encode `value` against `ast`'s `ProtoField` annotations. `ast` should
 * describe a structure-shaped schema (Suspend/encoding wrappers are
 * resolved via the shared helpers).
 */
export const encodeMessage = (ast: AST.AST, value: unknown): Uint8Array => {
  const out: number[] = [];
  const input =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  for (const prop of getProps(ast)) {
    const desc = fieldDesc(prop);
    if (desc === undefined || desc.n === undefined) continue;
    if (desc.n === 0) {
      // Synthesized RPC-I/O member: the value IS the whole message body.
      if (value === undefined) return new Uint8Array(0);
      const inner: number[] = [];
      const v = (input as Record<string, unknown>)[String(prop.name)];
      if (v === undefined) return new Uint8Array(0);
      if (desc.t === "message") {
        return encodeMessage(memberAstOf(prop) ?? prop.type, v);
      }
      if (desc.t === "wkt") return encodeWkt(desc.w, v);
      if (desc.t === "map") return encodeMessage(prop.type, v);
      writeScalarPayload(inner, desc, v, memberAstOf(prop));
      return Uint8Array.from(inner);
    }
    const mv = input[String(prop.name)];
    if (mv === undefined) continue;
    encodeField(out, prop, desc, desc.n, mv);
  }
  return Uint8Array.from(out);
};

/**
 * Decode `buf` against `ast`'s `ProtoField` annotations into a TS-named
 * object. Unknown fields and absent members follow proto3 rules (skipped /
 * omitted).
 */
export const decodeMessage = (
  ast: AST.AST,
  buf: Uint8Array,
): Record<string, unknown> => {
  // Synthesized RPC-I/O member: the buffer IS the member's value.
  for (const prop of getProps(ast)) {
    const desc = fieldDesc(prop);
    if (desc !== undefined && desc.n === 0) {
      let value: unknown;
      if (desc.t === "message") {
        value = decodeMessage(memberAstOf(prop) ?? prop.type, buf);
      } else if (desc.t === "wkt") {
        value = decodeWkt(desc.w, buf);
      } else if (desc.t === "map") {
        value = decodeMessage(prop.type, buf);
      } else {
        const r = new Reader(buf);
        value =
          r.pos < r.end
            ? readScalarPayload(r, desc, memberAstOf(prop))
            : undefined;
      }
      return { [String(prop.name)]: value };
    }
  }
  const table = fieldTable(ast);
  const out: Record<string, unknown> = {};
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    const entry = table.get(n);
    if (entry === undefined) {
      r.skip(wt);
      continue;
    }
    const { prop, desc } = entry;
    const key = String(prop.name);
    const memberAst = memberAstOf(prop);
    if (desc.t === "map") {
      if (wt !== 2) {
        r.skip(wt);
        continue;
      }
      const pair = decodeMapEntry(new Reader(r.bytes(), 0), desc, memberAst);
      if (pair !== undefined) {
        const rec = (out[key] ??= {}) as Record<string, unknown>;
        rec[pair[0]] = pair[1];
      }
      continue;
    }
    if (desc.rep) {
      const arr = (out[key] ??= []) as unknown[];
      if (wt === 2 && isPackable(desc.t)) {
        const packed = new Reader(r.bytes());
        while (packed.pos < packed.end) {
          arr.push(readScalarPayload(packed, desc, memberAst));
        }
      } else if (wt === wireTypeOf(desc.t)) {
        arr.push(readScalarPayload(r, desc, memberAst));
      } else {
        r.skip(wt);
      }
      continue;
    }
    if (wt !== wireTypeOf(desc.t)) {
      r.skip(wt);
      continue;
    }
    out[key] = readScalarPayload(r, desc, memberAst);
  }
  return out;
};
