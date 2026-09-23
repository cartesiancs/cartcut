/**
 * Everything the three ends of the extension system say to each other.
 *
 * Its own file with **no imports at all**, for the reason
 * `features/project/assetPaths.ts` has none: the extension host is a
 * `utilityProcess`, the editor is a webpack bundle, and main is a third
 * program. One import of `electron` here would make this module unloadable in
 * the renderer's build, and one import of the renderer tree would relocate the
 * whole main build out of `main/` (`.tsconfig` pins `rootDir`).
 *
 * Main and the host compile against this file directly. The renderer cannot,
 * so `apps/app/src/features/extension/constants.ts` is a hand copy and
 * `protocolDrift.test.ts` dynamically imports both and asserts they agree,
 * exactly as `electron/mcp/tools/tools.test.ts` does for `FILETYPES`.
 *
 * Every message crosses a structured-clone boundary: plain data only, no class
 * instances and no functions.
 */

/**
 * Bumped when a message shape changes in a way an older host cannot read.
 *
 * Checked at the hello handshake and nowhere else. A mismatch stops the
 * session rather than letting a host discover the incompatibility halfway
 * through an edit, where half a batch would already have been applied.
 */
export const PROTOCOL_VERSION = 1;

/**
 * What an extension's `engines.cartcut` range is satisfied against.
 *
 * A string rather than a number because it is a semver major: an extension
 * declares `"^1"` and keeps working across every additive release.
 */
export const EXTENSION_API_VERSION = "1.0.0";

/**
 * `publisher.name`, lowercase only.
 *
 * Lowercase is not cosmetic. An extension id is the host component of a
 * `cartcut-ext://` URL, and a standard scheme lowercases its host, so
 * `Acme.Tool` and `acme.tool` would be the same origin with two directory
 * names. It is also a path segment under `userData/extensions`, which is why
 * the character set has no separator, no dot beyond the single one, and no
 * leading dash.
 */
export const EXTENSION_ID_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/;

/** A command id inside one extension. Namespaced to `<extId>/<id>` on the wire. */
export const COMMAND_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

/** A view id inside one extension. Same shape as a command id. */
export const VIEW_ID_PATTERN = COMMAND_ID_PATTERN;

/**
 * Errors travel as data with a code, never as a thrown string.
 *
 * The code is what the host's API layer branches on. A message is for the log
 * and for the user; matching on it would break the first time one was reworded.
 */
export const ERROR_CODES = [
  "E_UNKNOWN_METHOD",
  "E_PERMISSION",
  "E_LOCKED",
  "E_DECLINED",
  "E_TIMEOUT",
  "E_CANCELLED",
  "E_TOO_LARGE",
  "E_RATE",
  "E_VERSION",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Every method name, grouped by the port it travels on.
 *
 * Two groups rather than one flat list because the split is load bearing:
 * `R` reaches the editor renderer directly and never touches main, so a hung
 * extension cannot block the main process; `M` reaches main, which is the only
 * process allowed to open a dialog, rebuild the menu, or read a secret.
 * `bridge.ts` refuses an `M` name arriving on `R` rather than forwarding it.
 */
export const METHODS = {
  /** Host to editor renderer, over the direct port. */
  R: [
    "commands.execute",
    "commands.batch",
    "commands.list",
    "project.info",
    "project.getData",
    "project.setData",
    "window.showPanel",
    "window.closePanel",
    "window.showMessage",
    "window.setStatusItem",
    "task.start",
    "task.progress",
    "task.end",
  ] as const,

  /** Host to main. */
  M: [
    "assets.reveal",
    "window.showOpenDialog",
    "window.showSaveDialog",
    "view.post",
    "config.get",
    "config.set",
    "storage.get",
    "storage.set",
    "storage.delete",
    "secrets.get",
    "secrets.set",
    "secrets.delete",
    "paths.ffmpeg",
    "paths.ffprobe",
    "menus.set",
    "shell.open",
    "ai.registerTool",
    "ai.unregisterTool",
    "host.ready",
    "host.log",
    "host.extensionState",
  ] as const,

  /** Editor renderer to host, over the direct port. */
  RtoH: [
    "commands.invoke",
    "task.cancel",
    "activation.request",
    "export.willExport",
    "export.didExport",
  ] as const,

  /** Main to host. */
  MtoH: [
    "host.shutdown",
    "host.setEnabled",
    "ai.invoke",
    "view.message",
    "view.visible",
    "config.changed",
  ] as const,
} as const;

/** Events the editor pushes to the host. Fire and forget, never answered. */
export const EVENTS = [
  "document.changed",
  "playhead.changed",
  "selection.changed",
  "playback.changed",
  "lock.changed",
  "project.opened",
  "project.saved",
] as const;

export type EventName = (typeof EVENTS)[number];

/** The id of the extension a request is made on behalf of, stamped by the host. */
export type ExtensionId = string;

export type RpcRequest = {
  id: string;
  method: string;
  params: unknown;
  /** Absent only for the hello exchange, which is not made for an extension. */
  ext?: ExtensionId;
};

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: { code: ErrorCode; message: string; data?: unknown };
    };

export type RpcEvent = {
  event: string;
  params: unknown;
  ext?: ExtensionId;
};

/**
 * Cancellation is a notification, not a request.
 *
 * It carries no id of its own and is never answered: the answer is the
 * original request rejecting with `E_CANCELLED`. A request/response cancel
 * would need its own timeout, and a timed-out cancel has no meaning.
 */
export type RpcCancel = { method: "$/cancel"; params: { id: string } };

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcCancel;

/** Sent by the host the moment it holds both ports. */
export type HostHello = {
  method: "host.hello";
  id: string;
  params: {
    protocolVersion: number;
    apiVersion: string;
    extensions: HelloExtension[];
  };
};

/** What the editor needs to render one extension's contributions. */
export type HelloExtension = {
  id: string;
  version: string;
  displayName: string;
  permissions: string[];
  contributes: unknown;
};

export type EditorHello = {
  protocolVersion: number;
  appVersion: string;
};

/**
 * Caps, in bytes of the JSON form.
 *
 * A params cap because a host that serialises a whole decoded frame into a
 * call would otherwise stall the renderer's main thread inside
 * `JSON.parse`. A larger result cap because `list_clips` on a big project is
 * legitimately large, and it is already bounded by `serialize.ts`, which never
 * sends a baked animation lane.
 */
export const MAX_PARAMS_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** One message from a webview page. Larger belongs in a file. */
export const MAX_VIEW_MESSAGE_BYTES = 256 * 1024;

/** Default per call. Long enough for a real edit, short enough to surface a wedge. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** A command the manifest marked `longRunning`. An export pass is minutes. */
export const LONG_TIMEOUT_MS = 10 * 60_000;
/** A read that touches no disk. */
export const SHORT_TIMEOUT_MS = 5_000;
