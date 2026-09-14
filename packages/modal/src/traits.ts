/**
 * Modal SDK trait surface — hand-written.
 *
 * Re-exports the generic protocol traits from core so generated operations
 * import everything from one place. Modal operations are unary binary gRPC
 * calls at `/<package>.<Service>/<Method>` paths; members carry
 * `T.ProtoField` wire descriptors for `core/protobuf`.
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
} from "@distilled.cloud/core/trait";

export {
  SensitiveValue,
  RawResponse,
  RawResponseRoot,
  sensitiveValueSymbol,
  rawResponseSymbol,
  rawResponseRootSymbol,
} from "@distilled.cloud/core/protocol-rest";
