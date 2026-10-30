/**
 * The browser build's speech port, wired to the real browser.
 *
 * `webTtsPort.ts` holds every rule; this file only hands it Cache Storage,
 * `fetch`, SubtleCrypto, the worker and the asset list. The worker is
 * webpack's second entry, `ttsWorker.js`, emitted beside `index.js`, so its
 * address is the bundle's own public path.
 */

import { importedMediaStore } from "../../asset/webMedia/importedMedia";
import type { TtsPort } from "../ttsPort";
import {
  openModelCache,
  pruneStaleModelCaches,
  type CacheStorageLike,
} from "./webModelStore";
import {
  createWebTtsPort,
  type WorkerHandlers,
  type WorkerLike,
} from "./webTtsPort";
import type { WebWorkerEvent } from "./webTtsProtocol";

declare const __webpack_public_path__: string;

/** What synthesis needs from a browser, as plain flags so the rule is testable. */
export type BrowserFeatures = {
  webAssembly: boolean;
  worker: boolean;
  /** Cache Storage and SubtleCrypto, both of which exist only in a secure context. */
  secureStorage: boolean;
};

/** Why this browser cannot synthesise, or `null` when it can. */
export function browserTtsBlocker(features: BrowserFeatures): string | null {
  if (!features.webAssembly) {
    return "This browser cannot run WebAssembly, which speech synthesis needs.";
  }
  if (!features.worker) {
    return "This browser cannot start the background worker speech synthesis runs in.";
  }
  if (!features.secureStorage) {
    return "Speech synthesis needs a secure page. Open the editor over https, or on localhost.";
  }
  return null;
}

function detect(): BrowserFeatures {
  const scope = globalThis as {
    WebAssembly?: unknown;
    Worker?: unknown;
    caches?: unknown;
    crypto?: { subtle?: unknown };
    isSecureContext?: boolean;
  };
  return {
    webAssembly: typeof scope.WebAssembly === "object",
    worker: typeof scope.Worker === "function",
    secureStorage:
      scope.isSecureContext === true &&
      scope.caches != null &&
      scope.crypto?.subtle != null,
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function spawnWorker(handlers: WorkerHandlers): WorkerLike {
  const worker = new Worker(`${__webpack_public_path__}ttsWorker.js`, {
    name: "cartcut-tts",
  });
  worker.onmessage = (event: MessageEvent<WebWorkerEvent>) =>
    handlers.onEvent(event.data);
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    handlers.onFailure(event.message || "the worker script did not load");
  };
  worker.onmessageerror = () => handlers.onFailure("a message could not be read");
  return {
    post: (command) => worker.postMessage(command),
    terminate: () => worker.terminate(),
  };
}

function storageList(): CacheStorageLike {
  return {
    keys: () => caches.keys(),
    delete: (name) => caches.delete(name),
  };
}

function createBrowserPort(): TtsPort {
  return createWebTtsPort({
    openCache: () => openModelCache(caches),
    // `no-store`, or the browser's HTTP cache keeps a second copy of 400MB
    // beside the one in Cache Storage.
    fetch: (url, init) => fetch(url, { signal: init.signal, cache: "no-store" }),
    digest: async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes)),
    sha1: async (text) =>
      hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))),
    spawnWorker,
    // Listed in the asset panel like a picked file, which is also what lets
    // the export read its bytes (`mediaRegistry.ts`).
    register: (wav, name) =>
      importedMediaStore
        .getState()
        .add([{ file: new File([wav], name, { type: "audio/wav" }) }])[0],
    freeBytes: async () => {
      const estimate = await navigator.storage?.estimate?.();
      return estimate?.quota == null
        ? null
        : Math.max(0, estimate.quota - (estimate.usage ?? 0));
    },
    pruneStale: () => pruneStaleModelCaches(storageList()),
  });
}

let port: TtsPort | null | undefined;

/** The browser's speech port, or `null` when this browser cannot synthesise. */
export function browserTtsPort(): TtsPort | null {
  if (port === undefined) {
    port = browserTtsBlocker(detect()) == null ? createBrowserPort() : null;
  }
  return port;
}

/** What the panel says when `browserTtsPort` answers `null`. */
export function browserTtsUnavailableMessage(): string {
  return browserTtsBlocker(detect()) ?? "Speech synthesis is not available here.";
}
