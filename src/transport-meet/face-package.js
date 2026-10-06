"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Shared by manifest validation and request validation. No decoding or normalization.
const PLAIN_QUERY = /^[A-Za-z0-9_.-]{1,40}=[A-Za-z0-9_.-]{0,40}(?:&[A-Za-z0-9_.-]{1,40}=[A-Za-z0-9_.-]{0,40}){0,3}(?![\s\S])/;
const TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".psd": "application/octet-stream", ".woff2": "font/woff2",
});
const SUPPORTS = new Set(["speak", "level", "emotion", "background", "background-transparent", "listen", "cue"]);
const LIMITS = Object.freeze({ manifest: 64 * 1024, files: 2000, depth: 8, path: 200, file: 64 * 1024 ** 2, total: 256 * 1024 ** 2 });

function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= LIMITS.path
    && !/[\\\0%?#:]/.test(value) && !path.isAbsolute(value)
    && value.split("/").every((part) => part && !part.startsWith("."));
}
function sameFile(a, b) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function inside(root, filename) {
  return filename.startsWith(root + path.sep);
}

// The index is private to the returned closures, never resolved from request paths.
function loadPackage(directory, { warn = console.warn } = {}) {
  try {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("directory");
    const root = fs.realpathSync(directory);
    if (!fs.lstatSync(root).isDirectory()) throw new Error("directory");
    const index = new Map();
    let total = 0;
    function walk(relative, depth) {
      if (depth > LIMITS.depth) throw new Error("depth");
      for (const name of fs.readdirSync(path.join(root, relative))) {
        const rel = relative ? `${relative}/${name}` : name;
        const file = path.join(root, rel);
        const stat = fs.lstatSync(file, { bigint: true });
        if (name.startsWith(".") || stat.isSymbolicLink()) continue;
        if (rel.length > LIMITS.path) throw new Error("path");
        if (!safePath(rel) || !inside(root, fs.realpathSync(file))) throw new Error("path");
        if (stat.isDirectory()) walk(rel, depth + 1);
        else if (stat.isFile()) {
          total += Number(stat.size);
          if (stat.size > BigInt(LIMITS.file) || total > LIMITS.total || index.size >= LIMITS.files) throw new Error("size");
          index.set(rel, { file, stat });
        }
      }
    }
    walk("", 0);
    function openIndexed(rel) {
      const hit = index.get(rel);
      if (!hit) return null;
      let fd;
      try {
        // Reject changed ancestors too. O_NOFOLLOW and fstat pin the checked inode
        // across a concurrent last-component replacement before createReadStream.
        let ancestor = root;
        if (!fs.lstatSync(ancestor).isDirectory()) return null;
        for (const part of rel.split("/").slice(0, -1)) {
          ancestor = path.join(ancestor, part);
          if (!fs.lstatSync(ancestor).isDirectory()) return null;
        }
        if (!sameFile(hit.stat, fs.lstatSync(hit.file, { bigint: true }))) return null;
        if (!inside(root, fs.realpathSync(hit.file))) return null;
        fd = fs.openSync(hit.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        if (!sameFile(hit.stat, fs.fstatSync(fd, { bigint: true }))) throw new Error("changed");
        return { fd, size: Number(hit.stat.size) };
      } catch {
        if (fd !== undefined) fs.closeSync(fd);
        return null;
      }
    }
    if (index.get("face.json")?.stat.size > BigInt(LIMITS.manifest)) throw new Error("manifest size");
    const manifestFile = openIndexed("face.json");
    if (!manifestFile) throw new Error("manifest");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile.fd, "utf8")); }
    finally { fs.closeSync(manifestFile.fd); }
    if (manifest?.spec !== "face-package/1" || !safePath(manifest.entry)
      || !manifest.entry.endsWith(".html") || !index.has(manifest.entry)) throw new Error("entry");
    if (manifest.query !== undefined && (typeof manifest.query !== "string" || !PLAIN_QUERY.test(manifest.query))) throw new Error("query");
    if (!Array.isArray(manifest.supports) || manifest.supports.length > 32
      || manifest.supports.some((v) => typeof v !== "string" || !/^[a-z][a-z0-9-]{0,31}(?![\s\S])/.test(v))
      || !manifest.supports.includes("speak") || !manifest.supports.includes("level")) throw new Error("supports");
    const viewport = manifest.viewport;
    if (viewport !== undefined && (!viewport || ![viewport.width, viewport.height].every((v) => Number.isInteger(v) && v > 0 && v <= 8192))) throw new Error("viewport");
    if (manifest.quality !== undefined && !["low", "medium", "high", "auto"].includes(manifest.quality)) throw new Error("quality");
    const descriptor = Object.freeze({
      entry: manifest.entry, supports: Object.freeze([...new Set(manifest.supports.filter((v) => SUPPORTS.has(v)))]),
      ...(manifest.query === undefined ? {} : { query: manifest.query }),
      ...(viewport === undefined ? {} : { viewport: Object.freeze({ width: viewport.width, height: viewport.height }) }),
      ...(manifest.quality === undefined ? {} : { quality: manifest.quality }),
    });
    return Object.freeze({ descriptor, serve(req, res, url, session, notFound) {
      if (req.method !== "GET" || !session.isLive() || (url.search && !PLAIN_QUERY.test(url.search.slice(1)))) return notFound();
      const prefix = `/local-avatar/pkg/${session.mountId}/`;
      const rel = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(prefix) || !safePath(rel) || rel === "face.json") return notFound();
      const ext = path.extname(rel);
      if (!Object.hasOwn(TYPES, ext) || (ext === ".html" && rel !== descriptor.entry)) return notFound();
      const opened = openIndexed(rel);
      if (!opened) return notFound();
      if (!session.isLive()) { fs.closeSync(opened.fd); return notFound(); }
      // Restrict resource fetches to this mount, not privileged same-origin APIs.
      const source = `${session.publicOrigin}${prefix}`;
      const csp = ["sandbox allow-scripts", "default-src 'none'", `script-src ${source}`,
        `connect-src ${source} blob: data:`, `img-src ${source} blob: data:`,
        `style-src ${source} 'unsafe-inline'`, `font-src ${source}`,
        `worker-src ${source} blob:`, "media-src 'none'", "object-src 'none'",
        "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'"].join("; ");
      res.writeHead(200, {
        "Content-Type": TYPES[ext], "Content-Length": opened.size,
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*",
        "Content-Security-Policy": csp,
        "Permissions-Policy": "microphone=(), camera=(), autoplay=(), display-capture=()",
      });
      const stream = fs.createReadStream(null, { fd: opened.fd, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } });
  } catch {
    // Existing invalid-setting diagnostic; do not disclose paths or manifest text.
    warn("MM-MMT-003: face package invalid or unset; using static image");
    return null;
  }
}

module.exports = { loadPackage, PLAIN_QUERY, LIMITS };
