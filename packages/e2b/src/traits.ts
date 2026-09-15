/**
 * E2B SDK trait surface — hand-written.
 *
 * Re-exports the generic protocol traits from core so generated operations
 * import everything from one place, plus the E2B-specific markers:
 *
 *   - `T.ProtoField` wire descriptors on envd RPC members (`core/protobuf`
 *     drives the binary Connect encoding).
 *   - `T.QueryJoin` on `explode: false` array query members — the protocol
 *     serializes them as one comma-joined `k=a,b,c` pair.
 *   - `T.ConnectStream` on server-streaming RPC input schemas — the envd
 *     protocol sends an enveloped `application/connect+proto` request
 *     instead of a raw `application/proto` one.
 */
export {
  Body,
  Header,
  Query,
  Label,
  Http,
  ResponseCode,
  HttpBody,
  FormDataFile,
  KeyDictionary,
  UnionCases,
  ProtoField,
  applyErrorMatchers,
  getErrorMatchers,
  type HttpTrait,
  type ErrorMatcher,
  type ProtoFieldDesc,
  bodySymbol,
  headerSymbol,
  querySymbol,
  labelSymbol,
  httpSymbol,
  responseCodeSymbol,
  httpBodySymbol,
  formDataFileSymbol,
  keyDictionarySymbol,
  unionCasesSymbol,
  protoFieldSymbol,
  errorMatchersSymbol,
  makeAnnotation,
} from "@rikalabs/distilled-core/trait";

export {
  SensitiveValue,
  RawResponse,
  RawResponseRoot,
  sensitiveValueSymbol,
  rawResponseSymbol,
  rawResponseRootSymbol,
} from "@rikalabs/distilled-core/protocol-rest";

import { makeAnnotation } from "@rikalabs/distilled-core/trait";

export const queryJoinSymbol = Symbol.for("@rikalabs/distilled-e2b/query-join");
/**
 * Marks an array query member serialized with `explode: false` semantics —
 * `state=running,paused` rather than `state=running&state=paused`.
 */
export const QueryJoin = (separator?: string) =>
  makeAnnotation(queryJoinSymbol, separator ?? ",");

export const connectStreamSymbol = Symbol.for(
  "@rikalabs/distilled-e2b/connect-stream",
);
/**
 * Marks the input schema of a server-streaming Connect RPC: the request is
 * one enveloped `application/connect+proto` frame rather than a raw
 * `application/proto` body.
 */
export const ConnectStream = () => makeAnnotation(connectStreamSymbol, true);
