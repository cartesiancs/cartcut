import { describe, expect, it } from "vitest";
import {
  applyLocales,
  chooseDefaultLocale,
  localeLabel,
  sortLocales,
  type TranscriptionLocale,
} from "./locale";

/** The real shape and ordering macOS 26 returned on the machine this was built on. */
const AVAILABLE: TranscriptionLocale[] = [
  { id: "en-ZA", name: "English (South Africa)", installed: true },
  { id: "en-CA", name: "English (Canada)", installed: true },
  { id: "en-US", name: "English (United States)", installed: true },
  { id: "en-GB", name: "English (United Kingdom)", installed: true },
  { id: "ko-KR", name: "한국어(대한민국)", installed: true },
  { id: "fr-FR", name: "français (France)", installed: false },
  { id: "de-DE", name: "Deutsch (Deutschland)", installed: false },
];

describe("chooseDefaultLocale", () => {
  it("takes the exact region, not merely the language", () => {
    // The defect this module exists for: `en-ZA` sorts first in the OS list, so
    // matching on "en" alone offered South African English to an en-US user.
    expect(chooseDefaultLocale(AVAILABLE, ["en-US", "en-KR", "ko-KR"])).toBe("en-US");
  });

  it("honours the order the user ranked their languages in", () => {
    expect(chooseDefaultLocale(AVAILABLE, ["ko-KR", "en-US"])).toBe("ko-KR");
  });

  it("falls back to the same language in another region", () => {
    expect(chooseDefaultLocale(AVAILABLE, ["en-AU"])).toMatch(/^en-/);
  });

  it("prefers an installed region over one that would download", () => {
    const available: TranscriptionLocale[] = [
      { id: "pt-PT", name: "português (Portugal)", installed: false },
      { id: "pt-BR", name: "português (Brasil)", installed: true },
    ];
    expect(chooseDefaultLocale(available, ["pt-AO"])).toBe("pt-BR");
  });

  it("prefers an exact match even when it is not installed", () => {
    // A region the user actually asked for beats a download they did not: the
    // wrong language is a worse outcome than a wait, and the wait happens once.
    const available: TranscriptionLocale[] = [
      { id: "en-US", name: "English (United States)", installed: true },
      { id: "de-DE", name: "Deutsch (Deutschland)", installed: false },
    ];
    expect(chooseDefaultLocale(available, ["de-DE"])).toBe("de-DE");
  });

  it("falls back to something installed when no language matches", () => {
    expect(chooseDefaultLocale(AVAILABLE, ["ja-JP"])).toBe("en-ZA");
  });

  it("answers empty for an empty list rather than throwing", () => {
    expect(chooseDefaultLocale([], ["en-US"])).toBe("");
  });

  it("ignores empty preference entries", () => {
    expect(chooseDefaultLocale(AVAILABLE, ["", "ko-KR"])).toBe("ko-KR");
  });
});

describe("sortLocales", () => {
  it("puts installed languages first, then orders by name", () => {
    const sorted = sortLocales(AVAILABLE);
    const installedCount = AVAILABLE.filter((l) => l.installed).length;

    expect(sorted.slice(0, installedCount).every((l) => l.installed)).toBe(true);
    expect(sorted.slice(installedCount).every((l) => !l.installed)).toBe(true);
    expect(sorted[0].name.localeCompare(sorted[1].name)).toBeLessThanOrEqual(0);
  });

  it("does not mutate its input", () => {
    const before = AVAILABLE.map((l) => l.id);
    sortLocales(AVAILABLE);
    expect(AVAILABLE.map((l) => l.id)).toEqual(before);
  });
});

describe("localeLabel", () => {
  it("names an installed locale and nothing more", () => {
    expect(localeLabel(AVAILABLE[0])).toBe("English (South Africa)");
  });

  it("warns that an uninstalled one downloads, once", () => {
    // The download happens once per language and the model stays on the Mac, so
    // the note is "once" rather than a size or a warning.
    expect(localeLabel({ id: "fr-FR", name: "français (France)", installed: false }))
      .toBe("français (France) (downloads once)");
  });
});

describe("applyLocales", () => {
  const ok = { available: true, locales: AVAILABLE, reason: "" };

  it("sorts the list before choosing from it", () => {
    // The load-bearing ordering. `chooseDefaultLocale`'s region fallback and its
    // last resort both read array order, so choosing from the OS's own ordering
    // — which puts en-ZA first — reintroduces the defect this module exists for.
    const { locales, selectedLocale } = applyLocales(ok, ["en-AU"]);

    expect(locales).toEqual(sortLocales(AVAILABLE));
    expect(selectedLocale).toBe(chooseDefaultLocale(sortLocales(AVAILABLE), ["en-AU"]));
  });

  it("picks a different region than the unsorted list would, for an uninstalled language", () => {
    // Proof the sort is load-bearing rather than cosmetic. `chooseDefaultLocale`
    // prefers an *installed* region, so order only decides when none of them is
    // — and then it takes `sameLanguage[0]`. Two uninstalled French regions,
    // enumerated by the OS with France first and named so that Canada sorts
    // first: the unsorted list answers fr-FR and the sorted one fr-CA.
    const raw: TranscriptionLocale[] = [
      { id: "fr-FR", name: "zz français (France)", installed: false },
      { id: "fr-CA", name: "aa français (Canada)", installed: false },
    ];

    expect(chooseDefaultLocale(raw, ["fr-CH"])).toBe("fr-FR");
    expect(applyLocales({ available: true, locales: raw }, ["fr-CH"]).selectedLocale)
      .toBe("fr-CA");
  });

  it("picks a different language than the unsorted list would, when nothing matches", () => {
    // The other order-dependent branch: no preference shares a language with
    // anything available and nothing is installed, so the answer is
    // `available[0]` — which is whatever the OS happened to enumerate first.
    const raw: TranscriptionLocale[] = [
      { id: "de-DE", name: "zz Deutsch", installed: false },
      { id: "ja-JP", name: "aa 日本語", installed: false },
    ];

    expect(chooseDefaultLocale(raw, ["pt-BR"])).toBe("de-DE");
    expect(applyLocales({ available: true, locales: raw }, ["pt-BR"]).selectedLocale)
      .toBe("ja-JP");
  });

  it("keeps apple when the recogniser is available", () => {
    expect(applyLocales(ok, ["en-US"]).method).toBe("apple");
    expect(applyLocales(ok, ["en-US"]).available).toBe(true);
  });

  it("forces openai when it is not", () => {
    // Leaving this at apple would transcribe through OpenAI while the On-device
    // button still rendered as the selected one — its styling keys on `method`,
    // not on availability.
    const result = applyLocales(
      { available: false, locales: [], reason: "requires macOS 26" },
      ["en-US"],
    );

    expect(result.method).toBe("openai");
    expect(result.reason).toBe("requires macOS 26");
    expect(result.selectedLocale).toBe("");
  });

  it("treats anything but a literal true as unavailable", () => {
    // It crosses IPC. A truthy-but-not-true value must not unlock on-device.
    for (const available of ["yes", 1, {}, null, undefined]) {
      expect(applyLocales({ available, locales: AVAILABLE }, ["en-US"]).method)
        .toBe("openai");
    }
  });

  it("survives a payload with nothing in it", () => {
    // The web build has no main process behind the bridge, and a rejected
    // `invoke` resolves to undefined.
    for (const payload of [undefined, null, {}, "nonsense", 42]) {
      expect(applyLocales(payload, ["en-US"])).toEqual({
        available: false,
        reason: "",
        locales: [],
        selectedLocale: "",
        method: "openai",
      });
    }
  });

  it("ignores a locales field that is not a list", () => {
    expect(applyLocales({ available: true, locales: "en-US" }, ["en-US"]).locales)
      .toEqual([]);
  });

  it("ignores a reason that is not a string", () => {
    expect(applyLocales({ available: false, reason: { why: "no" } }, []).reason)
      .toBe("");
  });

  it("does not mutate the list it was handed", () => {
    const raw = [...AVAILABLE];
    applyLocales({ available: true, locales: raw }, ["en-US"]);
    expect(raw).toEqual(AVAILABLE);
  });
});
