/**
 * Daytona pagination — hand-written.
 *
 * Cursor-mode paginated list operations carry `nextCursor` in the response
 * envelope; generated operations pass core's {@link paginateCursor} strategy
 * to `API.makePaginated` when the spec marks them `smithy.api#paginated`.
 */
export { paginateCursor } from "@rikalabs/distilled-core/pagination";
