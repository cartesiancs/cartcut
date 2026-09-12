/**
 * Which transcription language to offer first.
 *
 * Here, rather than in the auto-caption panel, because `apps/automatic-caption`
 * is outside every vitest include pattern and this is a rule worth pinning: the
 * first version matched only the language subtag and took the first hit, which
 * on this machine offered **South African English** to a user whose app is in
 * `en-US` — a list the OS returns in no particular order, and a wrong answer
 * that looks plausible enough to ship.
 */

export type TranscriptionLocale = {
  id: string;
  name: string;
  installed: boolean;
};

/**
 * The best of `available` for a user who prefers `preferences`, in order.
 *
 * Exact region match first, walking the user's own preference order — `en-US`
 * beats `en-GB` for an American, and a Korean user whose OS is in English still
 * gets `ko-KR` offered ahead of an English variant they do not want if Korean
 * ranks higher for them.
 *
 * Failing that, the same language in **any** region, preferring one already
 * installed: a region is a smaller mistake than a language, and an installed
 * model is the difference between starting now and waiting for a download.
 */
export function chooseDefaultLocale(
  available: TranscriptionLocale[],
  preferences: readonly string[],
): string {
  if (available.length === 0) {
    return "";
  }

  const ids = new Set(available.map((locale) => locale.id));
  const wanted = preferences.filter((preference) => preference.length > 0);

  for (const preference of wanted) {
    if (ids.has(preference)) {
      return preference;
    }
  }

  for (const preference of wanted) {
    const language = languageOf(preference);
    const sameLanguage = available.filter(
      (locale) => languageOf(locale.id) === language,
    );
    const best = sameLanguage.find((locale) => locale.installed) ?? sameLanguage[0];
    if (best != null) {
      return best.id;
    }
  }

  return (available.find((locale) => locale.installed) ?? available[0]).id;
}

/**
 * Installed first, then alphabetically by name.
 *
 * The list arrives in whatever order the OS enumerated it, which puts `en-ZA`
 * above `en-US` and reads as random in a dropdown. Installed first because
 * those are the ones that cost no wait.
 */
export function sortLocales(
  available: TranscriptionLocale[],
): TranscriptionLocale[] {
  return [...available].sort((a, b) => {
    if (a.installed !== b.installed) {
      return a.installed ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function languageOf(identifier: string): string {
  return identifier.split("-")[0].toLowerCase();
}
