# cartcut-cloud

The content server behind Cartcut's cloud tiles: free effects, transitions,
graphics, LUTs, templates and media, served read-only from a folder. Not to be
confused with `electron/server/`, the Express server the app itself runs for
the self-hosted web build.

Five dependencies (`tokio`, `hyper`, `hyper-util`, `serde_json`, `sha2`). TLS,
rate limiting and compression belong to the reverse proxy in front of it.

```
cargo run                                              # serves ./content on 127.0.0.1:8787
CARTCUT_CLOUD_CONTENT=tests/fixtures/content cargo run # the test fixtures, for development
cargo test                                             # the API tests
```

| Variable | Default |
|---|---|
| `CARTCUT_CLOUD_BIND` | `127.0.0.1:8787` |
| `CARTCUT_CLOUD_CONTENT` | `content` |

The app picks its server in this order, the same in a development and a
packaged build:

1. **Settings ▸ Server URL**, stored as `cloud_api_url` in electron-store.
   Empty means the default. This is how an installed app is pointed at a
   staging or local server without a rebuild.
2. `CARTCUT_CLOUD_URL`, when the app was started with it set.
3. `cloudApiUrl` in `electron/config.json`.

So `CARTCUT_CLOUD_URL=http://127.0.0.1:8787 npm run start` points a development
build here, and so does typing `http://127.0.0.1:8787` into Settings.

The folder is scanned **once, at startup**. Restart to publish a change. A
folder that cannot be served is skipped with a `warning:` line naming why, and
everything else still goes out.

## The content folder

It mirrors what the app keeps on its own disk, so a downloaded item is an
ordinary installed one.

```
content/
  effects/<folder>/      manifest.json, *.frag, thumbnail.webp|png|jpg
  transitions/<folder>/  the same
  graphics/<folder>/     manifest.json, index.html, style.css, fonts, images, thumbnail.*
  luts/<folder>/         manifest.json, lut.cube, thumbnail.*
  templates/<folder>/    template.ngt, template.json, thumbnail.png|jpg, media at any depth
  assets/<folder>/       asset.json, one media file, thumbnail.*
```

- A preset's id is its `manifest.json` `id`, because that is what the app's
  registry keys by. Use a namespace no built-in uses (`com.cartcut.cloud.*`): an
  id the user already has locally is never shown as a cloud tile.
- A template's and an asset's id is its folder name.
- `template.json`: `name`, `author`, optional `category`, and `schema`, which is
  2, or 3 when the template holds a graphic. The app hides a template its build
  cannot open.
- `asset.json`: `name`, `type` (`video`, `image` or `audio`), `file` (the media
  beside it), optional `category`, `durationMs`, `width`, `height`. An image
  with no thumbnail is its own.
- Only files the app reads are indexed (the extension lists in
  `electron/lib/presetScan.ts`). A `.js` is skipped, as is a text source over
  512 KB, a symbolic link, and a name Windows cannot hold.
- Ids are unique per kind, case-insensitively. The first folder in name order
  wins and the rest are skipped.

## API

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | `{ ok, version, counts }` |
| GET | `/v1/catalog/{kind}` | `{ kind, items }`; kind is `effect`, `transition`, `graphic`, `lut`, `template` or `asset` |
| GET, HEAD | `/v1/files/{kind}/{id}/{path}` | one file |
| OPTIONS | any | CORS preflight |

An item:

```json
{
  "id": "com.cartcut.cloud.duotone-sunset",
  "kind": "effect",
  "name": "Sunset Duotone",
  "category": "color",
  "author": "Cartcut",
  "version": "1.0.0",
  "schema": 1,
  "thumbnail": "thumbnail.png",
  "files": [{ "path": "manifest.json", "bytes": 727, "sha256": "c3c8..." }],
  "bytes": 4816
}
```

Assets add `file` and `media: { type, durationMs, width, height }`.

A file is found by looking `(kind, id, path)` up in the index the scan built,
never by joining the request onto the content directory, so a path the scan
did not choose cannot be named. Files are sent with
`Cache-Control: immutable` and the app requests each one with `?v=<sha256>`,
so new bytes are always a new URL.
