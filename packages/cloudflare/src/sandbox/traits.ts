/**
 * Cloudflare Sandbox SDK trait surface — hand-written.
 *
 * Re-exports the generic protocol traits from core so generated operations
 * import everything from one place. Bridge operations are REST JSON calls;
 * the hand-written exec/file operations (`src/exec.ts`, `src/files.ts`)
 * annotate their input schemas with the same `T.Http`/`T.Label`/`T.Body`/
 * `T.Header` machinery the generator emits.
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
} from "@rikalabs/distilled-core/trait";

export {
  SensitiveValue,
  RawResponse,
  RawResponseRoot,
  sensitiveValueSymbol,
  rawResponseSymbol,
  rawResponseRootSymbol,
} from "@rikalabs/distilled-core/protocol-rest";
