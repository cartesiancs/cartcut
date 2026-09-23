/**
 * The one file in the renderer that reaches across into `electron/`.
 *
 * The protocol and the RPC endpoint are compiled into all three processes, and
 * there is no place all three can import from: `electron/` may never import
 * `apps/app/src` (`.tsconfig` pins `rootDir`, and widening it relocates the
 * whole main build out of `main/`), so a shared module has to live on the
 * `electron/` side and be reached from here.
 *
 * Both files it pulls in import nothing but each other. That is not an
 * accident and it is not something to rely on quietly:
 * `sharedBoundary.test.ts` reads them and fails if either grows an import, so
 * the day somebody adds `electron` to `rpc.ts` is a failing test rather than a
 * webpack error about `fs` in a bundle.
 *
 * Everything else in the renderer imports from here rather than from the path,
 * for the reason `apps/overlay-record/src/bridge.ts` gives about its own
 * facade: a file that was renamed fails in one place instead of in six.
 */

export {
  createRpcEndpoint,
  RpcError,
  type InboundRequest,
  type PortLike,
  type RpcEndpoint,
} from "../../../../../electron/extension/rpc";

export {
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  EVENTS,
  EXTENSION_API_VERSION,
  EXTENSION_ID_PATTERN,
  LONG_TIMEOUT_MS,
  MAX_PARAMS_BYTES,
  MAX_RESULT_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  SHORT_TIMEOUT_MS,
  type ErrorCode,
  type HelloExtension,
} from "../../../../../electron/extension/protocol";
