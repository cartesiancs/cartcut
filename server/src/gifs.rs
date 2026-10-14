//! The GIF library: `content/gifs/*.gif`, paged and searched in memory.
//!
//! A GIF is one file and nothing else. Its name is its tags, split on `_`:
//! `웃음_미소_smile.gif` is found by 웃음, 미소 and smile, and is shown as
//! "웃음 미소 smile". So adding a GIF is copying a file into the folder and
//! sending the server SIGHUP.
//!
//! GIFs are the one kind not listed whole under `/v1/catalog`: there are a
//! thousand of them and the app shows a page at a time. A search is a linear
//! scan over a thousand short word lists, which is microseconds.

use std::collections::HashMap;

use hyper::body::Bytes;
use serde_json::json;
use sha2::{Digest, Sha256};

/// The most a page holds, whatever the client asks for.
pub const MAX_LIMIT: usize = 100;
pub const DEFAULT_LIMIT: usize = 48;
/// Words in one search. A longer query is cut, not refused.
const MAX_TOKENS: usize = 8;
/// Characters of `q` read. A longer query is cut, not refused.
const MAX_QUERY_CHARS: usize = 100;

/// One GIF as the catalog found it.
pub struct GifSource {
    pub id: String,
    /// The file name, `.gif` included: the path it is served at.
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
}

struct Entry {
    id: String,
    json: Bytes,
    terms: Vec<String>,
}

/// A `/v1/gifs` request, already parsed and bounded.
pub struct GifQuery {
    pub tokens: Vec<String>,
    pub cursor: usize,
    pub limit: usize,
}

impl Default for GifQuery {
    fn default() -> GifQuery {
        GifQuery {
            tokens: Vec::new(),
            cursor: 0,
            limit: DEFAULT_LIMIT,
        }
    }
}

#[derive(Default)]
pub struct GifIndex {
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    rev: String,
}

/// Hangul jamo composed into syllables, the one part of NFC that matters here.
///
/// A file named in Finder can arrive decomposed (`ㅇ` `ㅜ` `ㅅ` rather than
/// `웃`), and would then never equal the word someone types. Composing Hangul
/// is arithmetic (Unicode 3.12), so it needs no normalisation crate; other
/// scripts are left as they are.
pub fn compose_hangul(text: &str) -> String {
    const S_BASE: u32 = 0xAC00;
    const L_BASE: u32 = 0x1100;
    const V_BASE: u32 = 0x1161;
    const T_BASE: u32 = 0x11A7;
    const L_COUNT: u32 = 19;
    const V_COUNT: u32 = 21;
    const T_COUNT: u32 = 28;

    let mut out: Vec<char> = Vec::with_capacity(text.len());
    for c in text.chars() {
        let code = c as u32;
        if let Some(&last) = out.last() {
            let last = last as u32;
            // A leading consonant and a vowel make an LV syllable.
            if (L_BASE..L_BASE + L_COUNT).contains(&last)
                && (V_BASE..V_BASE + V_COUNT).contains(&code)
            {
                let syllable = S_BASE + ((last - L_BASE) * V_COUNT + (code - V_BASE)) * T_COUNT;
                *out.last_mut().unwrap() = char::from_u32(syllable).unwrap_or(c);
                continue;
            }
            // An LV syllable and a trailing consonant make an LVT syllable.
            if (S_BASE..S_BASE + L_COUNT * V_COUNT * T_COUNT).contains(&last)
                && (last - S_BASE) % T_COUNT == 0
                && (T_BASE + 1..T_BASE + T_COUNT).contains(&code)
            {
                *out.last_mut().unwrap() = char::from_u32(last + (code - T_BASE)).unwrap_or(c);
                continue;
            }
        }
        out.push(c);
    }
    out.into_iter().collect()
}

/// How a word is compared: Hangul composed, lower case, and the `#` and `:`
/// people type around a tag (`#fire`, `:fire:`) taken off.
pub fn normalize_word(raw: &str) -> String {
    compose_hangul(raw.trim().trim_matches(|c| c == '#' || c == ':').trim()).to_lowercase()
}

/// A search string as the words every result has to match.
pub fn tokens_of(q: &str) -> Vec<String> {
    let cut: String = q.chars().take(MAX_QUERY_CHARS).collect();
    cut.split_whitespace()
        .map(normalize_word)
        .filter(|word| !word.is_empty())
        .take(MAX_TOKENS)
        .collect()
}

/// A file name's tags: the stem split on `_`, each normalised, each once.
pub fn tags_of(stem: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for part in stem.split('_') {
        let tag = normalize_word(part);
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

/// The id a GIF is downloaded and installed under: its name, hashed.
///
/// Not the name itself, which is Korean as often as not: an id becomes a
/// folder name and a URL segment on every platform the app runs on, and the
/// app accepts ASCII ids only. Hashing the composed name keeps it stable for
/// as long as the name is, and a renamed GIF (new tags) is a new GIF.
pub fn id_of(stem: &str) -> String {
    let digest = Sha256::digest(compose_hangul(stem).as_bytes());
    format!("g{:x}", digest)[..17].to_owned()
}

impl GifIndex {
    /// `sources` in the order the GIFs are listed: by name.
    pub fn build(sources: Vec<GifSource>) -> GifIndex {
        let mut hasher = Sha256::new();
        let mut entries = Vec::with_capacity(sources.len());
        for source in sources {
            let stem = source.file.strip_suffix(".gif").unwrap_or(&source.file);
            let tags = tags_of(stem);
            let name = compose_hangul(&stem.replace('_', " ")).trim().to_owned();
            let mut terms = tags.clone();
            for tag in &tags {
                for word in tag.split_whitespace() {
                    terms.push(word.to_owned());
                }
            }
            terms.sort();
            terms.dedup();

            hasher.update(source.id.as_bytes());
            hasher.update(b":");
            hasher.update(source.sha256.as_bytes());
            hasher.update(b"\n");

            let json = json!({
                "id": source.id,
                "kind": "gif",
                "name": name,
                "tags": tags,
                "file": source.file,
                "files": [{ "path": source.file, "bytes": source.bytes, "sha256": source.sha256 }],
                "bytes": source.bytes,
            });
            entries.push(Entry {
                id: source.id,
                json: Bytes::from(json.to_string()),
                terms,
            });
        }
        let by_id = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.id.clone(), index))
            .collect();
        let rev = format!("{:x}", hasher.finalize())[..16].to_owned();
        GifIndex {
            entries,
            by_id,
            rev,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn item(&self, id: &str) -> Option<Bytes> {
        self.by_id
            .get(id)
            .map(|&index| self.entries[index].json.clone())
    }

    /// One page of what `query` matches, in name order, with the GIFs where a
    /// search word is a whole tag ahead of those it only starts.
    pub fn page(&self, query: &GifQuery) -> Bytes {
        let mut matched: Vec<(usize, usize)> = Vec::new();
        for (index, entry) in self.entries.iter().enumerate() {
            if let Some(score) = score(&entry.terms, &query.tokens) {
                matched.push((score, index));
            }
        }
        // Stable, so equal scores keep name order.
        matched.sort_by_key(|&(score, _)| score);

        let total = matched.len();
        let start = query.cursor.min(total);
        let end = (start + query.limit).min(total);

        let mut body = Vec::with_capacity(64 + (end - start) * 256);
        body.extend_from_slice(b"{\"items\":[");
        for (position, &(_, index)) in matched[start..end].iter().enumerate() {
            if position > 0 {
                body.push(b',');
            }
            body.extend_from_slice(&self.entries[index].json);
        }
        body.extend_from_slice(b"],\"next\":");
        if end < total {
            body.extend_from_slice(format!("\"{end}\"").as_bytes());
        } else {
            body.extend_from_slice(b"null");
        }
        body.extend_from_slice(format!(",\"total\":{total},\"rev\":\"{}\"}}", self.rev).as_bytes());
        Bytes::from(body)
    }
}

/// `None` when some word matches nothing; otherwise how many words only
/// start a term rather than being one.
fn score(terms: &[String], tokens: &[String]) -> Option<usize> {
    let mut partial = 0;
    for token in tokens {
        if terms.iter().any(|term| term == token) {
            continue;
        }
        if terms.iter().any(|term| term.starts_with(token.as_str())) {
            partial += 1;
            continue;
        }
        return None;
    }
    Some(partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_its_tags() {
        assert_eq!(tags_of("Fire_불_불꽃__fire"), vec!["fire", "불", "불꽃"]);
        assert_eq!(tags_of("thumbs up_좋아요"), vec!["thumbs up", "좋아요"]);
    }

    #[test]
    fn decomposed_hangul_is_composed() {
        // 웃음 as Finder can write it: six jamo.
        let decomposed = "\u{110B}\u{116E}\u{11BA}\u{110B}\u{1173}\u{11B7}";
        assert_eq!(compose_hangul(decomposed), "웃음");
        assert_eq!(id_of(decomposed), id_of("웃음"));
        assert_eq!(compose_hangul("smile 웃음"), "smile 웃음");
    }

    #[test]
    fn a_word_loses_its_hash_and_colons_and_its_case() {
        assert_eq!(tokens_of("  #불  :HEART:  "), vec!["불", "heart"]);
        assert_eq!(tokens_of(&"a ".repeat(20)).len(), MAX_TOKENS);
    }

    #[test]
    fn every_word_has_to_start_some_term() {
        let terms: Vec<String> = ["face", "grinning", "웃음"].map(String::from).to_vec();
        assert_eq!(score(&terms, &["grin".into()]), Some(1));
        assert_eq!(score(&terms, &["face".into()]), Some(0));
        assert_eq!(score(&terms, &["웃".into(), "face".into()]), Some(1));
        assert_eq!(score(&terms, &["웃".into(), "cat".into()]), None);
        assert_eq!(score(&terms, &[]), Some(0));
    }
}
