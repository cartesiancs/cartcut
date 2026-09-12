import { describe, expect, it } from "vitest";
import { chooseDefaultLocale, sortLocales, type TranscriptionLocale } from "./locale";

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
