import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { parseWav, wav } from './probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const punctuation = /[。？！?!、]$/u;
const backchannel = /^(?:うん|はい|なるほど|ええ)[。？！?!、]*$/u;
const finiteTime = n => Number.isFinite(n) && n >= 0;

export function assembleSentences(events, { gapMs = 600, maxChars = 40 } = {}) {
  const deltas = events.filter(e => e.direction === 'server' && e.type === 'session.output_transcript.delta');
  const sentences = [];
  let current, previous;
  const close = (t, reason, followingGap = 0) => {
    if (!current) return;
    const text = current.text.trim();
    if (text) sentences.push({ ...current, text, closed_t_ms: t, close_reason: reason,
      fragment: text.length < 3 || (!punctuation.test(text) && followingGap > 1500),
      backchannel: backchannel.test(text) });
    current = undefined;
  };
  for (const e of deltas) {
    if (typeof e.delta !== 'string' || ![e.start_ms, e.end_ms, e.t_ms].every(finiteTime) || e.end_ms < e.start_ms) throw new Error('Invalid output transcript delta');
    if (!e.delta) continue;
    const gap = previous ? e.start_ms - previous.start_ms : 0;
    if (!current && gap > 1500 && sentences.length && !punctuation.test(sentences.at(-1).text)) sentences.at(-1).fragment = true;
    if (current && (gap > gapMs || (punctuation.test(current.text.trimEnd()) && e.start_ms > previous.end_ms))) {
      close(e.t_ms, gap > gapMs ? 'gap' : 'punctuation-gap', gap);
    }
    if (!current) current = { text: '', first_delta_start_ms: e.start_ms, first_delta_t_ms: e.t_ms };
    current.text += e.delta;
    current.last_delta_end_ms = e.end_ms;
    if (current.text.length >= maxChars) close(e.t_ms, 'max-chars', 0);
    previous = e;
  }
  // EOF is observed at the last recorded receive time, not a guessed timeout.
  close(Math.max(previous?.t_ms ?? 0, ...events.filter(e => finiteTime(e.t_ms)).map(e => e.t_ms)), 'eof');
  return sentences;
}

export async function fakeTts(text) {
  // Virtual clock: deterministic 350 ms wait, without sleeping in offline tests.
  return { pcm: Buffer.alloc(text.length * 180 * 32), ttfb_ms: 350, total_ms: 350 };
}

export async function fishTts(text, { key, voice, fetchImpl = fetch, now = () => performance.now() }) {
  if (!key?.trim()) throw new Error('FISH_API_KEY is required; no request made');
  const started = now();
  const response = await fetchImpl('https://api.fish.audio/v1/tts', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: 's2.1-pro' },
    body: JSON.stringify({ text, reference_id: voice, format: 'pcm', sample_rate: 16000, latency: 'low' }),
  });
  if (!response.ok) {
    const body = (await response.text()).replaceAll(key, '[REDACTED]').slice(0, 200);
    throw new Error(`Fish TTS HTTP ${response.status}: ${body}`);
  }
  const chunks = [];
  let ttfb;
  if (response.body) for await (const chunk of response.body) {
    if (!chunk.length) continue;
    ttfb ??= now() - started;
    chunks.push(Buffer.from(chunk));
  }
  const pcm = Buffer.concat(chunks);
  if (!pcm.length || pcm.length % 2) throw new Error('Fish TTS returned empty or incomplete PCM16 audio');
  return { pcm, ttfb_ms: ttfb, total_ms: now() - started };
}

export function placeTimeline(sentences, events, { startOn = 'close' } = {}) {
  const audio = events.filter(e => e.direction === 'server' && e.type === 'session.output_audio.delta' && e.audio_bytes > 0);
  let end = 0;
  const rows = sentences.map(({ pcm, ...s }) => {
    if (!pcm) return { ...s, start_ms: null, end_ms: null, added_delay_ms: null };
    const startT = startOn === 'first' ? s.first_delta_t_ms : s.closed_t_ms;
    const start = Math.max(startT + s.ttfb_ms, end);
    const original = audio.find(e => e.t_ms >= s.first_delta_t_ms)?.t_ms ?? s.first_delta_t_ms;
    end = start + pcm.length / 32;
    return { ...s, start_ms: start, end_ms: end, original_first_audio_t_ms: original, added_delay_ms: start - original };
  });
  // Round placement to the nearest 16 kHz sample; metrics retain exact ms.
  const pcm = Buffer.alloc(Math.max(1, ...rows.map((r, i) => r.start_ms === null ? 0 : Math.round(r.start_ms * 16) + sentences[i].pcm.length / 2)) * 2);
  rows.forEach((r, i) => { if (r.start_ms !== null) sentences[i].pcm.copy(pcm, Math.round(r.start_ms * 16) * 2); });
  return { rows, pcm };
}

export async function resynthesize(events, options = {}, tts = fakeTts) {
  const { skipFragments = true, skipBackchannels = false, fishUsdPer1mChars = 15 } = options;
  const sentences = assembleSentences(events, options);
  const synthesized = [];
  for (const s of sentences) {
    const skipped = (skipFragments && s.fragment) || (skipBackchannels && s.backchannel);
    synthesized.push({ ...s, skipped, ttfb_ms: null, total_ms: null, ...(skipped ? {} : await tts(s.text)) });
  }
  const { rows, pcm } = placeTimeline(synthesized, events, options);
  const delays = rows.filter(s => !s.skipped).map(s => s.added_delay_ms).sort((a, b) => a - b);
  const chars = rows.filter(s => !s.skipped).reduce((n, s) => n + s.text.length, 0);
  return { pcm, metrics: { dry_run: options.dryRun ?? true, start_on: options.startOn ?? 'close',
    gap_ms: options.gapMs ?? 600, max_chars: options.maxChars ?? 40, skip_fragments: skipFragments, skip_backchannels: skipBackchannels,
    sentences: rows, sentence_count: rows.length, synthesized_count: delays.length, skipped_count: rows.length - delays.length,
    backchannel_count: rows.filter(s => s.backchannel).length, fragment_count: rows.filter(s => s.fragment).length,
    added_delay_p50_ms: delays.length ? (delays[Math.floor((delays.length - 1) / 2)] + delays[Math.floor(delays.length / 2)]) / 2 : null,
    added_delay_max_ms: delays.length ? delays.at(-1) : null, fish_chars_total: chars,
    fish_usd_per_1m_chars_assumption: fishUsdPer1mChars, estimated_cost_usd: chars / 1e6 * fishUsdPer1mChars } };
}

function markdown(m) {
  const cell = v => String(v ?? '—').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  return `# Path 3 metrics\n\nDry run: ${m.dry_run}; start-on: ${m.start_on}.\n\n` +
    '| text | backchannel | fragment | skipped | ttfb_ms | total_ms | added_delay_ms |\n|---|---|---|---|---|---|---|\n' +
    m.sentences.map(s => '| ' + [s.text, s.backchannel, s.fragment, s.skipped, s.ttfb_ms, s.total_ms, s.added_delay_ms].map(cell).join(' | ') + ' |').join('\n') +
    `\n\nAdded delay p50: ${m.added_delay_p50_ms ?? 'n/a'} ms; max: ${m.added_delay_max_ms ?? 'n/a'} ms.\n` +
    `Sentences: ${m.sentence_count}; synthesized: ${m.synthesized_count}; skipped: ${m.skipped_count}; backchannels: ${m.backchannel_count}; fragments: ${m.fragment_count}.\n` +
    `Fish chars: ${m.fish_chars_total}. Estimated cost: USD ${m.estimated_cost_usd} (assumption: USD ${m.fish_usd_per_1m_chars_assumption}/1M characters; dry-run incurs no charges).\n\n` +
    'Synthesis requests are sequential; placement simulates per-sentence TTFB and playback queuing, not the serial request wall clock. A Bridge would pipeline requests. Full PCM is assumed playable from TTFB; stream stalls are not modeled.\n';
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const { values: v } = parseArgs({ args: argv, allowNegative: true, options: {
    run: { type: 'string' }, voice: { type: 'string', default: '0089dce5fefb4c6ba9b9f2f0debe1ddc' },
    'gap-ms': { type: 'string', default: '600' }, 'max-chars': { type: 'string', default: '40' },
    'start-on': { type: 'string', default: 'close' }, 'skip-fragments': { type: 'boolean', default: true },
    'skip-backchannels': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    'fish-usd-per-1m-chars': { type: 'string', default: '15' },
  } });
  const key = (runtime.env ?? process.env).FISH_API_KEY;
  if (!v['dry-run'] && !key?.trim()) throw new Error('FISH_API_KEY is required; no request made');
  if (!v.run) throw new Error('--run <recorded-run-directory> is required');
  if (!['close', 'first'].includes(v['start-on'])) throw new Error('--start-on must be close or first');
  const number = (name, positive = false) => {
    const n = Number(v[name]);
    if (!v[name].trim() || !Number.isFinite(n) || n < 0 || (positive && (!Number.isInteger(n) || n < 1))) throw new Error(`Invalid --${name}`);
    return n;
  };
  const options = { gapMs: number('gap-ms'), maxChars: number('max-chars', true), fishUsdPer1mChars: number('fish-usd-per-1m-chars'),
    startOn: v['start-on'], skipFragments: v['skip-fragments'], skipBackchannels: v['skip-backchannels'], dryRun: v['dry-run'] };
  const run = path.resolve(v.run);
  const events = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s));
  const result = await resynthesize(events, options, v['dry-run'] ? fakeTts : text => fishTts(text, { key, voice: v.voice, fetchImpl: runtime.fetchImpl }));
  const output = path.join(runtime.outputRoot ?? path.join(here, 'path3'), path.basename(run));
  const wave = wav(result.pcm);
  parseWav(wave);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'output.wav'), wave);
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(result.metrics, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'metrics.md'), markdown(result.metrics));
  console.log(`Path 3 written to ${output}`);
  return result.metrics;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  const key = process.env.FISH_API_KEY;
  const message = key ? String(e.message).replaceAll(key, '[REDACTED]') : String(e.message);
  console.error(`path3-resynth: ${message.replace(/[\r\n]/g, ' ')}`);
  process.exitCode = 1;
});
