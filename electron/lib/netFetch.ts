/**
 * Electron's fetch, narrowed to what a downloader needs.
 *
 * `net.fetch` rather than the global one because it honours the system proxy,
 * and a user behind a corporate proxy is exactly the user for whom a large
 * download otherwise fails with nothing useful said. Shared by the speech
 * model download (`tts/tts.ts`) and the cloud content download
 * (`cloud/cloudSession.ts`); both take it as a port, so neither suite has to
 * load Electron.
 */

import { net } from "electron";

/** A response whose body arrives in whatever pieces the transport delivers. */
export type StreamedResponse = {
  ok: boolean;
  status: number;
  chunks: AsyncIterable<Uint8Array>;
};

async function* streamOf(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value != null) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* noChunks(): AsyncIterable<Uint8Array> {}

export async function netFetch(
  url: string,
  signal?: AbortSignal,
): Promise<StreamedResponse> {
  const response = await net.fetch(url, { signal });
  return {
    ok: response.ok,
    status: response.status,
    chunks: response.body == null ? noChunks() : streamOf(response.body),
  };
}
