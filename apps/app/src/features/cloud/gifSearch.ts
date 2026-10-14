/**
 * Searching the GIFs already on disk, by the server's rule.
 *
 * Online, the server searches (`server/src/gifs.rs`); offline, the GIF section
 * shows what is downloaded and filters it here, so a word that finds a GIF
 * online finds it offline too. A GIF's tags are its file name split on `_`;
 * every search word has to start one of them (or a word of one), and a GIF
 * where the word is a whole tag comes first.
 */

import type { CloudItem } from "./cloudTypes";

const MAX_TOKENS = 8;
const MAX_QUERY_CHARS = 100;

export function tokensOf(q: string): string[] {
  return [...q.normalize("NFC")]
    .slice(0, MAX_QUERY_CHARS)
    .join("")
    .split(/\s+/)
    .map((word) => word.replace(/^[#:]+|[#:]+$/g, "").toLowerCase())
    .filter((word) => word !== "")
    .slice(0, MAX_TOKENS);
}

function termsOf(item: CloudItem): string[] {
  const terms: string[] = [];
  for (const tag of item.tags ?? []) {
    terms.push(tag, ...tag.split(/\s+/));
  }
  return terms;
}

/** `null` when some word matches nothing, else how many only start a term. */
function score(terms: string[], tokens: string[]): number | null {
  let partial = 0;
  for (const token of tokens) {
    if (terms.includes(token)) {
      continue;
    }
    if (terms.some((term) => term.startsWith(token))) {
      partial++;
      continue;
    }
    return null;
  }
  return partial;
}

/** The items `q` finds, best first, keeping the given order among equals. */
export function searchGifs(items: readonly CloudItem[], q: string): CloudItem[] {
  const tokens = tokensOf(q);
  if (tokens.length === 0) {
    return [...items];
  }
  const scored: { item: CloudItem; score: number }[] = [];
  for (const item of items) {
    const value = score(termsOf(item), tokens);
    if (value != null) {
      scored.push({ item, score: value });
    }
  }
  // `Array.prototype.sort` is stable, so equal scores keep the given order.
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.item);
}
