import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleSentences, placeTimeline, resynthesize, fishTts, main } from './path3-resynth.mjs';
import { parseWav } from './probe.mjs';
const delta = (text, start, end, t) => ({ direction: 'server', type: 'session.output_transcript.delta', delta: text, start_ms: start, end_ms: end, t_ms: t });
const audio = t => ({ direction: 'server', type: 'session.output_audio.delta', audio_bytes: 640, t_ms: t });
export const fixture = [delta('あいう。', 0, 100, 100), audio(120), delta('かきく。', 200, 300, 300), audio(320)];

test('Path 3 assembles punctuation gaps, start gaps, max chars and EOF in receive order', () => {
  const rows = assembleSentences([delta('こん', 0, 100, 10), delta('にちは。', 100, 200, 20),
    delta('やさしく', 250, 300, 30), delta('なるほど。', 1900, 2000, 40), delta('続きです', 2010, 2100, 50)]);
  assert.deepEqual(rows.map(s => s.text), ['こんにちは。', 'やさしく', 'なるほど。', '続きです']);
  assert.equal(rows[0].close_reason, 'punctuation-gap');
  assert.deepEqual([rows[0].first_delta_start_ms, rows[0].last_delta_end_ms, rows[0].first_delta_t_ms, rows[0].closed_t_ms], [0, 200, 10, 30]);
  assert.equal(rows[1].fragment, true);
  assert.equal(rows[1].closed_t_ms, 40);
  assert.equal(rows[2].backchannel, true);
  assert.equal(rows[3].fragment, false);
  const max = assembleSentences([delta('あいう', 0, 100, 10), delta('えお', 100, 200, 20)], { maxChars: 3 });
  assert.equal(max[0].close_reason, 'max-chars');
  assert.equal(max[0].closed_t_ms, 10);
  assert.equal(max[1].fragment, true);
  assert.equal(assembleSentences([delta('やさしく', 0, 100, 10), delta('次です。', 1601, 1700, 20)], { maxChars: 4 })[0].fragment, true);
  assert.equal(assembleSentences([delta('はい', 0, 100, 10)])[0].backchannel, true);
  assert.equal(assembleSentences([delta('はい、次です。', 0, 100, 10)])[0].backchannel, false);
  // A 600 ms start gap does not exceed the threshold.
  assert.equal(assembleSentences([delta('あいう', 0, 100, 10), delta('えおか', 600, 700, 20)]).length, 1);
});

test('Path 3 timeline uses receive audio baseline and waits for previous playback', () => {
  const rows = [100, 200].map(t => ({ first_delta_t_ms: t, closed_t_ms: t + 100, ttfb_ms: 350, pcm: Buffer.alloc(32000) }));
  const placed = placeTimeline(rows, [audio(90), audio(130), audio(230)]);
  assert.deepEqual(placed.rows.map(s => s.start_ms), [550, 1550]);
  assert.deepEqual(placed.rows.map(s => s.added_delay_ms), [420, 1320]);
  assert.equal(placed.pcm.length, 2550 * 32);
  assert.equal(placeTimeline(rows, [], { startOn: 'first' }).rows[0].added_delay_ms, 350);
});

test('Path 3 skip flags preserve flagged rows and charge only synthesized text', async () => {
  const events = [delta('はい。', 0, 100, 10), delta('うん', 200, 300, 20)];
  const normal = (await resynthesize(events)).metrics;
  assert.equal(normal.backchannel_count, 2);
  assert.equal(normal.fragment_count, 1);
  assert.equal(normal.synthesized_count, 1);
  assert.equal(normal.fish_chars_total, 3);
  const skipped = (await resynthesize(events, { skipBackchannels: true })).metrics;
  assert.equal(skipped.sentences.length, 2);
  assert.equal(skipped.added_delay_p50_ms, null);
  assert.equal((await resynthesize(events, { skipFragments: false })).metrics.synthesized_count, 2);
});

test('Path 3 dry-run end-to-end writes valid WAV and expected median offline', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'path3-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const run = path.join(temp, 'fixture');
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'events.jsonl'), fixture.map(e => JSON.stringify(e)).join('\n'));
  const m = await main(['--run', run, '--dry-run'], { env: {}, outputRoot: path.join(temp, 'path3'), fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.deepEqual(m.sentences.map(s => s.added_delay_ms), [530, 1050]);
  assert.equal(m.added_delay_p50_ms, 790);
  assert.equal(m.added_delay_max_ms, 1050);
  assert.equal(m.fish_chars_total, 8);
  const out = path.join(temp, 'path3/fixture');
  assert.equal(parseWav(fs.readFileSync(path.join(out, 'output.wav'))).length, 2090 * 32);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'))).added_delay_p50_ms, 790);
  assert.match(fs.readFileSync(path.join(out, 'metrics.md'), 'utf8'), /assumption: USD 15/);
});

test('Path 3 Fish request and streamed first-byte timing match contract', async () => {
  let clock = 0;
  const result = await fishTts('テスト。', { key: 'fake-key', voice: 'voice-id', now: () => clock,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.fish.audio/v1/tts');
      assert.equal(init.method, 'POST');
      assert.deepEqual(init.headers, { Authorization: 'Bearer fake-key', 'Content-Type': 'application/json', model: 's2.1-pro' });
      assert.deepEqual(JSON.parse(init.body), { text: 'テスト。', reference_id: 'voice-id', format: 'pcm', sample_rate: 16000, latency: 'low' });
      return { ok: true, body: (async function* () { clock = 100; yield Buffer.alloc(0); clock = 350; yield Buffer.alloc(3); clock = 500; yield Buffer.alloc(1); })() };
    } });
  assert.equal(result.ttfb_ms, 350);
  assert.equal(result.total_ms, 500);
  assert.equal(result.pcm.length, 4);
});

test('Path 3 fails closed for missing key, HTTP error and malformed PCM', async () => {
  await assert.rejects(main(['--run', '/missing'], { env: {}, fetchImpl: () => assert.fail('request made') }), /FISH_API_KEY/);
  await assert.rejects(fishTts('text', { key: 'secret', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'secret' + 'x'.repeat(300) }) }), e => {
    assert.equal(e.message, 'Fish TTS HTTP 429: [REDACTED]' + 'x'.repeat(190)); return true;
  });
  for (const length of [0, 1]) await assert.rejects(fishTts('text', { key: 'fake', fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.alloc(length); })() }) }), /PCM16/);
  const env = { ...process.env }; delete env.FISH_API_KEY;
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./path3-resynth.mjs', import.meta.url)), '--run', '/missing'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, 'path3-resynth: FISH_API_KEY is required; no request made\n');
});
