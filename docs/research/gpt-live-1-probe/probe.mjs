import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

export const RATE = 16000;
export const CHUNK_BYTES = 640;
const here = path.dirname(fileURLToPath(import.meta.url));
export function parseWav(b) {
  const bad = () => { throw new Error('WAV must be valid PCM16 mono 16000 Hz RIFF/WAVE'); };
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) bad();
  let fmt = false, pcm;
  for (let p = 12; p < b.length;) {
    if (p + 8 > b.length) bad();
    const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4), s = p + 8;
    if (s + n + (n % 2) > b.length) bad();
    if (id === 'fmt ') {
      if (fmt || n < 16 || b.readUInt16LE(s) !== 1 || b.readUInt16LE(s + 2) !== 1 || b.readUInt32LE(s + 4) !== RATE || b.readUInt32LE(s + 8) !== RATE * 2 || b.readUInt16LE(s + 12) !== 2 || b.readUInt16LE(s + 14) !== 16) bad();
      fmt = true;
    }
    if (id === 'data') { if (pcm || n % 2) bad(); pcm = b.subarray(s, s + n); }
    p = s + n + (n % 2);
  }
  if (!fmt || !pcm || !pcm.length) bad();
  return pcm;
}
export function wav(pcm) {
  if (pcm.length % 2) throw new Error('PCM16 requires whole samples');
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function chunkPlan(bytes) {
  return Array.from({ length: Math.ceil(bytes / CHUNK_BYTES) }, (_, i) => ({ offset: i * CHUNK_BYTES, bytes: Math.min(CHUNK_BYTES, bytes - i * CHUNK_BYTES), at_ms: i * 20 }));
}
export async function pace(pcm, send, { now = () => performance.now(), wait = sleep, signal } = {}) {
  const start = now();
  for (const c of chunkPlan(pcm.length)) {
    while (now() < start + c.at_ms) await wait(start + c.at_ms - now(), undefined, { signal });
    signal?.throwIfAborted();
    // Fail instead of bursting queued audio after an event-loop stall.
    if (now() - start - c.at_ms > 100) throw new Error('Audio pacing fell over 100 ms behind schedule');
    send(pcm.subarray(c.offset, c.offset + c.bytes), c);
  }
  while (now() < start + pcm.length / 32) await wait(start + pcm.length / 32 - now(), undefined, { signal });
}
export function safeEvent(event) {
  const copy = structuredClone(event);
  if (copy.type === 'session.input_audio.append') { copy.audio_bytes = Buffer.from(copy.audio, 'base64').length; delete copy.audio; }
  if (copy.type === 'session.output_audio.delta') { copy.audio_bytes = Buffer.from(copy.delta, 'base64').length; delete copy.delta; }
  return copy;
}
export function metrics(events, segments) {
  const sent = events.filter(e => e.direction === 'client' && e.type === 'session.input_audio.append');
  const actual = (ms) => {
    const e = sent.find(e => ms >= e.input_offset_ms && ms <= e.input_offset_ms + e.audio_bytes / 32);
    return e ? e.t_ms + ms - e.input_offset_ms : null;
  };
  const audio = events.filter(e => e.direction === 'server' && e.type === 'session.output_audio.delta' && e.audio_bytes > 0);
  const rows = segments.map((s, i) => {
    const start = actual(s.start_ms), end = actual(s.end_ms), next = segments[i + 1] ? actual(segments[i + 1].start_ms) : Infinity;
    const first = end === null ? undefined : audio.find(e => e.t_ms >= end && e.t_ms < (next ?? end));
    // Any audio in the utterance's window counts, including an unwanted backchannel during speech.
    const responded = start !== null && audio.some(e => e.t_ms >= start && e.t_ms < (next ?? start));
    return { ...s, speech_end_t_ms: end, first_output_audio_latency_ms: first ? first.t_ms - end : null, responded };
  });
  const open = new Set(), backchannel = [];
  let delegationCount = 0;
  for (const e of events) {
    if (e.direction === 'server' && e.type === 'session.delegation.created' && e.delegation?.target === 'client') { open.add(e.delegation.id); delegationCount++; }
    if (e.direction === 'client' && e.type === 'session.commentary.append') open.delete(e.delegation_id);
    if (e.direction === 'server' && e.type === 'session.output_transcript.delta' && open.size) backchannel.push({ t_ms: e.t_ms, text: e.delta, start_ms: e.start_ms, end_ms: e.end_ms, delegation_ids: [...open] });
    if (e.type === 'session.closed') open.clear();
  }
  const interruption = events.find(e => e.kind === 'probe' && e.name === 'interruption');
  const duration = events.at(-1)?.t_ms ?? 0;
  let handled = null;
  if (interruption) {
    const t = interruption.t_ms;
    const wasActive = audio.some(e => e.t_ms <= t && e.t_ms + e.audio_bytes / 32 >= t - 100);
    // Observational proxy: a >=200 ms receive gap starting within 1000 ms.
    const times = [t, ...audio.filter(e => e.t_ms > t).map(e => e.t_ms), duration];
    if (wasActive && duration >= t + 1200) handled = times.some((v, i) => v <= t + 1000 && times[i + 1] - v >= 200);
  }
  const latencies = rows.map(r => r.first_output_audio_latency_ms).filter(x => x !== null).sort((a, b) => a - b);
  return { utterances: rows, first_output_audio_latency_ms: rows.map(r => r.first_output_audio_latency_ms), solo_latency_p50_ms: latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null,
    backchannel_events: backchannel, delegation_count: delegationCount, interruption_handled: handled,
    unaddressed_response_count: rows.filter(r => r.addressed === false && r.responded).length, unaddressed_line_count: rows.filter(r => r.addressed === false).length,
    usage: events.findLast(e => e.type === 'session.closed' && e.direction === 'server')?.usage ?? null,
    session_duration_ms: duration, estimated_cost_usd: duration / 60000 * 0.05 };
}
export function writeReports(out, events, segments, output) {
  const m = metrics(events, segments);
  fs.writeFileSync(path.join(out, 'output.wav'), wav(Buffer.concat(output)));
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'metrics.md'), '# Metrics\n\n```json\n' + JSON.stringify(m, null, 2) + '\n```\n');
  fs.writeFileSync(path.join(out, 'transcript.md'), '# Transcript (receive order)\n\n' + events.filter(e => e.direction === 'server' && /session\.(input|output)_transcript\.delta/.test(e.type)).map(e => `- ${e.type.includes('input_') ? 'Input' : 'Output'} [${e.start_ms}–${e.end_ms} ms; received ${e.t_ms.toFixed(3)} ms]: ${String(e.delta).replaceAll('\n', ' ')}`).join('\n') + '\n');
  return m;
}
function loadFixture(file) {
  const pcm = parseWav(fs.readFileSync(file));
  const sidecar = file.replace(/\.wav$/i, '') + '.segments.json';
  const segments = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : [];
  if (!Array.isArray(segments)) throw new Error('Segments sidecar must be an array');
  let end = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.start_ms) || !Number.isFinite(s.end_ms) || s.start_ms < end || s.end_ms <= s.start_ms || s.end_ms > pcm.length / 32 + 0.001 || typeof s.text !== 'string' || typeof s.speaker !== 'string' || typeof s.addressed !== 'boolean') throw new Error('Invalid segments sidecar: require ordered, non-overlapping speech within WAV duration');
    end = s.end_ms;
  }
  return { pcm, segments };
}
export async function main(argv = process.argv.slice(2), runtime = {}) {
  const { values: v } = parseArgs({ args: argv, options: Object.fromEntries(['input', 'voice', 'instructions-file', 'append-instruction', 'backend-delay-ms', 'tail-ms', 'out', 'interrupt-at-ms', 'interrupt-input'].map(k => [k, { type: 'string' }]).concat([['thinking-progress', { type: 'boolean' }]])) });
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required; no socket opened');
  if (!v.input) throw new Error('--input <PCM16-mono-16000.wav> is required');
  const number = (key, fallback) => { const n = v[key] === undefined ? fallback : Number(v[key]); if (!Number.isFinite(n) || n < 0 || n > 3600000) throw new Error(`--${key} must be between 0 and 3600000`); return n; };
  const tail = number('tail-ms', 6000), delay = v['backend-delay-ms'] === undefined ? null : number('backend-delay-ms', 0);
  let { pcm, segments } = loadFixture(v.input);
  let interruptAt;
  if (v['interrupt-at-ms'] !== undefined) {
    interruptAt = Math.ceil(number('interrupt-at-ms', 0) / 20) * 20;
    if (interruptAt > pcm.length / 32 || segments.some(s => s.start_ms < interruptAt && s.end_ms > interruptAt)) throw new Error('--interrupt-at-ms must fall inside fixture silence (rounded up to 20 ms)');
    const extra = loadFixture(v['interrupt-input'] || path.join(here, 'fixtures/interrupt.wav'));
    const pad = Buffer.alloc((CHUNK_BYTES - extra.pcm.length % CHUNK_BYTES) % CHUNK_BYTES);
    const shift = (extra.pcm.length + pad.length) / 32;
    pcm = Buffer.concat([pcm.subarray(0, interruptAt * 32), extra.pcm, pad, pcm.subarray(interruptAt * 32)]);
    segments = [...segments.map(s => s.start_ms >= interruptAt ? { ...s, start_ms: s.start_ms + shift, end_ms: s.end_ms + shift } : s), ...extra.segments.map(s => ({ ...s, start_ms: s.start_ms + interruptAt, end_ms: s.end_ms + interruptAt }))].sort((a, b) => a.start_ms - b.start_ms);
  }
  const inputDuration = pcm.length / 32;
  pcm = Buffer.concat([pcm, Buffer.alloc(Math.round(tail * 16) * 2)]);
  const instructions = fs.readFileSync(v['instructions-file'] || path.join(here, 'prompts/caty-default.txt'), 'utf8');
  const out = path.resolve(v.out || path.join(here, 'runs', new Date().toISOString().replaceAll(':', '-')));
  fs.mkdirSync(out, { recursive: true });
  const WebSocket = runtime.WebSocket ?? (await import('ws')).default;
  const fd = fs.openSync(path.join(out, 'events.jsonl'), 'wx');
  const events = [], output = [], timers = new Set(), controller = new AbortController();
  const start = performance.now();
  const log = (entry) => { const row = JSON.parse(JSON.stringify({ ...entry, t_ms: performance.now() - start }).replaceAll(process.env.OPENAI_API_KEY, '[REDACTED]')); events.push(row); fs.writeSync(fd, JSON.stringify(row) + '\n'); };
  log({ kind: 'probe', name: 'run', segments, input_duration_ms: inputDuration, tail_ms: tail, output_rate_hz: RATE, wall_started_at: new Date().toISOString() });
  let ws, closing = false, started = false, seq = 0;
  try {
    await new Promise((resolve, reject) => {
      const fail = e => reject(e instanceof Error ? e : new Error(String(e)));
      const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); try { fn(); } catch (e) { fail(e); } }, ms); timers.add(id); return id; };
      const send = (event, meta = {}) => {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
        ws.send(JSON.stringify(event), e => { if (e) fail(e); });
        log({ ...safeEvent(event), ...meta, direction: 'client' });
      };
      ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, handshakeTimeout: 15000 });
      const startup = later(() => fail(new Error('Timed out waiting for session.started')), 20000);
      ws.on('error', () => fail(new Error('WebSocket connection error')));
      ws.on('close', () => fail(new Error('Socket closed before session.closed')));
      ws.on('open', () => {
        try { send({ type: 'session.start', event_id: 'event_start', session: { model: 'gpt-live-1', instructions, audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: v.voice || 'quartz' } }, delegation: { type: 'client' } } }); } catch (e) { fail(e); }
      });
      const delegated = new Set();
      ws.on('message', raw => {
        try {
          const e = JSON.parse(raw.toString());
          log({ ...safeEvent(e), direction: 'server' });
          if (e.type === 'error') throw new Error(`Server error: ${e.error?.message || e.message || 'unspecified error'}`);
          if (e.type === 'session.output_audio.delta') {
            if (typeof e.delta !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.delta)) throw new Error('Invalid output audio base64');
            const b = Buffer.from(e.delta, 'base64'); if (b.length % 2) throw new Error('Invalid PCM16 output audio'); output.push(b);
          }
          if (e.type === 'session.started') {
            if (started) throw new Error('Duplicate session.started');
            started = true; clearTimeout(startup); timers.delete(startup);
            if (v['append-instruction'] !== undefined) send({ type: 'session.instructions.append', event_id: `event_${++seq}`, delegation_id: null, content: v['append-instruction'] });
            pace(pcm, (b, c) => {
              if (c.at_ms === interruptAt) log({ kind: 'probe', name: 'interruption', input_offset_ms: c.at_ms });
              send({ type: 'session.input_audio.append', audio: b.toString('base64') }, { input_offset_ms: c.offset / 32 });
            }, { signal: controller.signal }).then(() => {
              closing = true;
              for (const timer of timers) clearTimeout(timer); timers.clear();
              send({ type: 'session.close' });
              later(() => fail(new Error('Timed out waiting for session.closed')), 10000);
            }).catch(fail);
          }
          if (e.type === 'session.delegation.created' && e.delegation?.target === 'client' && !closing) {
            const id = e.delegation.id;
            if (typeof id !== 'string' || delegated.has(id)) throw new Error('Invalid or duplicate delegation id');
            delegated.add(id);
            const ms = delay ?? 3000 + Math.floor(Math.random() * 5001);
            if (v['thinking-progress']) later(() => send({ type: 'session.thinking.append', event_id: `event_${++seq}`, delegation_id: id, content: '確認を進めています。もう少しお待ちください。' }), ms / 2);
            later(() => send({ type: 'session.commentary.append', event_id: `event_${++seq}`, delegation_id: id, content: 'これは接続テスト用の回答です。実際の情報は調べていません。確認ができたら短くお知らせしますね。' }), ms);
          }
          if (e.type === 'session.closed') { if (!closing) throw new Error('Session closed before input and tail completed'); resolve(); }
        } catch (e) { fail(e); }
      });
    });
  } catch (e) {
    log({ kind: 'probe', name: 'failure', message: String(e.message).replaceAll(process.env.OPENAI_API_KEY, '[REDACTED]') });
    throw e;
  } finally {
    controller.abort(); for (const timer of timers) clearTimeout(timer);
    ws?.removeAllListeners('message'); ws?.terminate();
    fs.closeSync(fd); writeReports(out, events, segments, output);
  }
  console.log(`Run written to ${out}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  const message = process.env.OPENAI_API_KEY ? e.message.replaceAll(process.env.OPENAI_API_KEY, '[REDACTED]') : e.message;
  console.error(`probe: ${message.replaceAll('\n', ' ')}`); process.exitCode = 1;
});
