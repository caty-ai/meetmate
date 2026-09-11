import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { parseWav, wav, chunkPlan, pace, safeEvent, metrics, writeReports, main } from './probe.mjs';

test('WAV parser accepts PCM and ancillary chunks, rejects malformed headers', () => {
  const good = wav(Buffer.alloc(1280, 1));
  assert.equal(parseWav(good).length, 1280);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 1, 0]);
  const extra = Buffer.concat([good.subarray(0, 12), junk, good.subarray(12)]);
  extra.writeUInt32LE(extra.length - 8, 4);
  assert.equal(parseWav(extra).length, 1280);
  for (const [offset, value] of [[0, 0], [20, 3], [22, 2], [24, 8000], [28, 0], [32, 4], [34, 8], [40, 999999]]) {
    const b = Buffer.from(good); b.writeUInt32LE(value, offset);
    assert.throws(() => parseWav(b), /PCM16 mono 16000/);
  }
  assert.throws(() => parseWav(good.subarray(0, 43)));
  assert.throws(() => parseWav(good.subarray(0, -1)));
});

test('WAV writer produces the exact 44-byte PCM header', () => {
  const b = wav(Buffer.alloc(640));
  assert.equal(b.length, 684); assert.equal(b.readUInt32LE(4), 676);
  assert.equal(b.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(b.readUInt32LE(16), 16); assert.equal(b.readUInt16LE(20), 1);
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt32LE(28), 32000); assert.equal(b.readUInt16LE(32), 2);
  assert.equal(b.readUInt16LE(34), 16); assert.equal(b.toString('ascii', 36, 40), 'data');
  assert.equal(b.readUInt32LE(40), 640); assert.throws(() => wav(Buffer.alloc(1)));
});

test('640 bytes per 20 ms, ceil chunk count, monotonic schedule without accumulated drift', async () => {
  for (const bytes of [0, 2, 640, 642, 1280]) assert.equal(chunkPlan(bytes).length, Math.ceil(bytes / 640));
  assert.deepEqual(chunkPlan(642), [{ offset: 0, bytes: 640, at_ms: 0 }, { offset: 640, bytes: 2, at_ms: 20 }]);
  let clock = 100; const times = [];
  await pace(Buffer.alloc(1282), () => { times.push(clock); clock += 3; }, { now: () => clock, wait: async ms => { clock += ms; } });
  assert.deepEqual(times, [100, 120, 140]);
  clock = 0;
  await assert.rejects(pace(Buffer.alloc(1280), () => { clock += 150; }, { now: () => clock, wait: async ms => { clock += ms; } }), /pacing/);
});

test('synthetic events.jsonl yields latency, delegation backchannels, unaddressed tally and reports', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-probe-test-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const events = [
    ...chunkPlan(32000 * 4).map(c => ({ type: 'session.input_audio.append', direction: 'client', t_ms: 100 + c.at_ms, input_offset_ms: c.offset / 32, audio_bytes: c.bytes })),
    { type: 'session.delegation.created', direction: 'server', t_ms: 1150, delegation: { id: 'd1', target: 'client' } },
    { type: 'session.output_audio.delta', direction: 'server', t_ms: 1300, audio_bytes: 640 },
    { type: 'session.output_transcript.delta', direction: 'server', t_ms: 1320, delta: 'うん', start_ms: 1200, end_ms: 1220 },
    { type: 'session.commentary.append', direction: 'client', t_ms: 1800, delegation_id: 'd1' },
    { type: 'session.output_transcript.delta', direction: 'server', t_ms: 1900, delta: '結果です', start_ms: 1800, end_ms: 1820 },
    { type: 'session.output_audio.delta', direction: 'server', t_ms: 2500, audio_bytes: 640 },
    { type: 'session.closed', direction: 'server', t_ms: 6000, usage: { seconds: 6 } },
  ].sort((a, b) => a.t_ms - b.t_ms);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
  const recorded = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').map(JSON.parse);
  const segments = [{ speaker: 'A', start_ms: 0, end_ms: 1000, addressed: true, text: '質問' }, { speaker: 'B', start_ms: 2000, end_ms: 2400, addressed: false, text: '雑談' }];
  const m = writeReports(dir, recorded, segments, [Buffer.alloc(640)]);
  assert.deepEqual(m.first_output_audio_latency_ms, [200, 0]);
  assert.equal(m.backchannel_events.length, 1); assert.equal(m.backchannel_events[0].text, 'うん');
  assert.equal(m.delegation_count, 1); assert.equal(m.unaddressed_response_count, 1); assert.equal(m.unaddressed_line_count, 1);
  assert.ok(Math.abs(m.estimated_cost_usd - .005) < 1e-12); assert.deepEqual(m.usage, { seconds: 6 });
  assert.equal(m.interruption_handled, null);
  assert.equal(parseWav(fs.readFileSync(path.join(dir, 'output.wav'))).length, 640);
  assert.match(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), /うん/);
});

test('interruption proxy distinguishes stopped, continuing and not-observed audio', () => {
  const a = t_ms => ({ direction: 'server', type: 'session.output_audio.delta', audio_bytes: 640, t_ms });
  const base = [a(980), { kind: 'probe', name: 'interruption', t_ms: 1000 }];
  const end = { direction: 'server', type: 'session.closed', t_ms: 2500 };
  assert.equal(metrics([...base, a(1100), end], []).interruption_handled, true);
  assert.equal(metrics([...base, ...Array.from({ length: 74 }, (_, i) => a(1020 + i * 20)), end], []).interruption_handled, false);
  assert.equal(metrics([base[1], end], []).interruption_handled, null);
});

test('audio payloads are replaced by byte counts', () => {
  const b64 = Buffer.alloc(640).toString('base64');
  assert.deepEqual(safeEvent({ type: 'session.input_audio.append', audio: b64 }), { type: 'session.input_audio.append', audio_bytes: 640 });
  assert.deepEqual(safeEvent({ type: 'session.output_audio.delta', delta: b64 }), { type: 'session.output_audio.delta', audio_bytes: 640 });
});

test('missing key exits with one line before reading input or opening a socket', () => {
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, [new URL('./probe.mjs', import.meta.url).pathname, '--input', '/does-not-exist.wav'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stderr, 'probe: OPENAI_API_KEY is required; no socket opened\n');
});

test('offline socket double verifies wire events, delegation and fail-closed paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-wire-test-'));
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'probe-test';
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; fs.rmSync(dir, { recursive: true }); });
  const input = path.join(dir, 'input.wav'); fs.writeFileSync(input, wav(Buffer.alloc(1280)));
  for (const mode of ['success', 'error', 'early-close', 'bad-wav']) {
    const sent = []; let sockets = 0;
    class FakeSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      constructor(url, options) {
        super(); sockets++;
        assert.equal(url, 'wss://api.openai.com/v1/live/sessions'); assert.equal(options.headers.Authorization, 'Bearer probe-test');
        queueMicrotask(() => this.emit('open'));
      }
      send(raw, cb) {
        const e = JSON.parse(raw); sent.push(e); cb?.();
        if (e.type === 'session.start') queueMicrotask(() => {
          if (mode === 'error') return this.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { message: 'test server failure' } })));
          if (mode === 'early-close') return this.emit('close');
          this.emit('message', Buffer.from('{"type":"session.started"}'));
          this.emit('message', Buffer.from('{"type":"session.delegation.created","delegation":{"id":"d1","target":"client"},"offset_ms":0}'));
        });
        if (e.type === 'session.close') queueMicrotask(() => this.emit('message', Buffer.from('{"type":"session.closed","usage":{"seconds":1}}')));
      }
      terminate() { this.readyState = 3; }
    }
    if (mode === 'bad-wav') fs.writeFileSync(input, Buffer.alloc(44));
    const run = main(['--input', input, '--tail-ms', '0', '--out', path.join(dir, mode), '--backend-delay-ms', '10', '--thinking-progress', '--append-instruction', '短く'], { WebSocket: FakeSocket });
    if (mode !== 'success') {
      await assert.rejects(run, mode === 'error' ? /test server failure/ : mode === 'early-close' ? /before session.closed/ : /WAV/);
      if (mode === 'bad-wav') assert.equal(sockets, 0);
      continue;
    }
    await run;
    assert.deepEqual(sent[0].session.audio, { format: { type: 'audio/pcm', rate: 16000 }, output: { voice: 'quartz' } });
    assert.equal(sent[0].session.model, 'gpt-live-1'); assert.deepEqual(sent[0].session.delegation, { type: 'client' });
    assert.equal(sent[1].type, 'session.instructions.append'); assert.equal(sent[1].delegation_id, null);
    assert.equal(sent.filter(e => e.type === 'session.input_audio.append').length, 2);
    assert.ok(sent.some(e => e.type === 'session.thinking.append' && e.delegation_id === 'd1'));
    assert.ok(sent.some(e => e.type === 'session.commentary.append' && e.delegation_id === 'd1'));
    assert.deepEqual(sent.at(-1), { type: 'session.close' });
    assert.ok(!fs.readFileSync(path.join(dir, mode, 'events.jsonl'), 'utf8').includes('"audio":"'));
  }
});
