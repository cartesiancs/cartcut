// The browser editor served the way scripts/buildWeb.mjs lays out dist-web/
// (nothing built or written), with Range support for media. Shared by the
// menu bar checks in this folder.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MOUNTS = [
  ["/dist/", "apps/app/dist/"],
  ["/vendor/", "apps/app/vendor/"],
  ["/page/", "apps/app/page/"],
  ["/sample/", "apps/app/sample/"],
  ["/assets/", "apps/app/assets/"],
  ["/assets/", "assets/"],
  ["/examples/", "examples/"],
];
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

function resolve(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (pathname.startsWith(prefix)) {
      const file = path.resolve(REPO, dir, pathname.slice(prefix.length));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return path.extname(pathname) !== "" ? null : path.join(REPO, "apps/app/index.html");
}

export async function serve() {
  const server = http.createServer((req, res) => {
    const file = resolve(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
    if (file == null) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (range != null) {
      const start = range[1] === "" ? 0 : Number(range[1]);
      const end = range[2] === "" ? size - 1 : Number(range[2]);
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://localhost:${server.address().port}`, close: () => server.close() };
}
