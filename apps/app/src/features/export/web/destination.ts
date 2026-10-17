/**
 * Where the browser export writes its file.
 *
 * Three routes, best first:
 *
 *   1. **The save dialog** (`showSaveFilePicker`, Chrome and Edge). The muxer
 *      writes straight into the file the user chose, at the positions it
 *      chooses, so a long export never sits in memory.
 *   2. **The origin's private file system, then a download** (OPFS, where
 *      there is no save dialog). Written to disk the same way, then handed to
 *      the browser's downloads as a disk-backed `File`.
 *   3. **Memory, then a download**, where neither exists.
 *
 * Mediabunny closes the stream it was given both when it finishes and when it
 * is cancelled, and a closed `FileSystemWritableFileStream` commits whatever it
 * holds. So the stream handed to it here commits only after `commitOnClose`,
 * which the session calls just before `finalize`; any other close aborts, and
 * a cancelled export leaves the chosen file as it was.
 *
 * Every browser API is reached through `DestinationHost`, so the routing runs
 * under `environment: "node"` against fakes.
 */

import type { StreamTargetChunk } from "mediabunny";

export type ExportDestination = {
  /** The file name, for the finished dialog. */
  readonly name: string;
  readonly writable: WritableStream<StreamTargetChunk>;
  /** The next close of `writable` is the finished file, not a cancel. */
  commitOnClose(): void;
  /** After a successful finalize: hand the file over, where that is a step of its own. */
  deliver(): Promise<void>;
  /** After a cancel or a failure: leave nothing behind that this export made. */
  discard(): Promise<void>;
};

/** The writable half of a file, the shape `FileSystemWritableFileStream` has. */
type FileWriter = {
  write(chunk: { type: "write"; data: Uint8Array; position: number }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

type FileHandle = {
  createWritable?(): Promise<FileWriter>;
  getFile(): Promise<Blob>;
};

type DirectoryHandle = {
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
};

export type DestinationHost = {
  showSaveFilePicker?: (options: unknown) => Promise<FileHandle>;
  /** The origin's private file system root, or `null` where there is none. */
  privateRoot(): Promise<DirectoryHandle | null>;
  download(blob: Blob, name: string): void;
};

export type SaveRequest = {
  readonly suggestedName: string;
  readonly mimeType: string;
  readonly extension: string;
};

/** The folder inside the origin's private file system that exports pass through. */
const SCRATCH_FOLDER = "cartcut-exports";

/** The stream Mediabunny writes to, over one file writer. */
function streamOver(writer: FileWriter, state: { commit: boolean; settled: boolean }) {
  const settle = async (commit: boolean) => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    await (commit ? writer.close() : writer.abort());
  };
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => writer.write({ type: "write", data: chunk.data, position: chunk.position }),
    close: () => settle(state.commit),
    abort: () => settle(false),
  });
  return { writable, settle };
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

/**
 * Ask where to write, or answer `null` when the user cancelled the dialog.
 *
 * Must be the first thing awaited after the click: the save dialog needs the
 * click's user activation, which a few awaits in between can use up. Where it
 * refuses anyway (no activation, or a policy), the export goes to a download.
 */
export async function chooseDestination(
  host: DestinationHost,
  request: SaveRequest,
): Promise<ExportDestination | null> {
  if (host.showSaveFilePicker != null) {
    let handle: FileHandle | null = null;
    try {
      handle = await host.showSaveFilePicker({
        suggestedName: request.suggestedName,
        types: [
          {
            description: request.extension.toUpperCase(),
            accept: { [request.mimeType]: [`.${request.extension}`] },
          },
        ],
      });
    } catch (error) {
      if (isAbort(error)) {
        return null;
      }
      // Refused rather than cancelled: fall through to a download.
    }
    if (handle?.createWritable != null) {
      const writer = await handle.createWritable();
      const state = { commit: false, settled: false };
      const { writable, settle } = streamOver(writer, state);
      return {
        name: (handle as { name?: string }).name ?? request.suggestedName,
        writable,
        commitOnClose: () => {
          state.commit = true;
        },
        deliver: async () => {},
        discard: () => settle(false),
      };
    }
  }

  const root = await host.privateRoot().catch(() => null);
  if (root != null) {
    const folder = await (root as any)
      .getDirectoryHandle(SCRATCH_FOLDER, { create: true })
      .catch(() => null) as DirectoryHandle | null;
    if (folder != null) {
      // Each download is handed over as a disk-backed `File`, which must
      // outlive the export, so the previous export's file is cleared here
      // rather than after its own download.
      for await (const name of folder.keys()) {
        await folder.removeEntry(name).catch(() => {});
      }
      const scratchName = `${Date.now()}-${request.suggestedName}`;
      const file = await folder.getFileHandle(scratchName, { create: true });
      if (file.createWritable != null) {
        const writer = await file.createWritable();
        const state = { commit: false, settled: false };
        const { writable, settle } = streamOver(writer, state);
        return {
          name: request.suggestedName,
          writable,
          commitOnClose: () => {
            state.commit = true;
          },
          deliver: async () => {
            host.download(await file.getFile(), request.suggestedName);
          },
          discard: async () => {
            await settle(false);
            await folder.removeEntry(scratchName).catch(() => {});
          },
        };
      }
      await folder.removeEntry(scratchName).catch(() => {});
    }
  }

  return memoryDestination(host, request);
}

/** The last route: the file in memory, then a download. */
function memoryDestination(host: DestinationHost, request: SaveRequest): ExportDestination {
  let bytes = new Uint8Array(1 << 20);
  let size = 0;
  let committed = false;
  const writer: FileWriter = {
    async write({ data, position }) {
      const end = position + data.byteLength;
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(Math.max(end, bytes.byteLength * 2));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(data, position);
      size = Math.max(size, end);
    },
    async close() {
      committed = true;
    },
    async abort() {
      bytes = new Uint8Array(0);
      size = 0;
    },
  };
  const state = { commit: false, settled: false };
  const { writable, settle } = streamOver(writer, state);
  return {
    name: request.suggestedName,
    writable,
    commitOnClose: () => {
      state.commit = true;
    },
    deliver: async () => {
      if (committed) {
        host.download(new Blob([bytes.subarray(0, size)], { type: request.mimeType }), request.suggestedName);
      }
      bytes = new Uint8Array(0);
    },
    discard: () => settle(false),
  };
}

/** The real browser, for the app. */
export function browserDestinationHost(): DestinationHost {
  const picker = (window as any).showSaveFilePicker;
  return {
    ...(typeof picker === "function"
      ? { showSaveFilePicker: (options: unknown) => picker.call(window, options) }
      : {}),
    privateRoot: async () => {
      const storage = navigator.storage as any;
      return typeof storage?.getDirectory === "function" ? storage.getDirectory() : null;
    },
    download: (blob, name) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Long enough for the browser to have started reading it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}
