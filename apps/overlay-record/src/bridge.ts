/**
 * The preload bridge, named.
 *
 * Both windows load `main/preload.js`, so `window.electronAPI` is the same
 * object the editor gets — typed `any` there and typed `any` here, because the
 * preload has no declaration file. What this module adds is a single place
 * where that `any` is unwrapped, so a channel that was renamed fails in one
 * file rather than in six.
 *
 * Every request answers `{ status: 1, ... }` or `{ status: 0, error }`;
 * `expect` turns the second into a thrown `Error` so callers can use ordinary
 * `try`/`catch` instead of checking a status after every line.
 */

const api = () => (window as any).electronAPI;

export type Status<T> = ({ status: 1 } & T) | { status: 0; error?: string };

export function expect<T>(result: Status<T>, what: string): T {
  if (result == null || result.status !== 1) {
    throw new Error(
      `${what}: ${(result as any)?.error ?? "the main process said nothing"}`,
    );
  }
  return result as T;
}

export type CaptureSource = {
  id: string;
  name: string;
  displayId: string;
  display: { width: number; height: number; scaleFactor: number } | null;
};

export const bridge = {
  /** Persisted settings live under one key, whole. */
  loadSettings: async (): Promise<unknown> => {
    const result = await api().req.store.get("record");
    return result?.status === 1 ? result.value : undefined;
  },

  saveSettings: (settings: unknown): Promise<unknown> =>
    api().req.store.set("record", settings),

  platform: async (): Promise<string> => {
    const result = await api().req.overlayRecord.platform();
    return expect(result, "could not read the platform").platform;
  },

  sources: async (): Promise<CaptureSource[]> => {
    const result = await api().req.overlayRecord.sources();
    return expect(result, "could not list capture sources").sources;
  },

  permissions: async (): Promise<{
    camera: string;
    microphone: string;
    screen: string;
  }> => expect(await api().req.overlayRecord.permissions(), "permissions"),

  requestPermission: (kind: "camera" | "microphone" | "screen") =>
    api().req.overlayRecord.requestPermission(kind),

  setTray: (model: unknown) => api().req.overlayRecord.setTray(model),

  setOverlay: (state: unknown) => api().req.overlayRecord.setOverlay(state),

  armDisplayMedia: (sourceId: string, audio: boolean) =>
    api().req.overlayRecord.armDisplayMedia(sourceId, audio),

  disarmDisplayMedia: () => api().req.overlayRecord.disarmDisplayMedia(),

  start: async (request: {
    displayId: string;
    captureWidth: number;
    captureHeight: number;
  }): Promise<{ id: string; dir: string }> =>
    expect(
      await api().req.overlayRecord.start(request),
      "could not start the recording",
    ),

  /**
   * Append encoded bytes, and wait for the pipe to have room.
   *
   * Awaiting this is the backpressure. An encoder that fired and forgot would
   * outrun a slow disk and buffer the difference in this renderer's heap, which
   * is exactly what writing incrementally exists to avoid.
   */
  append: async (
    sessionId: string,
    key: "video" | "mic" | "system",
    chunk: Uint8Array,
  ): Promise<void> => {
    expect(
      await api().req.overlayRecord.append(sessionId, key, chunk),
      "could not write the recording",
    );
  },

  finishFile: (sessionId: string, key: "video" | "mic" | "system") =>
    api().req.overlayRecord.finishFile(sessionId, key),

  pause: (sessionId: string) => api().req.overlayRecord.pause(sessionId),
  resume: (sessionId: string) => api().req.overlayRecord.resume(sessionId),

  stop: async (
    sessionId: string,
  ): Promise<{
    cursor: { t: number; x: number; y: number }[];
    strokes: unknown[];
    clicks: unknown[];
    durationMs: number;
  }> =>
    expect(
      await api().req.overlayRecord.stop(sessionId),
      "could not stop the recording",
    ),

  deliver: async (
    sessionId: string,
    request: {
      fps: number;
      audio: { key: "mic" | "system"; sampleRate: number; channels: number }[];
    },
  ): Promise<string> =>
    expect(
      await api().req.overlayRecord.deliver(sessionId, request),
      "could not write the finished recording",
    ).path,

  cancel: () => api().req.overlayRecord.cancel(),
  openFolder: () => api().req.overlayRecord.openFolder(),
  close: () => api().req.overlayRecord.close(),

  onTrayClick: (handler: (id: string) => void) => {
    api().res.overlayRecord.tray((_event: unknown, id: string) =>
      handler(id),
    );
  },

  onOverlayState: (handler: (state: any) => void) => {
    api().res.overlayRecord.overlay((_event: unknown, state: any) =>
      handler(state),
    );
  },

  /** Annotations from the overlay, relayed by main. Engine side. */
  onStroke: (handler: (message: any) => void) => {
    api().res.overlayRecord.stroke((_event: unknown, message: any) =>
      handler(message),
    );
  },

  /** The overlay's Done button and Escape key, relayed by main. Engine side. */
  onSetDrawing: (handler: (value: boolean) => void) => {
    api().res.overlayRecord.setDrawing((_event: unknown, value: boolean) =>
      handler(value === true),
    );
  },
};
