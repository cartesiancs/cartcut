import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WILL_EXPORT_TIMEOUT_MS,
  announceDidExport,
  askWillExport,
  readVetoes,
  setExportHookPorts,
  vetoMessage,
} from "./exportHooks";

afterEach(() => {
  setExportHookPorts(null);
});

describe("readVetoes", () => {
  it("takes only the entries that actually objected", () => {
    // Most listeners answer nothing. An export must not be stopped by a
    // listener that simply returned.
    expect(
      readVetoes([null, undefined, {}, { extId: "a.one" }, { extId: "b.two", veto: "not ready" }]),
    ).toEqual([{ extId: "b.two", reason: "not ready" }]);
  });

  it("survives an answer that is not a list", () => {
    // It arrives from another process. A throw here would take the export.
    for (const value of [null, undefined, "no", 42, {}]) {
      expect([String(value), readVetoes(value)]).toEqual([String(value), []]);
    }
  });

  it("ignores an empty reason, because a veto has to say why", () => {
    expect(readVetoes([{ extId: "a.one", veto: "   " }])).toEqual([]);
  });

  it("caps the reason, which ends up in a toast", () => {
    const [veto] = readVetoes([{ extId: "a.one", veto: "x".repeat(900) }]);
    expect(veto.reason.length).toBe(300);
  });

  it("names an anonymous objector rather than dropping it", () => {
    expect(readVetoes([{ veto: "no" }])[0].extId).toBe("an extension");
  });
});

describe("vetoMessage", () => {
  it("is empty when nothing objected", () => {
    expect(vetoMessage([])).toBe("");
  });

  it("reads back one reason unchanged", () => {
    expect(vetoMessage([{ extId: "a.one", reason: "Captions are untranslated." }])).toBe(
      "Captions are untranslated.",
    );
  });

  it("joins several", () => {
    expect(
      vetoMessage([
        { extId: "a.one", reason: "One." },
        { extId: "b.two", reason: "Two." },
      ]),
    ).toBe("One. Two.");
  });
});

describe("askWillExport", () => {
  it("answers no objection when no host is connected", () => {
    return expect(askWillExport({})).resolves.toEqual({ vetoes: [] });
  });

  it("passes the vetoes through", async () => {
    setExportHookPorts({
      ask: async () => [{ extId: "a.one", veto: "not ready" }],
    });
    await expect(askWillExport({})).resolves.toEqual({
      vetoes: [{ extId: "a.one", reason: "not ready" }],
    });
  });

  it("treats a failing host as no objection", async () => {
    // An extension loses its veto by being broken. The user does not lose
    // their export.
    setExportHookPorts({
      ask: () => Promise.reject(new Error("host is gone")),
    });
    await expect(askWillExport({})).resolves.toEqual({ vetoes: [] });
  });

  it("gives every extension together one bounded window", async () => {
    let asked = 0;
    setExportHookPorts({
      ask: (_method, _params, timeoutMs) => {
        asked = timeoutMs;
        return Promise.resolve([]);
      },
    });
    await askWillExport({});
    expect(asked).toBe(WILL_EXPORT_TIMEOUT_MS);
  });
});

describe("announceDidExport", () => {
  it("tells the host and does not wait", () => {
    const ask = vi.fn(() => Promise.resolve(null));
    setExportHookPorts({ ask });
    announceDidExport("/tmp/out.mp4", { container: "mp4" });
    expect(ask).toHaveBeenCalledWith(
      "export.didExport",
      { path: "/tmp/out.mp4", settings: { container: "mp4" } },
      expect.any(Number),
    );
  });

  it("swallows a rejection rather than leaving one unhandled", async () => {
    setExportHookPorts({ ask: () => Promise.reject(new Error("gone")) });
    expect(() => announceDidExport("/tmp/out.mp4", {})).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does nothing at all when no host is connected", () => {
    expect(() => announceDidExport("/tmp/out.mp4", {})).not.toThrow();
  });
});
