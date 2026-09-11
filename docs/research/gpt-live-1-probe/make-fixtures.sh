#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
for tool in say ffmpeg ffprobe node; do
  command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
mkdir -p fixtures
probe_tmp=$(mktemp -d "${TMPDIR:-/tmp}/gpt-live-fixtures.XXXXXX")
trap 'rm -rf "$probe_tmp"' EXIT
# Node orchestrates duration arithmetic and JSON without rounded shell math.
node --input-type=module - "$probe_tmp" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.on('uncaughtException', e => { console.error(`make-fixtures: ${e.message}`); process.exitCode = 1; });
const tmp = process.argv[2];
const scenarios = {
  solo: [
    ['A', 'キャティ、こんにちは。短く自己紹介して。', true, 8],
    ['A', 'キャティ、来週の福岡の天気を調べて教えて。', true, 8],
    ['A', 'キャティ、気分転換になる簡単なストレッチを一つ教えて。', true, 8],
  ],
  'two-speaker': [
    ['A', '今日のお昼、何を食べようか。午前中ずっと座っていたから、少し歩いて駅の向こうまで行ってみたいな。', false, 1.5],
    ['B', 'いいね。駅の近くに新しい定食屋さんができたでしょう。魚も野菜も食べられるし、そこはどうかな。', false, 1.5],
    ['A', 'そこは昨日も混んでいたよ。今日は一時から会議だから、あまり長く並ばないお店がいいと思うんだ。', false, 1.5],
    ['B', 'それなら公園の横のカフェにしようか。サンドイッチもあるし、テラスなら少しゆっくり話せそうだね。', false, 1.5],
    ['A', 'うん、それもよさそう。雨が降らなければ帰りに公園を通ろう。今から出れば席も空いているかもしれないね。', false, 1.5],
    ['A', 'キャティ、おすすめのランチある？', true, 8],
    ['B', 'じゃあ今日はカフェにしよう。先にエレベーターの前で待っているね。', false, 8],
  ],
  interrupt: [['A', 'ちょっと待って、違う話をしたい', true, 0]],
};
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const duration = f => {
  const n = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error('say produced no usable audio; check macOS speech service access and installed Japanese voices');
  return n;
};
const voices = run('say', ['-v', '?']).toString().split('\n');
const eddy = voices.find(line => line.startsWith('Eddy') && /\bja_JP\b/.test(line))?.split(/\s+ja_JP/)[0].trim();
if (!eddy) throw new Error('Japanese Eddy voice (ja_JP) is required');
console.log('fixture | duration_s | last_segment_end_ms | estimated_USD (audio only)');
for (const [name, lines] of Object.entries(scenarios)) {
  const segments = [], files = [];
  let samples = 0;
  for (const [i, [speaker, text, addressed, gap]] of lines.entries()) {
    const stem = path.join(tmp, `${name}-${i}`), clip = stem + '.wav';
    run('say', ['-v', speaker === 'A' ? 'Kyoko' : eddy, '-r', name === 'two-speaker' && i < 5 ? '230' : '190', '-o', stem + '.aiff', text]);
    run('ffmpeg', ['-v', 'error', '-y', '-i', stem + '.aiff', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'pcm_s16le', clip]);
    const length = Math.round(duration(clip) * 16000);
    segments.push({ speaker, start_ms: samples / 16, end_ms: (samples + length) / 16, text, addressed });
    samples += length; files.push(clip);
    if (gap) {
      const silence = stem + '-silence.wav';
      run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(gap), '-c:a', 'pcm_s16le', silence]);
      samples += Math.round(duration(silence) * 16000); files.push(silence);
    }
  }
  const list = path.join(tmp, name + '.txt');
  fs.writeFileSync(list, files.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));
  const output = path.join(tmp, name + '.wav');
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', output]);
  const seconds = duration(output);
  if (Math.abs(seconds * 16000 - samples) > 1) throw new Error(`Duration mismatch: ${name}`);
  fs.writeFileSync(output.replace(/\.wav$/, '.segments.json'), JSON.stringify(segments, null, 2) + '\n');
  console.log(`${name}.wav | ${seconds.toFixed(6)} | ${segments.at(-1).end_ms} | ${(seconds / 60 * .05).toFixed(6)}`);
}
for (const name of Object.keys(scenarios)) {
  for (const ext of ['.wav', '.segments.json']) fs.copyFileSync(path.join(tmp, name + ext), path.resolve('fixtures', name + ext));
}
JS
