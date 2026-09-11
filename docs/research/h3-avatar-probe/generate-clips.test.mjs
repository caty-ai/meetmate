import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, estimateCost, dataUri, requestBody, pollJob, checkedFetch, run } from './generate-clips.mjs';

const planText = await readFile(new URL('./clips.plan.json', import.meta.url), 'utf8');
const plan = parsePlan(planText);
const noNetwork = async () => { throw new Error('Unexpected network request'); };
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'h3-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('plan defaults, validation and cost guard', () => {
  assert.equal(plan.length, 4);
  assert.equal(estimateCost(plan), 1.08);
  assert.equal(estimateCost(plan, 1.08), 1.08);
  assert.throws(() => estimateCost(plan, 0.1), /exceeds.*no requests sent/);
  assert.throws(() => estimateCost(plan, NaN), /finite/);
  assert.throws(() => parsePlan('[]'), /non-empty/);
  assert.throws(() => parsePlan(JSON.stringify([plan[0], plan[0]])), /duplicate/);
  assert.throws(() => parsePlan(JSON.stringify([{ ...plan[0], name: '../escape' }])), /Invalid/);
  assert.throws(() => parsePlan(JSON.stringify([{ ...plan[0], resolution: '4K' }])), /no verified cost/);
  assert.throws(() => parsePlan(JSON.stringify([{ ...plan[0], images: Array(6).fill('x.png') }])), /unpriced/);
  const { duration, ...minimal } = plan[0];
  assert.equal(parsePlan(JSON.stringify([minimal]))[0].duration, 5);
});
test('PNG and MP3 data URIs have correct MIME and base64 round-trip', async t => {
  const dir = await temp(t);
  for (const [name, mime, bytes] of [['small.png', 'image/png', Buffer.from('89504e470d0a1a0a', 'hex')], ['small.mp3', 'audio/mpeg', Buffer.from('494433040000', 'hex')]]) {
    const path = join(dir, name);
    await writeFile(path, bytes);
    const uri = await dataUri(path);
    assert.ok(uri.startsWith(`data:${mime};base64,`));
    assert.deepEqual(Buffer.from(uri.split(',')[1], 'base64'), bytes);
  }
});
test('request body uses exactly the model schema fields', () => {
  assert.deepEqual(requestBody(plan[1], ['image-1', 'image-2'], ['audio-1']), {
    prompt: plan[1].prompt, reference_image_urls: ['image-1', 'image-2'], reference_audio_urls: ['audio-1'],
    duration: 5, resolution: '768P', aspect_ratio: 'adaptive', seed: 12, enable_safety_checker: true, prompt_expansion_mode: 'balanced',
  });
});
test('poll handles IN_QUEUE -> IN_PROGRESS -> COMPLETED and preserves query', async () => {
  const states = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];
  let sleeps = 0;
  await pollJob('https://example.invalid/status?existing=yes', {
    fetchFn: async url => {
      assert.equal(url.searchParams.get('logs'), '1');
      assert.equal(url.searchParams.get('existing'), 'yes');
      return { ok: true, json: async () => ({ status: states.shift() }) };
    }, sleep: async () => { sleeps++; },
  });
  assert.equal(sleeps, 2);
  assert.equal(states.length, 0);
});
test('poll rejects error/unknown statuses, HTTP errors and abort', async () => {
  for (const status of ['FAILED', 'ERROR', 'CANCELLED', 'unexpected', undefined]) {
    await assert.rejects(pollJob('https://example.invalid', { fetchFn: async () => ({ ok: true, json: async () => ({ status }) }) }), /Job failed/);
  }
  await assert.rejects(checkedFetch(async () => ({ ok: false, status: 429, text: async () => 'x'.repeat(300) }), 'https://example.invalid'), error => error.message === 'HTTP 429: ' + 'x'.repeat(200));
  await assert.rejects(pollJob('https://example.invalid', { fetchFn: noNetwork, signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('dry-run writes four redacted records, two polls each, no media/network', async t => {
  const dir = await temp(t);
  for (const upload of ['data', 'rest']) {
    await run(['--dry-run', '--upload', upload], { fetchFn: noNetwork, env: {}, outDir: dir, log: () => {} });
    assert.deepEqual((await readdir(dir)).sort(), ['idle', 'nod', 'smile', 'talk'].map(n => `${n}.dryrun.json`));
    for (const p of plan) {
      const record = JSON.parse(await readFile(join(dir, `${p.name}.dryrun.json`), 'utf8'));
      assert.equal(record.polls, 2);
      assert.equal(record.status, 'COMPLETED');
      assert.equal(record.request_body.prompt, p.prompt);
      for (const uri of [...record.request_body.reference_image_urls, ...record.request_body.reference_audio_urls]) assert.equal(uri.length, 64);
    }
  }
});
test('missing key, over-budget and unknown selection fail before fetch/output', async t => {
  const dir = await temp(t);
  const options = { fetchFn: noNetwork, outDir: dir, env: {}, log: () => {} };
  await assert.rejects(run([], options), /^Error: FAL_KEY is required unless --dry-run$/);
  await assert.rejects(run(['--max-usd', '0.1'], { ...options, env: { FAL_KEY: 'test-only' } }), /exceeds/);
  await assert.rejects(run(['--dry-run', '--only', 'absent'], options), /unknown/);
  assert.deepEqual(await readdir(dir), []);
});
test('live REST upload/submit/poll/result/download shapes with fake fetch only', async t => {
  const dir = await temp(t);
  const calls = [];
  const fake = async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    const json = value => new Response(JSON.stringify(value));
    if (target.endsWith('/storage/upload/initiate')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Key test-only');
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['content_type', 'file_name']);
      return json({ upload_url: 'https://example.invalid/upload', file_url: 'https://example.invalid/ref.png' });
    }
    if (target.endsWith('/upload')) {
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers.Authorization, undefined);
      assert.ok(Buffer.isBuffer(options.body));
      return new Response('');
    }
    if (target.endsWith('/reference-to-video')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), requestBody(plan[0], Array(2).fill('https://example.invalid/ref.png'), []));
      return json({ request_id: 'fake-1', status_url: 'https://example.invalid/status', response_url: 'https://example.invalid/result' });
    }
    if (target.includes('/status')) return json({ status: 'COMPLETED' });
    if (target.endsWith('/result')) return json({ video: { url: 'https://example.invalid/video' }, expanded_prompt: 'expanded' });
    if (target.endsWith('/video')) {
      assert.equal(options.headers, undefined);
      return new Response('test fixture bytes, not a playable video');
    }
    throw new Error('Unexpected URL');
  };
  await run(['--only', 'idle', '--upload', 'rest'], { fetchFn: fake, env: { FAL_KEY: 'test-only' }, outDir: dir, log: () => {} });
  assert.equal(calls.length, 8);
  const record = JSON.parse(await readFile(join(dir, 'idle.json'), 'utf8'));
  assert.equal(record.request_id, 'fake-1');
  assert.equal(record.expanded_prompt, 'expanded');
  assert.equal(record.file_size, (await readFile(join(dir, 'idle.mp4'))).length);
  assert.ok(record.generation_s >= 0);
});
