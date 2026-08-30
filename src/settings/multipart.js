"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const HEADER_LIMIT = 16 * 1024;

function requireOptions(options) {
  const names = [
    "filePartName", "metadataPartName", "contentTypes", "extensions",
    "encodedRejectPattern", "maxFileBytes", "maxMetadataBytes", "errorFactory",
  ];
  if (!options || names.some((name) => !Object.hasOwn(options, name))) {
    throw new TypeError("Multipart parser options are required");
  }
  if (typeof options.filePartName !== "string" || !options.filePartName
      || !(options.metadataPartName === null || (typeof options.metadataPartName === "string" && options.metadataPartName))
      || !Array.isArray(options.contentTypes) || options.contentTypes.length === 0
      || !Array.isArray(options.extensions) || options.extensions.length === 0
      || !(options.encodedRejectPattern instanceof RegExp)
      || options.encodedRejectPattern.global || options.encodedRejectPattern.sticky
      || !Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0
      || !Number.isSafeInteger(options.maxMetadataBytes) || options.maxMetadataBytes < 0
      || typeof options.errorFactory !== "function") {
    throw new TypeError("Multipart parser options are invalid");
  }
}

function fail(options, reason, status) {
  throw options.errorFactory(reason, status);
}

function unlinkBestEffort(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function randomTemp(directory, options) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const target = path.join(directory, `.multipart-${process.pid}-${crypto.randomBytes(16).toString("hex")}`);
    try {
      const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      return { path: target, descriptor };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  fail(options, "TEMP_FAILED", 500);
}

function multipartBoundary(contentType, options) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i.exec(String(contentType || ""));
  const value = match?.[1] || match?.[2] || "";
  if (!value || value.length > 70 || /[\x00-\x20\x7f]/.test(value)) fail(options, "MEDIA_TYPE_UNSUPPORTED", 415);
  return value;
}

function parseContentDisposition(value, options) {
  if (typeof value !== "string" || !/^form-data(?:\s*;|$)/i.test(value) || value.includes("\0")) {
    fail(options, "MULTIPART_INVALID", 422);
  }
  const parameters = new Map();
  const pattern = /;\s*([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    if (parameters.has(key)) fail(options, "MULTIPART_INVALID", 422);
    const raw = match[2] === undefined ? match[3].trim() : match[2].replace(/\\([\\"])/g, "$1");
    parameters.set(key, raw);
  }
  if (!parameters.has("name")) fail(options, "MULTIPART_INVALID", 422);
  return { name: parameters.get("name"), filename: parameters.get("filename") };
}

function parseHeaders(bytes, options) {
  if (bytes.includes(0)) fail(options, "MULTIPART_INVALID", 422);
  const headers = new Map();
  for (const line of bytes.toString("latin1").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) fail(options, "MULTIPART_INVALID", 422);
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || headers.has(name)) fail(options, "MULTIPART_INVALID", 422);
    headers.set(name, value);
  }
  return headers;
}

function validateFilename(filename, options) {
  if (typeof filename !== "string" || filename === "" || filename.includes("\0")
      || filename.includes("/") || filename.includes("\\") || filename.includes("..")
      || options.encodedRejectPattern.test(filename)
      || !options.extensions.some((extension) => filename.endsWith(extension))) {
    fail(options, "FILENAME_REJECTED", 422);
  }
}

async function parseMultipart(req, directory, options) {
  requireOptions(options);
  const boundary = multipartBoundary(req.headers["content-type"], options);
  const opening = Buffer.from(`--${boundary}\r\n`, "ascii");
  const marker = Buffer.from(`\r\n--${boundary}`, "ascii");
  const allowedTypes = new Set(options.contentTypes.map((value) => String(value).toLowerCase()));
  let buffer = Buffer.alloc(0);
  let phase = "opening";
  let current = null;
  let source = null;
  let metadataBytes = Buffer.alloc(0);
  let metadataSeen = false;
  let fileSeen = false;

  function closeSource() {
    if (!source || source.closed) return;
    fs.fsyncSync(source.descriptor);
    fs.closeSync(source.descriptor);
    source.closed = true;
  }

  function startPart(headerBytes) {
    const headers = parseHeaders(headerBytes, options);
    const disposition = parseContentDisposition(headers.get("content-disposition"), options);
    if (disposition.name === options.filePartName) {
      if (fileSeen || disposition.filename === undefined) fail(options, "MULTIPART_INVALID", 422);
      validateFilename(disposition.filename, options);
      const mediaType = String(headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (!allowedTypes.has(mediaType)) fail(options, "MEDIA_TYPE_UNSUPPORTED", 415);
      source = { ...randomTemp(directory, options), bytes: 0, hash: crypto.createHash("sha256"), closed: false };
      fileSeen = true;
      current = "file";
      return;
    }
    if (options.metadataPartName !== null && disposition.name === options.metadataPartName) {
      if (metadataSeen || disposition.filename !== undefined) fail(options, "MULTIPART_INVALID", 422);
      const rawType = String(headers.get("content-type") || "").toLowerCase();
      if (rawType) {
        const [mediaType, ...parameters] = rawType.split(";").map((item) => item.trim());
        if (mediaType !== "application/json"
            || parameters.some((item) => !/^[^=;\s]+=(?:"[^"]*"|[^;\s]+)$/.test(item))) {
          fail(options, "MEDIA_TYPE_UNSUPPORTED", 415);
        }
      }
      metadataSeen = true;
      current = "metadata";
      return;
    }
    fail(options, "MULTIPART_INVALID", 422);
  }

  function consume(bytes) {
    if (bytes.length === 0) return;
    if (current === "file") {
      source.bytes += bytes.length;
      if (source.bytes > options.maxFileBytes) fail(options, "FILE_TOO_LARGE", 413);
      fs.writeSync(source.descriptor, bytes);
      source.hash.update(bytes);
      return;
    }
    if (current === "metadata") {
      if (metadataBytes.length + bytes.length > options.maxMetadataBytes) fail(options, "METADATA_TOO_LARGE", 413);
      metadataBytes = Buffer.concat([metadataBytes, bytes]);
      return;
    }
    fail(options, "MULTIPART_INVALID", 422);
  }

  function finishPart() {
    if (current === "file") closeSource();
    current = null;
  }

  try {
    for await (const chunk of req) {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (phase === "opening") {
          if (buffer.length < opening.length) break;
          if (!buffer.subarray(0, opening.length).equals(opening)) fail(options, "MULTIPART_INVALID", 422);
          buffer = buffer.subarray(opening.length);
          phase = "headers";
          continue;
        }
        if (phase === "headers") {
          const index = buffer.indexOf("\r\n\r\n");
          if (index < 0) {
            if (buffer.length > HEADER_LIMIT) fail(options, "MULTIPART_INVALID", 422);
            break;
          }
          if (index > HEADER_LIMIT) fail(options, "MULTIPART_INVALID", 422);
          startPart(buffer.subarray(0, index));
          buffer = buffer.subarray(index + 4);
          phase = "body";
          continue;
        }
        if (phase === "body") {
          const index = buffer.indexOf(marker);
          if (index < 0) {
            const safeLength = Math.max(0, buffer.length - marker.length + 1);
            consume(buffer.subarray(0, safeLength));
            buffer = buffer.subarray(safeLength);
            break;
          }
          consume(buffer.subarray(0, index));
          finishPart();
          buffer = buffer.subarray(index + marker.length);
          phase = "suffix";
          continue;
        }
        if (phase === "suffix") {
          if (buffer.length < 2) break;
          const suffix = buffer.subarray(0, 2).toString("ascii");
          if (suffix === "\r\n") {
            buffer = buffer.subarray(2);
            phase = "headers";
            continue;
          }
          if (suffix === "--") {
            buffer = buffer.subarray(2);
            phase = "closed";
            continue;
          }
          fail(options, "MULTIPART_INVALID", 422);
        }
        if (phase === "closed") {
          if (buffer.length === 0) break;
          if (buffer.length === 1 && buffer[0] === 13) break;
          if (buffer.equals(Buffer.from("\r\n"))) {
            buffer = Buffer.alloc(0);
            break;
          }
          fail(options, "MULTIPART_INVALID", 422);
        }
      }
    }
    const metadataRequired = options.metadataPartName !== null;
    if (phase !== "closed" || buffer.length !== 0 || !fileSeen || (metadataRequired && !metadataSeen) || !source) {
      fail(options, "MULTIPART_INVALID", 422);
    }
    closeSource();
    let metadata = null;
    if (metadataRequired) {
      let metadataText;
      try { metadataText = new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes); } catch {
        fail(options, "METADATA_INVALID", 422);
      }
      try { metadata = JSON.parse(metadataText); } catch { fail(options, "METADATA_INVALID", 422); }
    }
    return {
      metadata,
      filePath: source.path,
      fileBytes: source.bytes,
      fileSha256: source.hash.digest("hex"),
    };
  } catch (error) {
    try { closeSource(); } catch { /* cleanup below */ }
    unlinkBestEffort(source?.path);
    throw error;
  }
}

module.exports = { parseMultipart };
