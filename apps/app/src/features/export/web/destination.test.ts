import { describe, expect, it } from "vitest";
import { chooseDestination, type DestinationHost } from "./destination";

const request = { suggestedName: "edit.mp4", mimeType: "video/mp4", extension: "mp4" };

/** A file writer that records what happened to it. */
function recordingFile() {
  const log: string[] = [];
  const bytes: number[] = [];
  return {
    log,
    bytes,
    handle: {
      name: "chosen.mp4",
      async createWritable() {
        return {
          async write({ data, position }: { data: Uint8Array; position: number }) {
            log.push(`write@${position}`);
            data.forEach((byte, i) => (bytes[position + i] = byte));
          },
          async close() {
            log.push("close");
          },
          async abort() {
            log.push("abort");
          },
        };
      },
      async getFile() {
        return new Blob([Uint8Array.from(bytes)]);
      },
    },
  };
}

async function writeAndClose(writable: WritableStream<any>, chunks: [number, number[]][]) {
  const writer = writable.getWriter();
  for (const [position, data] of chunks) {
    await writer.write({ type: "write", data: Uint8Array.from(data), position });
  }
  await writer.close();
}

function noOpfs(downloads: { blob: Blob; name: string }[] = []): DestinationHost {
  return {
    privateRoot: async () => null,
    download: (blob, name) => downloads.push({ blob, name }),
  };
}

describe("chooseDestination", () => {
  it("writes into the file the save dialog chose, at the muxer's positions", async () => {
    const file = recordingFile();
    const destination = await chooseDestination(
      { ...noOpfs(), showSaveFilePicker: async () => file.handle },
      request,
    );
    expect(destination?.name).toBe("chosen.mp4");
    destination!.commitOnClose();
    await writeAndClose(destination!.writable, [
      [0, [1, 2, 3]],
      [10, [9]],
      [1, [7]],
    ]);
    await destination!.deliver();
    expect(file.log).toEqual(["write@0", "write@10", "write@1", "close"]);
    expect(file.bytes.slice(0, 3)).toEqual([1, 7, 3]);
  });

  it("aborts rather than commits a close nobody marked as finished", async () => {
    const file = recordingFile();
    const destination = await chooseDestination(
      { ...noOpfs(), showSaveFilePicker: async () => file.handle },
      request,
    );
    await writeAndClose(destination!.writable, [[0, [1]]]);
    await destination!.discard();
    expect(file.log).toEqual(["write@0", "abort"]);
  });

  it("answers null when the user cancels the dialog", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const destination = await chooseDestination(
      { ...noOpfs(), showSaveFilePicker: async () => Promise.reject(cancelled) },
      request,
    );
    expect(destination).toBeNull();
  });

  it("falls back to a download when the dialog is refused", async () => {
    const downloads: { blob: Blob; name: string }[] = [];
    const refused = Object.assign(new Error("no gesture"), { name: "SecurityError" });
    const destination = await chooseDestination(
      { ...noOpfs(downloads), showSaveFilePicker: async () => Promise.reject(refused) },
      request,
    );
    destination!.commitOnClose();
    await writeAndClose(destination!.writable, [[0, [5, 6]]]);
    await destination!.deliver();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("edit.mp4");
    expect([...new Uint8Array(await downloads[0].blob.arrayBuffer())]).toEqual([5, 6]);
  });

  it("downloads nothing for an export that was cancelled", async () => {
    const downloads: { blob: Blob; name: string }[] = [];
    const destination = await chooseDestination(noOpfs(downloads), request);
    await writeAndClose(destination!.writable, [[0, [5, 6]]]);
    await destination!.deliver();
    expect(downloads).toHaveLength(0);
  });

  it("writes through the private file system and downloads the file from disk", async () => {
    const files = new Map<string, ReturnType<typeof recordingFile>>();
    const removed: string[] = [];
    const folder = {
      async getFileHandle(name: string) {
        const file = recordingFile();
        files.set(name, file);
        return file.handle;
      },
      async removeEntry(name: string) {
        removed.push(name);
        files.delete(name);
      },
      async *keys() {
        yield "old-export.mp4";
      },
    };
    const downloads: { blob: Blob; name: string }[] = [];
    const destination = await chooseDestination(
      {
        privateRoot: async () => ({ getDirectoryHandle: async () => folder }) as any,
        download: (blob, name) => downloads.push({ blob, name }),
      },
      request,
    );
    // The last export's scratch file is cleared before this one starts.
    expect(removed).toEqual(["old-export.mp4"]);
    destination!.commitOnClose();
    await writeAndClose(destination!.writable, [[0, [4, 2]]]);
    await destination!.deliver();
    expect(downloads.map((d) => d.name)).toEqual(["edit.mp4"]);
    expect([...new Uint8Array(await downloads[0].blob.arrayBuffer())]).toEqual([4, 2]);
  });
});
