//! The content folder, read once at startup.
//!
//! Every file the server will ever send is chosen here. A download is answered
//! by looking `(kind, id, path)` up in the index this builds, never by joining
//! a request path onto the content directory, so no request can name a file
//! this scan did not pick: `..`, an encoded `%2e%2e` and an absolute path all
//! miss the index the way a typo does.
//!
//! The folder rules mirror what the app reads from its own disk
//! (`electron/lib/presetScan.ts`, `electron/lib/templateScan.ts`). The
//! extension lists, the 512 KB cap on a text source and the one level of
//! subfolder inside a preset are copies, because a file the app would drop
//! without a word is a preset that arrives broken.

use std::collections::{HashMap, HashSet};
use std::fs::{self, DirEntry, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use hyper::body::Bytes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// What the server lists. `slug` is the URL segment, `folder` the directory
/// under the content root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Effect,
    Transition,
    Graphic,
    Lut,
    Template,
    Asset,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Effect,
        Kind::Transition,
        Kind::Graphic,
        Kind::Lut,
        Kind::Template,
        Kind::Asset,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Kind::Effect => "effect",
            Kind::Transition => "transition",
            Kind::Graphic => "graphic",
            Kind::Lut => "lut",
            Kind::Template => "template",
            Kind::Asset => "asset",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.slug() == slug)
    }

    fn folder(self) -> &'static str {
        match self {
            Kind::Effect => "effects",
            Kind::Transition => "transitions",
            Kind::Graphic => "graphics",
            Kind::Lut => "luts",
            Kind::Template => "templates",
            Kind::Asset => "assets",
        }
    }
}

/// Read by the app as text: `presetScan.ts#SHADER_EXTENSIONS` and `TEXT_SOURCE_EXTENSIONS`.
const PRESET_TEXT: &[&str] = &["frag", "vert", "glsl", "html", "css", "svg"];
/// Listed by the app as paths: `presetScan.ts#ASSET_EXTENSIONS`.
const PRESET_ASSET: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "cube", "3dl", "woff2", "woff",
    "ttf", "otf",
];
/// `presetScan.ts#MAX_SHADER_BYTES`. The app skips a larger text source, and
/// the manifest that names it then fails validation on the user's machine.
const MAX_TEXT_SOURCE_BYTES: u64 = 512 * 1024;
/// `presetScan.ts#PRESET_SUBDIR_DEPTH`: shaders may sit in one subfolder.
const PRESET_DEPTH: usize = 1;

const VIDEO: &[&str] = &["mp4", "webm", "mov"];
const IMAGE: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const AUDIO: &[&str] = &["mp3", "wav", "m4a", "aac", "ogg", "flac"];
const FONT: &[&str] = &["woff2", "woff", "ttf", "otf"];
const LUT_FILE: &[&str] = &["cube", "3dl"];

/// A template's media sits in subfolders at whatever depth its author chose.
const TEMPLATE_DEPTH: usize = 4;
/// `templateScan.ts#THUMBNAILS`, in its order. A template has no webp.
const TEMPLATE_THUMBNAILS: &[&str] = &["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];
const THUMBNAILS: &[&str] = &[
    "thumbnail.webp",
    "thumbnail.png",
    "thumbnail.jpg",
    "thumbnail.jpeg",
];

const MAX_ID_LEN: usize = 128;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
/// `templateScan.ts#MAX_MANIFEST_BYTES`: the app ignores a larger `template.json`.
const MAX_SIDECAR_BYTES: u64 = 64 * 1024;

/// One file the server may send.
pub struct FileEntry {
    pub path: PathBuf,
    pub bytes: u64,
    pub content_type: &'static str,
}

/// Every listing, pre-serialised, and the index of every file they name.
#[derive(Default)]
pub struct Catalog {
    listings: HashMap<Kind, Bytes>,
    counts: HashMap<Kind, usize>,
    files: HashMap<(Kind, String, String), FileEntry>,
}

impl Catalog {
    pub fn listing(&self, kind: Kind) -> Bytes {
        self.listings.get(&kind).cloned().unwrap_or_default()
    }

    pub fn count(&self, kind: Kind) -> usize {
        self.counts.get(&kind).copied().unwrap_or(0)
    }

    pub fn file(&self, kind: Kind, id: &str, path: &str) -> Option<&FileEntry> {
        self.files.get(&(kind, id.to_owned(), path.to_owned()))
    }
}

struct IndexedFile {
    relative: String,
    absolute: PathBuf,
    bytes: u64,
    sha256: String,
    content_type: &'static str,
}

struct Item {
    id: String,
    name: String,
    json: Value,
    files: Vec<IndexedFile>,
}

/// Scan `root` and build the catalog.
///
/// Never fails. A folder that cannot be served is skipped and named in the
/// returned warnings, so one bad upload cannot take every other item offline.
pub fn load_catalog(root: &Path) -> (Catalog, Vec<String>) {
    let mut catalog = Catalog::default();
    let mut warnings = Vec::new();

    if !root.is_dir() {
        warnings.push(format!(
            "{}: no such content folder, serving nothing",
            root.display()
        ));
    }

    for kind in Kind::ALL {
        let mut items: Vec<Item> = Vec::new();
        // Case-insensitively: two ids differing only in case are one folder on
        // macOS and Windows, so the second download would overwrite the first.
        let mut seen = HashSet::new();

        for dir in subfolders(&root.join(kind.folder())) {
            match read_item(kind, &dir, &mut warnings) {
                Ok(item) => {
                    if !seen.insert(item.id.to_ascii_lowercase()) {
                        warnings.push(format!(
                            "{}: id `{}` is already used by another {}",
                            dir.display(),
                            item.id,
                            kind.slug()
                        ));
                        continue;
                    }
                    items.push(item);
                }
                Err(reason) => warnings.push(format!("{}: {reason}", dir.display())),
            }
        }

        items.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));

        let listing = json!({
            "kind": kind.slug(),
            "items": items.iter().map(|item| item.json.clone()).collect::<Vec<_>>(),
        });
        catalog.counts.insert(kind, items.len());
        catalog
            .listings
            .insert(kind, Bytes::from(listing.to_string()));

        for item in items {
            for file in item.files {
                catalog.files.insert(
                    (kind, item.id.clone(), file.relative),
                    FileEntry {
                        path: file.absolute,
                        bytes: file.bytes,
                        content_type: file.content_type,
                    },
                );
            }
        }
    }

    (catalog, warnings)
}

fn read_item(kind: Kind, dir: &Path, warnings: &mut Vec<String>) -> Result<Item, String> {
    match kind {
        Kind::Template => read_template(dir, warnings),
        Kind::Asset => read_asset(dir, warnings),
        _ => read_preset(kind, dir, warnings),
    }
}

/// An effect, transition, graphic or LUT: a folder the app's preset scanner reads as is.
///
/// The id is the manifest's own, because that is what the app's registry keys
/// by; the folder name is only where it happens to sit on this server.
fn read_preset(kind: Kind, dir: &Path, warnings: &mut Vec<String>) -> Result<Item, String> {
    let manifest = read_json(&dir.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let id = required_string(&manifest, "id", "manifest.json")?;
    check_id(&id)?;

    let declared = required_string(&manifest, "kind", "manifest.json")?;
    if declared != kind.slug() {
        return Err(format!(
            "manifest.json says kind `{declared}` but the folder is under {}/",
            kind.folder()
        ));
    }
    let name = required_string(&manifest, "name", "manifest.json")?;
    let category = required_string(&manifest, "category", "manifest.json")?;
    let schema = manifest
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or("manifest.json has no numeric `schema`")?;

    let files = collect(dir, PRESET_DEPTH, warnings, &|relative, extension| {
        relative == "manifest.json"
            || PRESET_TEXT.contains(&extension)
            || PRESET_ASSET.contains(&extension)
    })?;

    if let Some(big) = files.iter().find(|file| {
        PRESET_TEXT.contains(&extension_of(&file.relative).as_str())
            && file.bytes > MAX_TEXT_SOURCE_BYTES
    }) {
        return Err(format!(
            "{} is {} bytes; the app reads no text source over {MAX_TEXT_SOURCE_BYTES}",
            big.relative, big.bytes
        ));
    }

    let thumbnail = first_named(&files, THUMBNAILS);
    let json = json!({
        "id": id,
        "kind": kind.slug(),
        "name": name,
        "category": category,
        "author": optional_string(&manifest, "author"),
        "version": optional_string(&manifest, "version"),
        "schema": schema,
        "thumbnail": thumbnail,
        "files": files_json(&files),
        "bytes": total_bytes(&files),
    });
    Ok(Item {
        id,
        name,
        json,
        files,
    })
}

/// A template: the folder a `.cttpl` extracts to, served file by file.
///
/// `template.json` carries `schema` so the app can hide a template its build
/// cannot open without the server unzipping the `.ngt` to find out.
fn read_template(dir: &Path, warnings: &mut Vec<String>) -> Result<Item, String> {
    let id = folder_id(dir)?;
    let manifest = read_json(&dir.join("template.json"), MAX_SIDECAR_BYTES)?;
    let name = optional_string(&manifest, "name")
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.clone());
    let schema = manifest
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or("template.json has no numeric `schema` (2, or 3 when it holds a graphic)")?;

    let files = collect(dir, TEMPLATE_DEPTH, warnings, &|relative, extension| {
        relative == "template.ngt"
            || relative == "template.json"
            || IMAGE.contains(&extension)
            || VIDEO.contains(&extension)
            || AUDIO.contains(&extension)
            || FONT.contains(&extension)
            || LUT_FILE.contains(&extension)
    })?;
    if !files.iter().any(|file| file.relative == "template.ngt") {
        return Err("no template.ngt".into());
    }

    let thumbnail = first_named(&files, TEMPLATE_THUMBNAILS);
    let json = json!({
        "id": id,
        "kind": "template",
        "name": name,
        "category": optional_string(&manifest, "category"),
        "author": optional_string(&manifest, "author"),
        "schema": schema,
        "thumbnail": thumbnail,
        "files": files_json(&files),
        "bytes": total_bytes(&files),
    });
    Ok(Item {
        id,
        name,
        json,
        files,
    })
}

/// A media file someone can drop on the timeline, described by `asset.json`.
///
/// An image with no thumbnail of its own is its own thumbnail.
fn read_asset(dir: &Path, warnings: &mut Vec<String>) -> Result<Item, String> {
    let id = folder_id(dir)?;
    let manifest = read_json(&dir.join("asset.json"), MAX_SIDECAR_BYTES)?;
    let name = required_string(&manifest, "name", "asset.json")?;
    let media_type = required_string(&manifest, "type", "asset.json")?;
    let allowed: &[&str] = match media_type.as_str() {
        "video" => VIDEO,
        "image" => IMAGE,
        "audio" => AUDIO,
        other => {
            return Err(format!(
                "asset.json type `{other}` is not video, image or audio"
            ))
        }
    };
    let media = required_string(&manifest, "file", "asset.json")?;
    if media.contains('/') || !allowed.contains(&extension_of(&media).as_str()) {
        return Err(format!(
            "asset.json file `{media}` is not a {media_type} file beside it"
        ));
    }

    let files = collect(dir, 0, warnings, &|relative, extension| {
        relative == "asset.json"
            || relative == media
            || (THUMBNAILS.contains(&relative) && IMAGE.contains(&extension))
    })?;
    if !files.iter().any(|file| file.relative == media) {
        return Err(format!("asset.json names `{media}`, which is not there"));
    }

    let thumbnail = first_named(&files, THUMBNAILS).or_else(|| {
        if media_type == "image" {
            Some(media.clone())
        } else {
            None
        }
    });
    let json = json!({
        "id": id,
        "kind": "asset",
        "name": name,
        "category": optional_string(&manifest, "category"),
        "file": media,
        "media": {
            "type": media_type,
            "durationMs": manifest.get("durationMs").and_then(Value::as_u64),
            "width": manifest.get("width").and_then(Value::as_u64),
            "height": manifest.get("height").and_then(Value::as_u64),
        },
        "thumbnail": thumbnail,
        "files": files_json(&files),
        "bytes": total_bytes(&files),
    });
    Ok(Item {
        id,
        name,
        json,
        files,
    })
}

// ------------------------------------------------------------------ walking

/// Every file under `root` that `allow` accepts, by relative POSIX path.
///
/// A file it refuses is named in the warnings and left out, which is how a
/// stray `.js` in a preset folder never reaches anyone. A symbolic link is
/// never followed: it could point anywhere on this machine.
fn collect(
    root: &Path,
    depth: usize,
    warnings: &mut Vec<String>,
    allow: &dyn Fn(&str, &str) -> bool,
) -> Result<Vec<IndexedFile>, String> {
    let mut found = Vec::new();
    walk(root, "", depth, warnings, allow, &mut found)?;
    found.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(found)
}

fn walk(
    dir: &Path,
    prefix: &str,
    depth: usize,
    warnings: &mut Vec<String>,
    allow: &dyn Fn(&str, &str) -> bool,
    found: &mut Vec<IndexedFile>,
) -> Result<(), String> {
    for entry in
        sorted_entries(dir).map_err(|error| format!("cannot read {}: {error}", dir.display()))?
    {
        let Ok(name) = entry.file_name().into_string() else {
            warnings.push(format!(
                "{}: skipped a file whose name is not UTF-8",
                dir.display()
            ));
            continue;
        };
        if is_noise(&name) {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if !is_portable_name(&name) {
            warnings.push(format!(
                "{}: skipped {relative}: the name cannot be written on every platform",
                dir.display()
            ));
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot read {relative}: {error}"))?;
        if file_type.is_symlink() {
            warnings.push(format!(
                "{}: skipped {relative}: links are not served",
                dir.display()
            ));
            continue;
        }
        if file_type.is_dir() {
            if depth > 0 {
                walk(&entry.path(), &relative, depth - 1, warnings, allow, found)?;
            } else {
                warnings.push(format!(
                    "{}: skipped {relative}/: nested too deep",
                    dir.display()
                ));
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let extension = extension_of(&name);
        if !allow(&relative, extension.as_str()) {
            warnings.push(format!(
                "{}: skipped {relative}: not a file the app reads here",
                dir.display()
            ));
            continue;
        }

        let path = entry.path();
        let (bytes, sha256) =
            digest(&path).map_err(|error| format!("cannot read {relative}: {error}"))?;
        found.push(IndexedFile {
            relative,
            absolute: path,
            bytes,
            sha256,
            content_type: content_type(&extension),
        });
    }
    Ok(())
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<DirEntry>> {
    let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

/// The item folders under one kind's directory, in name order so that which
/// of two duplicates wins does not depend on the filesystem.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = sorted_entries(dir) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter(|entry| !is_noise(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect()
}

/// Archive-tool droppings and dotfiles: never content, never worth a warning.
fn is_noise(name: &str) -> bool {
    name.starts_with('.') || name == "__MACOSX"
}

fn digest(path: &Path) -> io::Result<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

// ------------------------------------------------------------------ names

/// The app's preset id pattern, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, plus what a
/// folder name needs on Windows: no trailing dot and no device name.
fn check_id(id: &str) -> Result<(), String> {
    let mut chars = id.chars();
    let starts_well = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_well = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !starts_well
        || !rest_well
        || id.len() > MAX_ID_LEN
        || id.ends_with('.')
        || is_device_name(id)
    {
        return Err(format!("`{id}` is not a usable id"));
    }
    Ok(())
}

fn folder_id(dir: &Path) -> Result<String, String> {
    let id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("the folder name is not UTF-8")?
        .to_owned();
    check_id(&id)?;
    Ok(id)
}

/// Whether the app can create a file of this name on macOS, Windows and Linux.
fn is_portable_name(name: &str) -> bool {
    !name.is_empty()
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        && !is_device_name(name)
}

/// `CON`, `NUL`, `COM1` and the rest, with or without an extension.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            let bytes = stem.as_bytes();
            bytes.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && (b'1'..=b'9').contains(&bytes[3])
        }
    }
}

fn extension_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.contains('/') => {
            extension.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

fn content_type(extension: &str) -> &'static str {
    match extension {
        "json" => "application/json",
        "frag" | "vert" | "glsl" | "cube" | "3dl" => "text/plain; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

// ------------------------------------------------------------------ json

fn read_json(path: &Path, cap: u64) -> Result<Value, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size = fs::metadata(path).map_err(|_| format!("no {name}"))?.len();
    if size > cap {
        return Err(format!("{name} is {size} bytes, over the {cap} byte limit"));
    }
    let text = fs::read_to_string(path).map_err(|error| format!("cannot read {name}: {error}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{name} is not valid JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("{name} is not a JSON object"));
    }
    Ok(value)
}

fn required_string(value: &Value, key: &str, file: &str) -> Result<String, String> {
    match value.get(key).and_then(Value::as_str).map(str::trim) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => Err(format!("{file} has no `{key}`")),
    }
}

fn optional_string(value: &Value, key: &str) -> Value {
    match value.get(key).and_then(Value::as_str).map(str::trim) {
        Some(text) if !text.is_empty() => Value::String(text.to_owned()),
        _ => Value::Null,
    }
}

fn first_named(files: &[IndexedFile], names: &[&str]) -> Option<String> {
    names
        .iter()
        .find(|name| files.iter().any(|file| file.relative == **name))
        .map(|name| (*name).to_owned())
}

fn files_json(files: &[IndexedFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(
                |file| json!({ "path": file.relative, "bytes": file.bytes, "sha256": file.sha256 }),
            )
            .collect(),
    )
}

fn total_bytes(files: &[IndexedFile]) -> u64 {
    files.iter().map(|file| file.bytes).sum()
}
