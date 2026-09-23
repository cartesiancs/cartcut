/**
 * Everything an extension's webview page can reach. It is this file, entirely.
 *
 * The guest runs sandboxed with context isolation, so the page sees exactly
 * what is exposed here and nothing else: no `electronAPI`, no `require`, no
 * `process`. `acquireCartcutApi` is named after VS Code's
 * `acquireVsCodeApi` because it is the same idea and an author who has written
 * one panel should not have to learn a second vocabulary.
 *
 * The API is deliberately four methods. A panel talks to its extension and the
 * extension does the work; anything wider here would be a second surface to
 * secure, in the process with the least reason to be trusted.
 */

import { contextBridge, ipcRenderer } from "electron";

const CHANNEL = "ext:view:message";

type Listener = (message: unknown) => void;

const listeners = new Set<Listener>();

ipcRenderer.on(CHANNEL, (_event, message: unknown) => {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error("[cartcut] a message listener threw", error);
    }
  }
});

/**
 * Per-view state that survives the panel being hidden and shown again.
 *
 * In memory rather than in `localStorage`, and that is the honest tradeoff: it
 * lasts as long as the page does, which is as long as the panel is mounted.
 * A panel that wants more asks its extension, which has real storage. Keeping
 * it here means a view cannot accumulate state the user has no way to clear.
 */
let state: unknown = null;

const api = {
  postMessage(message: unknown): void {
    ipcRenderer.send(CHANNEL, message);
  },
  onMessage(listener: Listener): () => void {
    listeners.add(listener);
    // Returns an unsubscribe rather than expecting the caller to reconstruct
    // the same function reference, which is the shape every push namespace in
    // `preload.ts` settled on.
    return () => listeners.delete(listener);
  },
  getState(): unknown {
    return state;
  },
  setState(next: unknown): void {
    state = next;
  },
};

contextBridge.exposeInMainWorld("acquireCartcutApi", () => api);
