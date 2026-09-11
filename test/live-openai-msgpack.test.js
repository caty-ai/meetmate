"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { encode, decode, decodeOne } = require("../src/live-openai/msgpack-lite");
const bytes = hex => Buffer.from(hex.replaceAll(" ", ""), "hex");
const asBytes = v => typeof v === "string" ? Buffer.from(v) : Buffer.isBuffer(v) ? v
  : Array.isArray(v) ? v.map(asBytes) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asBytes(x)])) : v;

test("Fish byte vectors and start event round-trip (strings stay bytes)", () => {
  assert.deepEqual(encode({ event: "flush" }), bytes("81 a5 65 76 65 6e 74 a5 66 6c 75 73 68"));
  assert.deepEqual(encode(Buffer.from([1, 2, 3])), bytes("c4 03 01 02 03"));
  assert.deepEqual(decodeOne(bytes("81 a5 61 75 64 69 6f c4 04 00 01 02 03")), { audio: Buffer.from([0, 1, 2, 3]) });
  const start = { event: "start", request: { text: "", reference_id: "test-voice", format: "pcm", sample_rate: 24000, latency: "low" } };
  assert.deepEqual(decodeOne(encode(start)), asBytes(start));
});
test("nested round-trips, all supported integer widths and float32/64", () => {
  const value = { nested: [null, true, false, "日本語", { audio: Buffer.from([0, 255]) }], numbers: [0, 127, 128, 255, 256, 65535, 65536, 0xffffffff, -1, -32, -33, -128, -129, -32768, -32769, -2147483648, 1.25] };
  assert.deepEqual(decodeOne(encode(value)), asBytes(value));
  assert.equal(decodeOne(bytes("ca 3f a0 00 00")), 1.25);
  for (const n of [31, 32, 255, 256, 65535, 65536]) {
    assert.deepEqual(decodeOne(encode("x".repeat(n))), Buffer.from("x".repeat(n)));
    assert.deepEqual(decodeOne(encode(Buffer.alloc(n, 7))), Buffer.alloc(n, 7));
  }
  for (const n of [15, 16, 65536]) {
    assert.deepEqual(decodeOne(encode(Array(n).fill(1))), Array(n).fill(1));
    const map = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    assert.deepEqual(decodeOne(encode(map)), map);
  }
});
test("full-frame, truncated data, nonstring keys, ext and 64-bit rejection", () => {
  const packed = encode({ event: "flush" });
  assert.equal(decode(Buffer.concat([packed, Buffer.from([0])])).bytesRead, packed.length);
  assert.throws(() => decodeOne(Buffer.concat([packed, Buffer.from([0])])), /Trailing/);
  for (let i = 0; i < packed.length; i++) assert.throws(() => decodeOne(packed.subarray(0, i)));
  for (const tag of [0xc1, 0xc7, 0xc8, 0xc9, 0xcf, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]) assert.throws(() => decodeOne(Buffer.from([tag])), /Unsupported/);
  for (const v of [0x100000000, -2147483649, 1n, undefined]) assert.throws(() => encode(v));
  assert.throws(() => decodeOne(bytes("81 c4 01 61 01")), /key/);
  assert.throws(() => decodeOne(bytes("df ff ff ff ff")), /Truncated/);
  const proto = decodeOne(encode(JSON.parse('{"__proto__":{"x":1}}')));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(Object.hasOwn(proto, "__proto__"), true);
});
