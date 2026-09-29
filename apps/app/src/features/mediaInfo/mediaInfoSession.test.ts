import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaInfoResult } from "../../../../../electron/lib/mediaInfo";
import {
  canShowMediaInfo,
  isMediaInfoResult,
  loadMediaInfo,
  type MediaInfoPort,
} from "./mediaInfoSession";
import type { InfoKind, InfoTarget } from "./mediaInfoView";

const READY: MediaInfoResult = {
  ok: true,
  info: { durationMs: 1000, bitRate: null, video: null, audio: [] },
};

function port(fields: Partial<MediaInfoPort> = {}): MediaInfoPort {
  return {
    probe: vi.fn(async () => READY),
    imageSize: vi.fn(async () => ({ width: 3024, height: 4032 })),
    reveal: vi.fn(),
    copy: vi.fn(async () => {}),
    ...fields,
  };
}

function target(kind: InfoKind): InfoTarget {
  return {
    kind,
    name: "a",
    fsPath: "/Users/me/a",
    localpath: "file:///Users/me/a",
    reversedCopy: null,
  };
}

describe("loadMediaInfo", () => {
  it("asks ffprobe about the OS path", async () => {
    const fake = port();
    await expect(loadMediaInfo(fake, target("video"))).resolves.toEqual({
      result: READY,
      shown: null,
    });
    expect(fake.probe).toHaveBeenCalledWith("/Users/me/a");
  });

  it("measures a photo, and only a photo", async () => {
    for (const kind of ["video", "gif", "audio"] as const) {
      const fake = port();
      await loadMediaInfo(fake, target(kind));
      expect(fake.imageSize).not.toHaveBeenCalled();
    }

    const fake = port();
    await expect(loadMediaInfo(fake, target("image"))).resolves.toEqual({
      result: READY,
      shown: { width: 3024, height: 4032 },
    });
    expect(fake.imageSize).toHaveBeenCalledWith("file:///Users/me/a");
  });

  it("loses only the measurement when the photo will not decode", async () => {
    for (const imageSize of [
      vi.fn(async () => {
        throw new Error("decode");
      }),
      vi.fn(() => {
        throw new Error("sync");
      }),
      vi.fn(async () => ({ width: 0, height: 10 })),
      vi.fn(async () => ({ width: Number.NaN, height: 10 })),
      vi.fn(async () => undefined as never),
    ]) {
      await expect(
        loadMediaInfo(port({ imageSize }), target("image")),
      ).resolves.toEqual({ result: READY, shown: null });
    }
  });

  it("turns a failed or garbled probe into unreadable, never a rejection", async () => {
    const unreadable = { ok: false, reason: "unreadable" };

    for (const probe of [
      vi.fn(async () => {
        throw new Error("ipc");
      }),
      vi.fn(() => {
        throw new Error("sync");
      }),
      vi.fn(async () => undefined),
      vi.fn(async () => ({ ok: true })),
      vi.fn(async () => ({ ok: true, info: { video: null, audio: "x" } })),
      vi.fn(async () => ({ ok: false, reason: "weird" })),
    ]) {
      const loaded = await loadMediaInfo(port({ probe }), target("video"));
      expect(loaded.result).toEqual(unreadable);
    }
  });

  it("passes a stated failure through", async () => {
    const missing = { ok: false, reason: "missing" };
    const loaded = await loadMediaInfo(
      port({ probe: vi.fn(async () => missing) }),
      target("video"),
    );
    expect(loaded.result).toEqual(missing);
  });
});

describe("isMediaInfoResult", () => {
  it("accepts what main sends", () => {
    expect(isMediaInfoResult(READY)).toBe(true);
    expect(
      isMediaInfoResult({
        ok: true,
        info: { durationMs: null, bitRate: null, video: {}, audio: [{}] },
      }),
    ).toBe(true);
    for (const reason of ["missing", "unreadable", "timeout", "invalid"]) {
      expect(isMediaInfoResult({ ok: false, reason })).toBe(true);
    }
  });

  it("refuses anything the view would throw on", () => {
    for (const value of [
      null,
      "ok",
      { ok: true, info: null },
      { ok: true, info: { video: null } },
      { ok: true, info: { video: 3, audio: [] } },
      { ok: true, info: { video: null, audio: [null] } },
      { ok: false },
    ]) {
      expect(isMediaInfoResult(value)).toBe(false);
    }
  });
});

describe("canShowMediaInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false with no window, as under node and in the web build", () => {
    expect(canShowMediaInfo()).toBe(false);
    vi.stubGlobal("window", { electronAPI: { req: { media: {} } } });
    expect(canShowMediaInfo()).toBe(false);
  });

  it("is true when the bridge carries media.info", () => {
    vi.stubGlobal("window", {
      electronAPI: { req: { media: { info: async () => READY } } },
    });
    expect(canShowMediaInfo()).toBe(true);
  });
});
