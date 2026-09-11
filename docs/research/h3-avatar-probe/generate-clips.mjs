import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RATES = Object.freeze({ '480P': 0.05, '768P': 0.06, '2K': 0.13 });
const ASSUMPTIONS = 'fal list price 2026-09-11: 480P $0.05/s, 768P $0.06/s, 2K $0.13/s; first 5 reference images free. Estimate only; excludes unpriced charges.';
const MIME = { '.png': 'image/png', '.mp3': 'audio/mpeg' };

export function parsePlan(text) {
  const plan = JSON.parse(text);
  if (!Array.isArray(plan) || !plan.length) throw new Error('Plan must be a non-empty array');
  const names = new Set();
  return plan.map(item => {
    const p = { duration: 5, resolution: '768P', aspect_ratio: 'adaptive', enable_safety_checker: true, prompt_expansion_mode: 'balanced', ...item };
    if (!/^[a-zA-Z0-9_-]+$/.test(p.name ?? '') || names.has(p.name)) throw new Error('Invalid or duplicate clip name');
    names.add(p.name);
    if (!Number.isSafeInteger(p.duration) || p.duration <= 0 || !Number.isSafeInteger(p.seed)) throw new Error(`${p.name}: duration and seed must be integers (duration > 0)`);
    if (!Object.hasOwn(RATES, p.resolution)) throw new Error(`${p.name}: no verified cost rate for resolution ${p.resolution}`);
    if (typeof p.prompt !== 'string' || !p.prompt.trim() || typeof p.aspect_ratio !== 'string' || typeof p.prompt_expansion_mode !== 'string' || typeof p.enable_safety_checker !== 'boolean') throw new Error(`${p.name}: invalid prompt/options`);
    for (const [field, extension] of [['images', '.png'], ['audio', '.mp3']]) {
      if (!Array.isArray(p[field]) || p[field].some(path => typeof path !== 'string' || extname(path).toLowerCase() !== extension)) throw new Error(`${p.name}: invalid ${field}`);
    }
    if (p.images.length > 5) throw new Error(`${p.name}: more than 5 images has unpriced cost`);
    return p;
  });
}

export function estimateCost(plan, maxUsd = 5) {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error('--max-usd must be finite and >= 0');
  const total = plan.reduce((sum, p) => sum + p.duration * RATES[p.resolution], 0);
  if (!Number.isFinite(total)) throw new Error('Cannot estimate plan cost');
  if (total > maxUsd + 1e-9) throw new Error(`Estimated cost $${total.toFixed(2)} exceeds --max-usd $${maxUsd.toFixed(2)}; no requests sent`);
  return total;
}

export async function dataUri(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error('Unsupported reference MIME type');
  return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
}

export function requestBody(p, images, audio) {
  return { prompt: p.prompt, reference_image_urls: images, reference_audio_urls: audio,
    duration: p.duration, resolution: p.resolution, aspect_ratio: p.aspect_ratio ?? 'adaptive', seed: p.seed,
    enable_safety_checker: p.enable_safety_checker ?? true, prompt_expansion_mode: p.prompt_expansion_mode ?? 'balanced' };
}

export async function checkedFetch(fetchFn, url, options = {}) {
  const response = await fetchFn(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response;
}

export async function pollJob(statusUrl, { fetchFn = fetch, headers = {}, pollMs = 3000, timeoutMs = 900000, signal = AbortSignal.timeout(timeoutMs), sleep = ms => delay(ms, undefined, { signal }) } = {}) {
  const url = new URL(statusUrl);
  url.searchParams.set('logs', '1');
  for (;;) {
    signal.throwIfAborted();
    const result = await (await checkedFetch(fetchFn, url, { headers, signal })).json();
    if (result.status === 'COMPLETED') return result;
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(result.status)) throw new Error(`Job failed: status ${result.status ?? 'missing'}`);
    await sleep(pollMs);
  }
}

function logBody(body) {
  return { ...body, ...Object.fromEntries(['reference_image_urls', 'reference_audio_urls'].map(field => [field, body[field].map(url => url.startsWith('data:') ? url.slice(0, 64) : url)])) };
}

async function upload(path, { fetchFn, headers, signal }) {
  const contentType = MIME[extname(path).toLowerCase()];
  const bytes = await readFile(path);
  const result = await (await checkedFetch(fetchFn, 'https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ file_name: path.split('/').at(-1), content_type: contentType }),
  })).json();
  if (!result.upload_url || !result.file_url) throw new Error('Upload response missing upload_url/file_url');
  await checkedFetch(fetchFn, result.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes, signal });
  return result.file_url;
}

export async function run(args = [], { fetchFn = fetch, env = process.env, outDir = resolve(HERE, 'clips'), log = console.log } = {}) {
  const { values } = parseArgs({ args, options: {
    plan: { type: 'string', default: resolve(HERE, 'clips.plan.json') }, only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, upload: { type: 'string', default: 'data' },
    'poll-ms': { type: 'string', default: '3000' }, 'timeout-ms': { type: 'string', default: '900000' }, 'max-usd': { type: 'string', default: '5' },
  } });
  if (!['data', 'rest'].includes(values.upload)) throw new Error('--upload must be data or rest');
  const pollMs = Number(values['poll-ms']), timeoutMs = Number(values['timeout-ms']);
  if (![pollMs, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) throw new Error('poll/timeout milliseconds must be positive integers <= 2147483647');
  const dryRun = values['dry-run'];
  if (!dryRun && !env.FAL_KEY?.trim()) throw new Error('FAL_KEY is required unless --dry-run');
  const planPath = resolve(values.plan);
  let plan = parsePlan(await readFile(planPath, 'utf8'));
  if (values.only !== undefined) {
    const names = values.only.split(',');
    if (names.some(name => !plan.some(p => p.name === name))) throw new Error('--only contains unknown clip name');
    plan = plan.filter(p => names.includes(p.name));
  }
  const total = estimateCost(plan, Number(values['max-usd']));
  // Validate/read every selected asset before any upload or paid request.
  const refs = new Map();
  for (const p of plan) for (const name of [...p.images, ...p.audio]) {
    const path = resolve(dirname(planPath), name);
    if (!refs.has(path)) refs.set(path, await dataUri(path));
  }
  await mkdir(outDir, { recursive: true });
  const rows = [];
  for (const p of plan) {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = dryRun ? {} : { Authorization: `Key ${env.FAL_KEY}` };
    const urls = [];
    for (const names of [p.images, p.audio]) {
      const group = [];
      for (const name of names) {
        const path = resolve(dirname(planPath), name);
        group.push(!dryRun && values.upload === 'rest' ? await upload(path, { fetchFn, headers, signal }) : refs.get(path));
      }
      urls.push(group);
    }
    const body = requestBody(p, ...urls);
    const cost = p.duration * RATES[p.resolution];
    if (dryRun) {
      let polls = 0;
      await pollJob('https://dry-run.invalid/status', { fetchFn: async () => ({ ok: true, json: async () => ({ status: ++polls === 2 ? 'COMPLETED' : 'IN_QUEUE' }) }), sleep: async () => {}, signal });
      await writeFile(resolve(outDir, `${p.name}.dryrun.json`), JSON.stringify({ dry_run: true, upload_requested: values.upload, request_body: logBody(body), data_uri_log_limit: 64, polls, status: 'COMPLETED', estimated_cost_usd: cost, cost_assumptions: ASSUMPTIONS }, null, 2) + '\n');
      rows.push(`${p.name}\tDRY-RUN\t-\t-\t$${cost.toFixed(2)}`);
      continue;
    }
    const started = Date.now();
    const job = await (await checkedFetch(fetchFn, 'https://queue.fal.run/minimax/h3/reference-to-video', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })).json();
    if (!job.request_id || !job.status_url || !job.response_url) throw new Error('Submit response missing request_id/status_url/response_url');
    const recordPath = resolve(outDir, `${p.name}.json`);
    const record = { request_id: job.request_id, submitted_at: new Date(started).toISOString(), completed_at: null, generation_s: null, expanded_prompt: null, file_size: null, estimated_cost_usd: cost, cost_assumptions: ASSUMPTIONS };
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
    await pollJob(job.status_url, { fetchFn, headers, pollMs, signal });
    const completed = Date.now();
    record.completed_at = new Date(completed).toISOString();
    record.generation_s = (completed - started) / 1000;
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
    const result = await (await checkedFetch(fetchFn, job.response_url, { headers, signal })).json();
    if (!result.video?.url) throw new Error('Result missing video.url');
    record.expanded_prompt = result.expanded_prompt ?? null;
    const media = await checkedFetch(fetchFn, result.video.url, { signal });
    const path = resolve(outDir, `${p.name}.mp4`), partial = `${path}.part`;
    let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(media.body), async function* (source) { for await (const chunk of source) { bytes += chunk.length; yield chunk; } }, createWriteStream(partial), { signal });
      await rename(partial, path);
    } finally { await rm(partial, { force: true }); }
    record.file_size = bytes;
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
    rows.push(`${p.name}\tCOMPLETED\t${record.generation_s.toFixed(3)}\t${bytes}\t$${cost.toFixed(2)}`);
  }
  log(['clip\tstatus\tgeneration_s\tbytes\testimated_usd', ...rows, `Total estimated: $${total.toFixed(2)}`].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch(error => {
    let message = String(error.message);
    if (process.env.FAL_KEY) message = message.split(process.env.FAL_KEY).join('[REDACTED]');
    console.error(message.replace(/[\r\n]+/g, ' '));
    process.exitCode = 1;
  });
}
