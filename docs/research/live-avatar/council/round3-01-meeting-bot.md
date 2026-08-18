# Round 3 — Meeting Bot / WebRTC Adversarial Debate

Role: Councilor 1, Meeting Bot / WebRTC Architect
Date: 2026-07-23
Status: adversarial review; implementation recommendationではない

## 冒頭結論

Round 2 の中心的合意である「static baseline → A+E → A+LiveAvatar LITE」は合理的だが、まだ二つの飛躍がある。

1. A+E を最初の実験単位にする必要はない。最初に反証すべきなのは Attendee webpage の音声搬送であり、avatar renderer の前に tone/PCM + canvas flash だけの A carrier probe で足りる。
2. 共通 Media Shell を先に作る必要もない。PoC で共通と証明済みなのは PCM の source stamp、generation、cancel、close だけであり、queue、ready、ack、delete、video timing は adapter ごとに意味が違う。

以下では各問いを **Fact / Inference / Unknown** に分け、主張を最小コストで倒せる実験を明記する。

## 1 なぜ以前のRecall構成は音質が悪かった可能性があるのか。

**Fact**

- 過去に実際に「音質が悪かった」か、その症状が noise、dropout、clipping、wrong speed、delay のどれだったかを結びつける録音・ログ・commit 記録は残っていない。
- `d3d86d7` は network chunk ごとに `AudioBufferSourceNode` を作り、単一 `playCursor` で再生した。bounded jitter queue、underrun counter、meeting playout timestamp はなかった。
- `b5fbff1` は unconstrained `AudioContext`、`ScriptProcessorNode(4096)`、手動平均 downsample を使った。`0cd1e52` は input を AudioWorklet に移したが、4096-sample flush と output scheduler は残った。
- `02ece31` は input を Recall raw mixed audio に変え、`b9549f6` で必要な artifact enablement が後から追加された。
- 当時の Recall compute variant は payload で指定されていない。現在の Recall は CPU pressure と choppy output の関係、および `web_4_core` 比較を案内している ([Recall Output Media](https://docs.recall.ai/docs/stream-media))。
- `bbe1544` の Fish/prompt/tag 変更は `de1d03e` で一括 revert されたが、理由は記録されていない。現在 main は別経路で Fish S2-Pro / 24 kHz を採用している。

**Inference**

Browser scheduling、actual sample-rate mismatch、resampling、CPU starvation、WebRTC/meeting codec、network jitter、echo gate、Fish change のいずれも原因候補ではある。複数の failure domain を同時に変え、計測しなかったことが診断不能の直接原因だった、という推論は強い。

**Unknown**

歴史的な音質劣化の有無、主症状、affected commit、meeting platform、actual AudioContext rate、compute variant、CPU、network trace、放棄理由、S2-Pro revert 理由はすべて unknown である。「Recall が原因」「browser が原因」「Fish が原因」の単独断定はできない。

**最小の反証実験**

過去原因に関する単独断定を反証する最小手段は、新しい再現実験ではなく、commit/session に紐づく録音または runtime log を1件回収することだ。新しい実験は「現在その仮説が再現するか」は測れるが、「過去の原因だったか」は証明できない。

現在の browser-scheduler 仮説だけを倒す最小実験は、同じ frozen 24 kHz PCM を同一 Recall container で (a) historical per-chunk scheduler と (b) bounded clock-driven queue に流し、observer recording と underrun/sample-count を比較する 2 条件試験である。差が再現しなければ scheduler 単独原因説は弱まるが、歴史的原因が確定するわけではない。

## 2 Attendee webpage方式でも同じ問題が再発しないか。

**Fact**

Attendee Voice Agents は public HTTPS page の audio/video を 1280×720 container から meeting に取り込む ([Attendee Voice Agents](https://docs.attendee.dev/guides/voiceagents))。A は current `realtime_audio.bot_output` (`src/transport-meet/meet-routes.js:1319-1329`) をそのまま使う方式ではなく、Fish PCM → browser conversion/playout → page capture → WebRTC/meeting codec という新しい egress になる。

**Inference**

A は Recall から Attendee に vendor を変えるが、browser clock、resampling、scheduler、container CPU、capture、meeting codec という failure class は共有する。したがって再発は十分あり得る。Attendee を既に利用していることは、この新しい page-audio path の品質証拠ではない。

一方で、current 24 kHz fixture、bounded queue、actual-rate logging、single-variable test、observer capture があれば、過去より診断可能である。「再発しない」のではなく「再発時に場所を特定しやすい」が正しい。

**Unknown**

Attendee container の actual `AudioContext.sampleRate/state`、autoplay、internal resampling、capture buffer、CPU telemetry、Google Meet/Zoom parity、direct mixed input と page-owned output の安全な組み合わせは unknown。

**最小の反証実験**

A が baseline-quality audio を運べるという主張を倒す最小実験は avatar なしの carrier probe である。既知の 24 kHz S16LE tone/transient + speech fixture を bounded page player で再生し、actual rate/state、source/queue/sample counts を記録しながら Google Meet observer で録音する。static Attendee の同一 fixture と blind/metric 比較し、dropout、speed、clipping、latency のいずれかが再現すれば、E や LITE を作る前に A 仮説は反証される。

この probe に photorealistic avatar、viseme engine、generic vendor adapter は不要である。

## 3 LiveAvatar LITEは本当に映像rendererだけとして使えるか。

**Fact**

[LiveAvatar overview](https://docs.liveavatar.com/) は LITE で customer が STT/LLM/TTS/WebRTC を供給すると説明する。[Official LITE starter](https://github.com/heygen-com/liveavatar-starter-livekit-agent-python) は backend audio WebSocket に raw PCM S16LE mono 24 kHz を base64 で送り、`start`、`agent.speak`、`agent.speak_end`、`agent.interrupt` を使う。frontend は video-only で、通常の downstream audio と avatar に同じ upstream TTS frame を tee する。

これは **wire contract 上は renderer-only** であり、単なる marketing claim より強い。FULL は ASR/LLM/TTS/turn/WebRTC を vendor が握るため renderer-only ではない。

**Inference**

LITE を Meetmate の Agent Core から独立した renderer adapter として扱える可能性は高い。ただし「video-only frontend」は meeting への映像 handoff、remote queue purge、acknowledged samples、first-frame timestamp、billing cleanup の品質を証明しない。

**Unknown**

Remote backpressure/queue limit、accepted sample acknowledgement、render delay distribution、`agent.interrupt` から last frame まで、reconnect/idempotency、delete failure、retention/region/training、実効コストは unknown。

**最小の反証実験**

Renderer-only 主張を倒す最小実験は、transcript、LLM、STT、vendor TTS、turn event を一切与えず、ephemeral session に既知 PCM と明示的 start/end/interrupt だけを送る sandbox test である。Network/event trace を保存し、video が生成され、frontend から audio が出ず、text/ASR/turn API が要求されず、interrupt/delete 後に motion/session が停止することを確認する。どれか一つでも必須なら renderer-only verdict を撤回する。

## 4 Fish AudioのPCMを二重生成せず、会議音声と口の動きへ同じsourceとして渡せるか。

**Fact**

Current Fish PCM は一度だけ `onAudio(chunk)` に到達する (`src/pipeline.js:2207-2227`)。default は 24 kHz で、odd-byte alignment も Fish stream 内で処理済み (`src/config.js:9-16`, `src/config.js:350-363`; `src/tts-fish.js:199-259`)。LiveAvatar LITE ingress も 24 kHz mono S16LE である。E は同じ PCM から local envelope/viseme を導出できる。

**Inference**

一つの source PCM を sequence/sample index 付きで二 branch に渡すことは可能であり、二度目の Fish request は不要である。ただし保証できるのは:

1. one Fish generation;
2. application tee 前の source equality;
3. transport framing 前の outbound PCM lineage;

までである。Meeting と renderer の decoded/rendered waveform、timing、sample acceptance が同一とは限らない。A/V alignment のため meeting branch を delay しても source equality は保てるが、latency と cancel tail は変わる。

**Unknown**

Vendor が全 sample を accept/render するか、page/meeting codec 後に何が聞こえるか、remote queue が何を discard するかは unknown。

**最小の反証実験**

一生成・同一 source 主張を倒す最小実験は Fish 呼び出し回数を1に固定し、fixture の `turn_id/sequence/first_sample/byte_count/rolling_hash` を tee の両側で比較することだ。LITE branch は decode 後 PCM、meeting page branch は AudioWorklet ingest 前 PCM を比較する。Fish call が2回、source sample が欠落/重複、hash lineage が不一致なら反証される。

これは end-to-end fidelity の実験ではない。Observer-side 録音は別途必要である。

## 5 avatar vendorがLLM/STT/turn-takingを握らずに済むか。

**Fact**

LiveAvatar LITE は external PCM protocol を持つ。Tavus Audio Echo は pre-generated audio を受け取り replica layer 以外を bypass すると説明する ([Tavus Echo](https://docs.tavus.io/sections/conversational-video-interface/echo-mode))。一方、LiveAvatar FULL、Tavus FULL CVI、current D-ID realtime agent の documented shape は vendor brain/turn stack を含む。

**Inference**

Vendor ではなく **vendor mode** ごとに判断すべきである。LITE/Echo は Meetmate が turn authority を保持できる候補だが、vendor の session state と media batching は残る。Media state を持つことと conversational turn authority を持つことは同じではない。

**Unknown**

Tavus Echo の exact PCM/cancel/returned-audio contract、各 vendor の hidden moderation/transformation、production account で brain features を完全に disable できるかは未確認部分がある。

**最小の反証実験**

「Meetmate だけが turn owner」という主張を倒す最小実験は、vendor に PCM、end、interrupt 以外を与えず、三つの scripted turn を実行することだ: normal end、mid-utterance cancel、cancel 後の新 turn。Vendor が自発的に speech を開始する、text/transcript を要求する、cancel 後に旧 turn を継続する、または vendor TTS audio が不可分なら不合格。Packet/event trace に ASR/LLM/text call が現れても反証となる。

## 6 static-image経路を本当に無変更にできるか。

**Fact**

Current static bot payload は `src/transport-meet/meet-routes.js:1206-1219`、image loading は `src/transport-meet/meet-routes.js:823-863` にある。Live path を bot creation 前に別 branch とすれば、static payload bytes を変えずに済む。

**Inference**

Source diff を小さくしても operationally unchanged とは限らない。Shared config validation、SDK initialization、health check、singleton queue、retry timer、cleanup hook、mandatory live env が static startup に入れば、payload が同じでも static は vendor failure に依存する。

**Unknown**

実装前なので、future config/bootstrap が本当に isolation を守るかは unknown。

**最小の反証実験**

Static unchanged 主張を倒す最小 regression は:

1. live keys/env を全て未設定;
2. avatar/renderer endpoints を DNS/connection failure にする;
3. static bot creation payload を baseline snapshot と byte comparison;
4. greeting、multiple turns、interrupt、long response、exit/leave を実行;
5. live SDK/module が load/connect されないことを trace で確認;

である。どれかが baseline と異なれば「static unchanged」は反証される。単なる payload unit snapshot だけでは不十分である。

## 7 vendor障害時に二重Botや二重音声を発生させず戻せるか。

**Fact**

Current Attendee primary WebSocket は replacement 時に single-owner (`src/transport-meet/meet-routes.js:1290-1300`) で、leave は stored bot ID 一つを対象にする (`src/transport-meet/meet-routes.js:1337-1354`)。しかし A live bot と static bot は別 construction である。Vendor failure 中に static bot を即作成すれば、古い participant の absence を確認できず二重 bot になり得る。

**Inference**

安全に保証できる「戻す」は二種類に分ける必要がある。

- **Control-plane rollback:** 新規 session は即座に unchanged static を選ぶ。Vendor 応答は不要。
- **Active-session containment:** 新 PCM を止め、generation を invalidate し、local queue を flush し、renderer delete を bounded retry し、元の live bot に leave を送り、absence を確認または incident として明示する。

現時点で安全な in-session automatic static fallback は合意すべきではない。Vendor failure から「同じ meeting で無停止復旧できる」は未証明であり、emerging consensus より厳しく退ける。

**Unknown**

Attendee page crash、vendor partition、lost delete response、leave timeout、stale page reconnect の組み合わせで participant/audio がいつ消えるかは unknown。

**最小の反証実験**

「duplicate なしに containment できる」を倒す最小実験は、bot が PCM 再生中に renderer connection を強制切断し、同時に stale page reconnect を発生させる fault injection である。Observer で participant count と waveform を記録し、generation mismatch の media が拒否され、音声 branch が一つだけ、new static bot が作られず、leave/delete が bounded terminal state に達することを確認する。二 participant、二 waveform、cancel 後の stale audio のどれかで反証される。

Static への in-session fallback を主張するなら、その後に初めて「旧 bot absence 確認 → static bot create」を加えた別実験が必要である。

## 8 最小モジュールはいくつ必要か。

**回答**

最初の A carrier falsification には **runtime 2 modules + test-only 1 harness** で十分である。

1. **Concrete Attendee live-session adapter (server-side)**
   Live bot creation、ephemeral page authorization、Fish PCM stamp/relay、generation、cancel、close、one-audio ownership を担当する。
2. **Concrete Attendee page (browser-side)**
   Actual AudioContext logging、bounded playout、test canvas flash または bounded local E、page audio/video capture を担当する。
3. **Test-only replay/observer harness**
   Frozen PCM、scripted end/cancel、meeting recording、source/observer metrics を担当する。Production runtime module には数えない。

A+LiveAvatar LITE 比較を行う時だけ **第3 runtime module: concrete LITE adapter** を追加する。`connected/start/speak/end/interrupt/delete` と LITE 固有 timing をここに閉じ込める。

**反対意見**

最初から独立 Media Tap、Media Shell、provider registry、generic lifecycle engine、renderer interface hierarchy、telemetry service に分けるのは最小ではない。逆に、bounded queue と generation/cancel を「test harnessだけ」に追い出すのも不十分である。これらは結果を解釈可能にする runtime correctness である。

**Unknown**

Existing route/WebSocket code に adapter の責任を安全に置けるか、page relay が独立 module を要するかは implementation inspection 前には unknown。したがって物理 file 数ではなく responsibility count として 2+1 を主張する。

**最小の反証実験**

2 runtime modules で足りるという主張を倒す最小実験は、A carrier probe を実装せず design trace で event ownership を割り当てることではなく、実際に connect → play → cancel → reconnect → close を通すことだ。Server adapter または page のどちらにも安全に置けない第三の独立 runtime state が一つでも現れたら、module count を増やす。Vendor 比較の将来可能性だけでは反証にならない。

## 9 その抽象化は今必要か、将来のためだけの過剰設計ではないか。

**回答**

今必要なのは **小さな media event envelope と concrete adapters** であり、provider-neutral Media Shell abstraction ではない。

最低限共有してよい形は:

```text
{ render_session_id, generation, turn_id, sequence,
  captured_at, sample_rate, pcm }
end(turn_id)
cancel(turn_id)
close(reason)
```

これは将来拡張のためではなく、同一 PCM lineage、stale generation rejection、cancel attribution を今の比較で証明するために必要である。

今は不要:

- dynamic provider registry / plugin discovery;
- generic renderer class hierarchy;
- common vendor config schema;
- provider-neutral ready/drain/retry state machine;
- automatic Attendee↔Recall failover;
- generic billing/telemetry platform;
- appearance/persona synchronization framework;
- Agent Core、memory、tools、profile への avatar abstraction。

**合意への反論**

Round 2 では “Media Shell” がほぼ共通語になったが、名前が共通でも remote semantics は共通ではない。Local E の queue depth は観測可能、LITE の remote accepted queue は unknown、Tavus の returned audio ownership は別問題、Recall/Attendee の page reconnect も異なる。未観測の共通 interface は unknown を同じ `health()` や `ready` に押し込み、偽の可搬性を作る。

Abstraction は少なくとも A+E と A+LITE の concrete adapter が動き、重複した code と同じ failure semantics が二回観測された後に extract すべきである。Rule of three を待つ必要まではないが、実装前の vendor-neutral design は早すぎる。

**Inference**

小さな envelope は比較可能性を高め、generic abstraction の延期は diff と Agent Core leakage を減らす。これは現時点の最小かつ可逆な設計である。

**Unknown**

二つの adapter が実際にどこまで同じ lifecycle を共有するかは unknown。Docs の似た名前だけでは共通性の証拠にならない。

**最小の反証実験**

「generic abstraction は不要」を倒す最小実験は A+E と A+LITE の二つの concrete spike を並べ、同じ state transition、retry、queue、cancel、close code が有意に重複し、adapter 固有条件なしに同じ contract test を通ることを示すことだ。その証拠が出た時点で共通部分だけを抽出する。それ以前の abstraction は将来予測である。

## 最終 adversarial vote

実験順序を次に修正する。

1. Current static baseline を記録する。
2. Avatar なしの最小 **A carrier probe** を実行する。
3. A が通った場合だけ、同じ page に bounded E を載せて **A+E** control を作る。
4. 同じ fixture で **A+LiveAvatar LITE** を比較する。
5. C は明示的 discriminator がある場合だけ fresh harness で実行する。
6. B と FULL modes は実験しない。

この順序は A+E consensus を否定するものではない。A を先に単独で倒せるようにし、renderer 実装を carrier failure の前に作らないための分解である。最初の決定は vendor 選定ではなく、Attendee webpage が current static audio baseline に対して測定可能な carrier になれるかである。
