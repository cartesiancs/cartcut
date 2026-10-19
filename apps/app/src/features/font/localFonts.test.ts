import { describe, expect, it } from "vitest";
import {
  createLocalFontStore,
  localFaceOf,
  localFontEntries,
  localFontNotice,
  requestLocalFonts,
  restoreLocalFonts,
  statusForError,
  type FontDataLike,
  type LocalFontPermission,
  type LocalFontPort,
  type LocalFontState,
} from "./localFonts";
import { parseFontPath } from "./fontFaces";

function data(
  postscriptName: string,
  family: string,
  style: string,
  fullName = `${family} ${style}`,
): FontDataLike {
  return { postscriptName, family, style, fullName };
}

/** A `DOMException`-shaped rejection, which is all the module reads. */
function failure(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

type FakeOptions = {
  available?: boolean;
  secure?: boolean;
  permission?: LocalFontPermission;
  answer?: () => Promise<FontDataLike[]>;
};

function fakePort(options: FakeOptions = {}) {
  const calls = { query: 0, permission: 0 };
  const port: LocalFontPort = {
    available: () => options.available ?? true,
    secure: () => options.secure ?? true,
    permission: async () => {
      calls.permission += 1;
      return options.permission ?? "prompt";
    },
    query: () => {
      calls.query += 1;
      return options.answer?.() ?? Promise.resolve([data("Inter-Bold", "Inter", "Bold")]);
    },
  };
  return { port, calls };
}

/** A promise the test resolves by hand, to hold a query open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("localFaceOf", () => {
  it("takes the family as given and reads only the style", () => {
    expect(localFaceOf(data("NotoSansKR-Bold", "Noto Sans KR", "Bold"))).toEqual({
      family: "Noto Sans KR",
      weight: 700,
      italic: false,
    });
    expect(localFaceOf(data("ArialMT", "Arial Black", "Regular"))).toEqual({
      family: "Arial Black",
      weight: 400,
      italic: false,
    });
  });

  it("keeps a width the style carries with the family", () => {
    expect(localFaceOf(data("HelveticaNeue-CondensedBold", "Helvetica Neue", "Condensed Bold"))).toEqual({
      family: "Helvetica Neue Condensed",
      weight: 700,
      italic: false,
    });
  });

  it("reads a localised style from the postscript suffix instead", () => {
    expect(localFaceOf(data("AppleSDGothicNeo-SemiBold", "Apple SD Gothic Neo", "세미볼드"))).toEqual({
      family: "Apple SD Gothic Neo",
      weight: 600,
      italic: false,
    });
  });

  it("keeps a localised style it cannot read as a family of its own", () => {
    // Folding it into the regular weight would make one of the two unreachable.
    expect(localFaceOf(data("Mystery", "Mystery", "굵게"))).toEqual({
      family: "Mystery 굵게",
      weight: 400,
      italic: false,
    });
  });

  it("gives nothing for a face with no family", () => {
    expect(localFaceOf(data("Orphan-Bold", "", "Bold"))).toBeNull();
  });
});

describe("localFontEntries", () => {
  it("makes entries whose three fields agree with what a clip stores", () => {
    const [entry] = localFontEntries([data("Inter-Bold", "Inter", "Bold", "Inter Bold")]);
    expect(entry).toEqual({
      path: "local:Inter-Bold",
      name: "Inter-Bold",
      type: "local",
      face: { family: "Inter", weight: 700, italic: false },
      label: "Inter Bold",
    });
    // The path alone gives back the same name and type, which is what a
    // project opened later has to work from.
    const parsed = parseFontPath(entry.path);
    expect(parsed).toEqual({ path: entry.path, name: entry.name, type: entry.type });
  });

  it("lists a face installed twice once, keeping the first", () => {
    const entries = localFontEntries([
      data("Inter-Bold", "Inter", "Bold", "first"),
      data("Inter-Bold", "Inter", "Bold", "second"),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe("first");
  });

  it("drops names that would break a font string or are not meant to be chosen", () => {
    const entries = localFontEntries([
      data("", "Empty", "Regular"),
      data('Quote"Face', "Quote", "Regular"),
      data("Back\\slash", "Back", "Regular"),
      data("Tab\tFace", "Tab", "Regular"),
      data("X".repeat(128), "Long", "Regular"),
      data(".SFNS-Regular", "System Font", "Regular"),
      data("Hidden-Regular", ".Hidden", "Regular"),
      data("Kept-Regular", "Kept", "Regular"),
      null as unknown as FontDataLike,
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(["Kept-Regular"]);
  });

  it("orders the list the same way whatever order it arrived in", () => {
    const list = [
      data("Zapfino", "Zapfino", "Regular"),
      data("Arial-BoldMT", "Arial", "Bold"),
      data("ArialMT", "Arial", "Regular"),
    ];
    const forward = localFontEntries(list).map((entry) => entry.name);
    const backward = localFontEntries([...list].reverse()).map((entry) => entry.name);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(["Arial-BoldMT", "ArialMT", "Zapfino"]);
  });

  it("names a face by its postscript name when the browser gave no full name", () => {
    const [entry] = localFontEntries([
      { postscriptName: "Plain-Regular", family: "Plain", style: "Regular" },
    ]);
    expect(entry.label).toBe("Plain-Regular");
  });
});

describe("statusForError", () => {
  it("tells a refusal from a missing gesture from a policy", () => {
    expect(statusForError(failure("NotAllowedError"), true)).toBe("denied");
    expect(statusForError(failure("NotAllowedError"), false)).toBe("denied");
    expect(statusForError(failure("SecurityError"), false)).toBe("needs-permission");
    expect(statusForError(failure("SecurityError"), true)).toBe("blocked");
    expect(statusForError(new Error("boom"), true)).toBe("error");
    expect(statusForError(undefined, false)).toBe("error");
  });
});

describe("restoreLocalFonts", () => {
  it("loads the list without asking when the permission is granted", async () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort({ permission: "granted" });
    await restoreLocalFonts(port, store);
    expect(calls.query).toBe(1);
    expect(store.getState().status).toBe("ready");
    expect(store.getState().fonts.map((entry) => entry.name)).toEqual(["Inter-Bold"]);
  });

  it("never queries without a grant, since that would be a prompt nobody clicked for", async () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort({ permission: "prompt" });
    await restoreLocalFonts(port, store);
    expect(calls.query).toBe(0);
    expect(store.getState().status).toBe("needs-permission");
  });

  it("offers the button when the permission's state is unknown", async () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort({ permission: "unknown" });
    await restoreLocalFonts(port, store);
    expect(calls.query).toBe(0);
    expect(store.getState().status).toBe("needs-permission");
  });

  it("reports a refusal the site settings hold", async () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort({ permission: "denied" });
    await restoreLocalFonts(port, store);
    expect(calls.query).toBe(0);
    expect(store.getState().status).toBe("denied");
  });

  it("falls back to the button when the browser wants a gesture even after a grant", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({
      permission: "granted",
      answer: () => Promise.reject(failure("SecurityError")),
    });
    await restoreLocalFonts(port, store);
    expect(store.getState()).toMatchObject({
      status: "needs-permission",
      permission: "granted",
    });
  });

  it("says why when the API is missing or the page is not secure", async () => {
    const missing = createLocalFontStore();
    await restoreLocalFonts(fakePort({ available: false }).port, missing);
    expect(missing.getState()).toMatchObject({ status: "unsupported", reason: "no-api" });

    // Chrome hides the API on plain http, so insecure wins over missing.
    const insecure = createLocalFontStore();
    await restoreLocalFonts(fakePort({ available: false, secure: false }).port, insecure);
    expect(insecure.getState()).toMatchObject({ status: "unsupported", reason: "insecure" });
  });
});

describe("requestLocalFonts", () => {
  it("has called the query by the time it returns, before anything is awaited", () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort();
    const running = requestLocalFonts(port, store);
    expect(calls.query).toBe(1);
    expect(store.getState().status).toBe("loading");
    return running;
  });

  it("fills the list and records the grant", async () => {
    const store = createLocalFontStore();
    await requestLocalFonts(fakePort().port, store);
    expect(store.getState()).toMatchObject({ status: "ready", permission: "granted" });
  });

  it("records a refusal", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ answer: () => Promise.reject(failure("NotAllowedError")) });
    await requestLocalFonts(port, store);
    expect(store.getState()).toMatchObject({ status: "denied", permission: "denied" });
  });

  it("reads an empty answer under a denied permission as the refusal Chrome means by it", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ permission: "denied", answer: () => Promise.resolve([]) });
    await requestLocalFonts(port, store);
    expect(store.getState()).toMatchObject({ status: "denied", permission: "denied" });
  });

  it("offers the button again when the prompt was dismissed and the list came back empty", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ permission: "prompt", answer: () => Promise.resolve([]) });
    await requestLocalFonts(port, store);
    expect(store.getState()).toMatchObject({ status: "needs-permission", permission: "prompt" });
  });

  it("calls an empty answer under a grant a list with nothing in it", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ permission: "granted", answer: () => Promise.resolve([]) });
    await requestLocalFonts(port, store);
    expect(store.getState()).toMatchObject({ status: "ready", fonts: [] });
  });

  it("reads a SecurityError after a click as a policy, not a missing gesture", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ answer: () => Promise.reject(failure("SecurityError")) });
    await requestLocalFonts(port, store);
    expect(store.getState().status).toBe("blocked");
  });

  it("treats a query that throws instead of rejecting the same way", async () => {
    const store = createLocalFontStore();
    const port: LocalFontPort = {
      ...fakePort().port,
      query: () => {
        throw failure("NotAllowedError");
      },
    };
    await requestLocalFonts(port, store);
    expect(store.getState().status).toBe("denied");
  });

  it("asks once when a click lands while a query is still running", async () => {
    const store = createLocalFontStore();
    const held = deferred<FontDataLike[]>();
    const { port, calls } = fakePort({ answer: () => held.promise });
    const first = requestLocalFonts(port, store);
    const second = requestLocalFonts(port, store);
    expect(calls.query).toBe(1);
    held.resolve([data("Inter-Bold", "Inter", "Bold")]);
    await Promise.all([first, second]);
    expect(store.getState().status).toBe("ready");
  });

  it("is joined by a restore that finishes reading the permission while it runs", async () => {
    const store = createLocalFontStore();
    const held = deferred<FontDataLike[]>();
    const { port, calls } = fakePort({ permission: "granted", answer: () => held.promise });
    const restoring = restoreLocalFonts(port, store);
    const clicked = requestLocalFonts(port, store);
    held.resolve([data("Inter-Bold", "Inter", "Bold")]);
    await Promise.all([restoring, clicked]);
    expect(calls.query).toBe(1);
    expect(store.getState().status).toBe("ready");
  });

  it("can ask again once a query has finished", async () => {
    const store = createLocalFontStore();
    const { port, calls } = fakePort();
    await requestLocalFonts(port, store);
    await requestLocalFonts(port, store);
    expect(calls.query).toBe(2);
  });

  it("does not wake subscribers for a write that changes nothing", async () => {
    const store = createLocalFontStore();
    const { port } = fakePort({ available: false });
    await requestLocalFonts(port, store);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    await requestLocalFonts(port, store);
    expect(notified).toBe(0);
  });
});

describe("localFontNotice", () => {
  const state = (patch: Partial<LocalFontState>): LocalFontState => ({
    status: "idle",
    reason: null,
    permission: "unknown",
    fonts: [],
    ...patch,
  });

  it("says nothing before the restore has answered, or once there is a list", () => {
    expect(localFontNotice(state({ status: "idle" }))).toBeNull();
    expect(
      localFontNotice(
        state({ status: "ready", fonts: [parseFontPath("local:Inter-Bold")] }),
      ),
    ).toBeNull();
  });

  it("offers the button only where a click can help", () => {
    const actionOf = (patch: Partial<LocalFontState>) =>
      localFontNotice(state(patch))?.action?.kind ?? null;
    expect(actionOf({ status: "needs-permission" })).toBe("request");
    expect(actionOf({ status: "denied" })).toBe("retry");
    expect(actionOf({ status: "error" })).toBe("retry");
    expect(actionOf({ status: "loading" })).toBeNull();
    expect(actionOf({ status: "blocked" })).toBeNull();
    expect(actionOf({ status: "unsupported", reason: "no-api" })).toBeNull();
  });

  it("names the browser or the connection, whichever is missing", () => {
    expect(localFontNotice(state({ status: "unsupported", reason: "no-api" }))?.message).toMatch(
      /Chrome or Edge/,
    );
    expect(localFontNotice(state({ status: "unsupported", reason: "insecure" }))?.message).toMatch(
      /https/,
    );
  });

  it("says so when the browser listed nothing", () => {
    expect(localFontNotice(state({ status: "ready", fonts: [] }))?.message).toMatch(/no fonts/);
  });
});
