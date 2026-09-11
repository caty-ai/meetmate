"use strict";

// Fish sends one MessagePack value per frame. Strings stay bytes until the
// event layer chooses which fields are text; map keys alone are UTF-8 strings.
function encode(value) {
  const parts = [];
  const number = (tag, size, method, n) => {
    const b = Buffer.alloc(1 + size); b[0] = tag; b[method](n, 1); parts.push(b);
  };
  const length = (n, fix, limit, tags) => {
    if (fix !== null && n < limit) parts.push(Buffer.from([fix + n]));
    else if (tags[0] !== null && n <= 255) number(tags[0], 1, "writeUInt8", n);
    else if (n <= 65535) number(tags[1], 2, "writeUInt16BE", n);
    else number(tags[2], 4, "writeUInt32BE", n);
  };
  const write = (v) => {
    if (v === null) parts.push(Buffer.from([0xc0]));
    else if (typeof v === "boolean") parts.push(Buffer.from([v ? 0xc3 : 0xc2]));
    else if (typeof v === "number") {
      if (!Number.isInteger(v)) number(0xcb, 8, "writeDoubleBE", v);
      else if (v >= 0 && v <= 127) parts.push(Buffer.from([v]));
      else if (v >= -32 && v < 0) parts.push(Buffer.from([256 + v]));
      else if (v >= 0 && v <= 255) number(0xcc, 1, "writeUInt8", v);
      else if (v >= 0 && v <= 65535) number(0xcd, 2, "writeUInt16BE", v);
      else if (v >= 0 && v <= 0xffffffff) number(0xce, 4, "writeUInt32BE", v);
      else if (v >= -128 && v < 0) number(0xd0, 1, "writeInt8", v);
      else if (v >= -32768 && v < 0) number(0xd1, 2, "writeInt16BE", v);
      else if (v >= -2147483648 && v < 0) number(0xd2, 4, "writeInt32BE", v);
      else throw new Error("MessagePack 64-bit integers are unsupported");
    } else if (typeof v === "string") {
      const b = Buffer.from(v, "utf8"); length(b.length, 0xa0, 32, [0xd9, 0xda, 0xdb]); parts.push(b);
    } else if (Buffer.isBuffer(v)) {
      length(v.length, null, 0, [0xc4, 0xc5, 0xc6]); parts.push(v);
    } else if (Array.isArray(v)) {
      length(v.length, 0x90, 16, [null, 0xdc, 0xdd]); v.forEach(write);
    } else if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      const entries = Object.entries(v); length(entries.length, 0x80, 16, [null, 0xde, 0xdf]);
      for (const [k, item] of entries) { write(k); write(item); }
    } else throw new Error("Unsupported MessagePack value");
  };
  write(value);
  return Buffer.concat(parts);
}

function decode(buffer) {
  let offset = 0;
  const take = (n) => {
    if (n > buffer.length - offset) throw new Error("Truncated MessagePack frame");
    const b = buffer.subarray(offset, offset + n); offset += n; return b;
  };
  const uint = (n) => take(n).readUIntBE(0, n);
  const array = (n) => {
    if (n > buffer.length - offset) throw new Error("Truncated MessagePack array");
    return Array.from({ length: n }, () => read());
  };
  const map = (n) => {
    if (n > (buffer.length - offset) / 2) throw new Error("Truncated MessagePack map");
    const v = {};
    for (let i = 0; i < n; i++) {
      const tag = buffer[offset];
      if (!(tag >= 0xa0 && tag <= 0xbf) && ![0xd9, 0xda, 0xdb].includes(tag)) throw new Error("MessagePack map key must be a string");
      const key = read().toString("utf8");
      Object.defineProperty(v, key, { value: read(), enumerable: true, configurable: true, writable: true });
    }
    return v;
  };
  const read = () => {
    const tag = uint(1);
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if (tag >= 0xa0 && tag <= 0xbf) return take(tag - 0xa0);
    if (tag >= 0x90 && tag <= 0x9f) return array(tag - 0x90);
    if (tag >= 0x80 && tag <= 0x8f) return map(tag - 0x80);
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xcc: return uint(1);
      case 0xcd: return uint(2);
      case 0xce: return uint(4);
      case 0xd0: return take(1).readInt8(0);
      case 0xd1: return take(2).readInt16BE(0);
      case 0xd2: return take(4).readInt32BE(0);
      case 0xca: return take(4).readFloatBE(0);
      case 0xcb: return take(8).readDoubleBE(0);
      case 0xc4: case 0xd9: return take(uint(1));
      case 0xc5: case 0xda: return take(uint(2));
      case 0xc6: case 0xdb: return take(uint(4));
      case 0xdc: return array(uint(2));
      case 0xdd: return array(uint(4));
      case 0xde: return map(uint(2));
      case 0xdf: return map(uint(4));
      default: throw new Error("Unsupported MessagePack tag (ext/64-bit/reserved)");
    }
  };
  return { value: read(), bytesRead: offset };
}
function decodeOne(buffer) {
  const { value, bytesRead } = decode(buffer);
  if (bytesRead !== buffer.length) throw new Error("Trailing MessagePack bytes");
  return value;
}
module.exports = { encode, decode, decodeOne };
