# AI Meet Participant

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | **ไทย**

> เอกสารนี้เป็นคำแปลของ [README.md](README.md) (ภาษาอังกฤษ ฉบับหลัก) หากเนื้อหาไม่ตรงกัน ให้ยึดฉบับภาษาอังกฤษเป็นหลัก

[![Version](https://img.shields.io/badge/version-v7.9.0--rc.1-blue)](https://github.com/caty-ai/meetmate/releases)
[![Stable](https://img.shields.io/badge/stable-v7.8.0-brightgreen)](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
[![License: Apache--2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Google%20Meet%20%7C%20Zoom-4285F4)](#คุณสมบัติ)

เซิร์ฟเวอร์บริดจ์ที่ทำให้ AI agent เข้าร่วม Google Meet / Zoom เป็นผู้เข้าประชุมแบบเรียลไทม์และโต้ตอบด้วยเสียง ด้วยการเชื่อมต่อ OpenClaw Gateway จะสามารถนำ agent ใด ๆ เข้าสู่การประชุมด้วยเสียงได้

```
STT (Soniox) → ตรวจจับ wake word → LLM (ค่าเริ่มต้น OpenClaw Gateway) → TTS (Fish Audio S2-Pro) → Meet / Zoom
```

## สารบัญ

- [คุณสมบัติ](#คุณสมบัติ)
- [ภาพหน้าจอ](#ภาพหน้าจอ)
- [สถาปัตยกรรม](#สถาปัตยกรรม)
- [เริ่มต้นอย่างรวดเร็ว](#เริ่มต้นอย่างรวดเร็ว)
- [การตั้งค่า](#การตั้งค่า)
- [การแก้ไขปัญหา](#การแก้ไขปัญหา)
- [เอกสาร](#เอกสาร)
- [การพัฒนา](#การพัฒนา)
- [สถานะโครงการ](#สถานะโครงการ)
- [การมีส่วนร่วม](#การมีส่วนร่วม)
- [กิตติกรรมประกาศ](#กิตติกรรมประกาศ)
- [สัญญาอนุญาต](#สัญญาอนุญาต)

## คุณสมบัติ

- **รองรับ Google Meet / Zoom** — เข้าร่วมประชุมผ่าน Attendee bot API
- **เชื่อมต่อ OpenClaw Gateway** — รองรับ SOUL / memory / skills / tools อย่างเต็มรูปแบบ
- **ตรวจจับ wake word + barge-in** (พูดแทรกระหว่างที่ agent กำลังพูด)
- **STT ความหน่วงต่ำ** — ค่าเริ่มต้น Soniox `stt-rt-v5`; สลับเป็น Deepgram ได้ด้วย `STT_PROVIDER=deepgram`
- **TTS ที่สื่ออารมณ์** — Fish Audio S2-Pro (รูปแบบ emotion-tag anchor ช่วยให้เสียงเสถียร)
- **แคช TTS สำหรับประโยคคงที่** — เสียงตอบรับ / ping / ทักทาย / อำลา เล่นทันทีจากแคช PCM บนดิสก์; รองรับการป้อนเสียงบันทึกจริงล่วงหน้า
- **กรอบบังคับมอบหมายงาน (delegation harness)** — งานหนักถูกบังคับมอบหมายไปยังเซสชันเบื้องหลัง ให้ agent หน้าบ้านมีสมาธิกับบทสนทนา ([#79](https://github.com/caty-ai/meetmate/issues/79))
- **โพสต์แชทในที่ประชุม** — แท็ก `[[[chat: ...]]]` ในคำตอบของ LLM จะถูกโพสต์ลงแชทแทนการอ่านออกเสียง
- **ตัวกันอิโมจิ** — สองชั้น: ห้ามใน LLM prompt + ลบเชิงกลก่อนเข้า TTS
- **บันทึกอัตโนมัติ LCM (Lossless Context Management)** / **เชื่อมต่อ Slack** (แจ้งสถานะ สรุป และบันทึกฉบับเต็ม)

## ภาพหน้าจอ

<!-- TODO: เอาคอมเมนต์ออกเมื่อวางรูปใน docs/images/ แล้ว
![หน้าควบคุม](docs/images/ui-join.png)
![ระหว่างประชุม](docs/images/in-meeting.png)
-->

เปิด http://localhost:5005 ในเบราว์เซอร์ วาง URL ของ Meet / Zoom แล้ว agent จะเข้าร่วมประชุม ระหว่างประชุม อวตาร (`assets/avatar.png`) จะแสดงเป็นไทล์ผู้เข้าร่วม และเมื่อเรียกด้วย wake word agent จะตอบกลับด้วยเสียง

> 📸 ภาพหน้าจอและ GIF สาธิตกำลังอยู่ระหว่างจัดเตรียม

## สถาปัตยกรรม

**หนึ่ง agent = หนึ่งอินสแตนซ์เซิร์ฟเวอร์** agent ใด ๆ ทำงานได้ด้วยเพียง `config.json` + `.env` + รูปอวตาร

STT ฝั่งขาเข้าทำงานที่ 16 kHz; TTS / `bot_output` ฝั่งขาออกทำงานที่ 24 kHz ขาเข้าและขาออกของ Attendee เป็นอิสระต่อกัน

### โมดูลหลัก

| โมดูล | หน้าที่ |
|---|---|
| [`src/pipeline.js`](src/pipeline.js) | ควบคุมไปป์ไลน์เสียง |
| [`src/agent-profile.js`](src/agent-profile.js) | การแปลงโปรไฟล์ agent |
| [`src/paths.js`](src/paths.js) | สัญญาไดเรกทอรีหลัก (`AI_MEET_HOME`) — ดู[ไดเรกทอรีข้อมูล](#ไดเรกทอรีข้อมูล-ai_meet_home) |
| [`src/llm-provider.js`](src/llm-provider.js) | สลับผู้ให้บริการ LLM (ค่าเริ่มต้น OpenClaw / OpenAI-compatible) |
| [`src/stt-provider.js`](src/stt-provider.js) | สลับผู้ให้บริการ STT (ค่าเริ่มต้น soniox / deepgram) |
| [`src/stt-soniox.js`](src/stt-soniox.js) | Soniox STT (stt-rt-v5, WebSocket) |
| [`src/stt.js`](src/stt.js) | Deepgram STT (ตัวสำรอง) |
| [`src/tts-fish.js`](src/tts-fish.js) | Fish Audio TTS |
| [`src/speech-policy.js`](src/speech-policy.js) | การระงับ NO_REPLY และการทำความสะอาดข้อความ |
| [`src/exit-handler.js`](src/exit-handler.js) | ตรวจจับการออกจากประชุมและเก็บกวาด |

รายละเอียดดูที่ [docs/architecture.md](docs/architecture.md)

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนดเบื้องต้น

- Node.js 22 ขึ้นไป (ตาม `engines` ใน `package.json`)
- ผู้ให้บริการ LLM: `openclaw` (ค่าเริ่มต้น) หรือ `openai-compatible`
  - `openclaw` ต้องมี OpenClaw Gateway และให้ประสบการณ์ agent เต็มรูปแบบรวมถึง SOUL / memory / skills / tools
  - `openai-compatible` เชื่อมต่อกับ API ใด ๆ ที่เข้ากันได้กับ OpenAI โดยไม่ต้องมี OpenClaw Gateway
- คีย์ API ของแต่ละบริการ (Soniox / Fish Audio / Attendee)
  - [Attendee](https://attendee.dev/) คือ SaaS (มีรุ่น self-host ด้วย) ที่นำ bot เข้าสู่ Google Meet / Zoom การเข้า-ออกและเสียงเข้า-ออกของ bot ทั้งหมดผ่าน Attendee API
  - Voice ID ของ Fish Audio: เปิดหน้าเสียงที่ต้องการ (ของตัวเองหรือเสียงสาธารณะ) บน [fish.audio](https://fish.audio/) แล้วคัดลอก ID ท้าย URL

### วิธี A: แพ็กเกจ npm (แนะนำ)

> ℹ️ จนกว่าจะเผยแพร่รุ่น npm แรก โปรดใช้[วิธี B](#วิธี-b-จากซอร์สโค้ด)ด้านล่าง

```bash
mkdir my-agent && cd my-agent
npm install ai-meet-participant
npx ai-meet init    # ถามคีย์ API 3 ตัวแบบโต้ตอบ แล้วสร้าง config.json + .env
npx ai-meet start   # เริ่มเซิร์ฟเวอร์และแสดง URL ของหน้าตั้งค่า
```

`init` จะคัดลอก `config.json.example` / `.env.example` ที่มากับแพ็กเกจไปยัง**ไดเรกทอรีปัจจุบัน** และกรอกข้อมูลรับรองที่คุณป้อน (`SONIOX_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`) หากมีไฟล์อยู่แล้วจะปฏิเสธการเขียนทับ เว้นแต่ใส่ `--force` จากนั้นแก้ไข `config.json` เพื่อตั้งชื่อ agent, wake word และประโยคคงที่

### วิธี B: จากซอร์สโค้ด

```bash
git clone git@github.com:caty-ai/meetmate.git
cd meetmate
npm install
cp .env.example .env        # กรอกคีย์
cp config.json.example config.json
npm start
```

เปิด http://localhost:5005 วาง URL ของ Meet / Zoom แล้วคลิกเข้าร่วม

> 💡 หากการจดจำ wake word ไม่เสถียร มีฟีเจอร์ **wake-calibrate** (`/calibrate`) ที่เก็บรูปแบบการจดจำผิดจากการพูดจริงผ่านเบราว์เซอร์ ดู [docs/setup-guide.md](docs/setup-guide.md)

### ไดเรกทอรีข้อมูล (`AI_MEET_HOME`)

ทุกอย่างที่เซิร์ฟเวอร์**เขียน** รวมถึงการตั้งค่าของผู้ใช้ อยู่ในไดเรกทอรี *home* เดียว — ค่าเริ่มต้นคือ**ไดเรกทอรีทำงานปัจจุบัน** หรือกำหนดผ่านตัวแปรสภาพแวดล้อม `AI_MEET_HOME`:

| พาธ (ภายใต้ home) | เนื้อหา |
|---|---|
| `config.json` / `.env` | การตั้งค่า agent และข้อมูลรับรอง |
| `logs/` | บันทึกการทำงานและตัวชี้วัดการมอบหมายงาน (`metrics.jsonl`) |
| `assets/avatar.png` | อวตารกำหนดเอง (ถ้าไม่มี จะใช้รูปเริ่มต้นที่มากับแพ็กเกจ) |
| `assets/tts-cache/` | แคช TTS สำหรับประโยคคงที่ |

ทรัพยากรแบบอ่านอย่างเดียวที่มากับแพ็กเกจ (Web UI, อวตารเริ่มต้น, เสียง filler) จะถูกอ่านจากตัวแพ็กเกจที่ติดตั้งเสมอ `TTS_CACHE_DIR` และ `METRICS_LOG_DIR` ยังใช้เป็นการกำหนดทับแบบชัดแจ้งได้ การรัน `npm start` จากซอร์ส checkout จะใช้รากของรีโพเป็น home ดังนั้นพฤติกรรมแบบรันจากซอร์สจึงไม่เปลี่ยนแปลง

### ตัวแปรสภาพแวดล้อม (`.env`)

| ตัวแปร | วัตถุประสงค์ |
|---|---|
| `LLM_PROVIDER` | ผู้ให้บริการ LLM (`openclaw` (ค่าเริ่มต้น) / `openai-compatible`) |
| `OPENCLAW_GATEWAY_URL` | URL ของ OpenClaw Gateway (จำเป็นสำหรับ `openclaw` เช่น `http://localhost:18789`) |
| `OPENCLAW_GATEWAY_TOKEN` | โทเคนยืนยันตัวตนของ Gateway (จำเป็นสำหรับ `openclaw`) |
| `OPENAI_COMPATIBLE_BASE_URL` | URL ฐานของ API ที่เข้ากันได้กับ OpenAI (จำเป็นสำหรับ `openai-compatible`) |
| `OPENAI_COMPATIBLE_API_KEY` | คีย์ API ของ API ที่เข้ากันได้กับ OpenAI (จำเป็นสำหรับ `openai-compatible`) |
| `SONIOX_API_KEY` | STT (ผู้ให้บริการเริ่มต้น Soniox) |
| `FISH_AUDIO_API_KEY` | TTS |
| `FISH_AUDIO_VOICE_ID` | ID เสียง TTS (โคลนเสียง) |
| `ATTENDEE_API_KEY` | Meet / Zoom bot API |

ตัวแปรเสริม (`PORT`, `AGENT_LANG`, การเชื่อมต่อ Slack ฯลฯ) และเอกสารอ้างอิงการจูนทั้งหมดอยู่ที่ [docs/operations.md](docs/operations.md)

### การตั้งค่า agent (`config.json`)

ID / ชื่อที่แสดง / wake word / ประโยคคงที่ (greeting, ackVariants, progressPings ฯลฯ) และการตั้งค่า TTS / STT / Slack / Attendee รวมอยู่ที่นี่ทั้งหมด `config.json.example` จัดตามรูปแบบ emotion-tag anchor (สำหรับ S2-Pro) แล้ว คัดลอกและกรอกตัวแปรก็ใช้งานได้

### ผู้ให้บริการ LLM

| `llm.provider` / `LLM_PROVIDER` | พฤติกรรม |
|---|---|
| `openclaw` | ค่าเริ่มต้น ใช้ SOUL / memory / skills / tools ผ่าน OpenClaw Gateway |
| `openai-compatible` | เรียก API ที่เข้ากันได้กับ OpenAI โดยตรง ไม่ต้องมี OpenClaw Gateway |

`openai-compatible` เป็นโหมดลดรูปที่ตอบด้วยเสียงโดยใช้ LLM ธรรมดากับเทมเพลตบุคลิกภาพในตัว เป็นการรับประกันขั้นต่ำแบบ OSS เมื่อไม่ได้ตั้งค่า Gateway; ใช้ memory / skills / tools เฉพาะของ OpenClaw ไม่ได้ โมเดล Claude ใช้ผ่านพร็อกซีที่เข้ากันได้กับ OpenAI (เช่น LiteLLM); ไม่มีอะแดปเตอร์ Anthropic แบบเนทีฟ ([#114](https://github.com/caty-ai/meetmate/issues/114))

หากเลือก `openai-compatible` ใน `config.json` ให้ตั้ง `LLM_PROVIDER` ใน `.env` ให้ตรงกันด้วย (ตัวแปรสภาพแวดล้อมมีลำดับความสำคัญเหนือ `config.json`) placeholder `${...}` ใน `config.json` ที่ยังไม่ถูกแทนค่า (ไม่ได้ตั้งหรือเว้นว่าง) **จะทำให้เซิร์ฟเวอร์จบการทำงานด้วยข้อผิดพลาดตอนเริ่มต้น** ดังนั้น env ของฟีเจอร์ที่ไม่ใช้ (`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` / `SLACK_BOT_TOKEN` ฯลฯ) ให้คงค่า dummy ไว้ อย่าลบหรือเว้นว่าง — หรือลบทั้งบล็อกออกจาก `config.json`

สคีมา `llm` ของ `config.json`:

```json
{
  "llm": {
    "provider": "openclaw",
    "model": "openclaw",
    "temperature": 0.5,
    "maxTokens": 300,
    "historyMaxTurns": 12,
    "systemPrompt": "",
    "openaiCompatible": {
      "baseUrl": "",
      "apiKey": ""
    }
  }
}
```

ลำดับการแปลงค่า `provider` / `temperature` / `maxTokens` / `openaiCompatible`: overrides ต่อเซสชัน → การตั้งค่า agent → ตัวแปรสภาพแวดล้อม → `configJson.llm` → ค่าเริ่มต้น ตัวแปรสภาพแวดล้อมที่เกี่ยวข้องคือ `LLM_PROVIDER`, `AGENT_TEMPERATURE`, `AGENT_MAX_TOKENS`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` ส่วน `model` และ `historyMaxTurns` ไม่อ่านตัวแปรสภาพแวดล้อม โดยแปลงตามลำดับ overrides → การตั้งค่า agent → `configJson.llm` → ค่าเริ่มต้น สำหรับ `openai-compatible` ค่า `systemPrompt` แปลงตามลำดับ `overrides.prompt` → `configJson.llm.systemPrompt` → บุคลิกภาพในตัว แล้วผนวกกฎเฉพาะสำหรับเสียง

คำขอถูกส่งไปยัง `{baseUrl}/v1/chat/completions`; หาก `baseUrl` ลงท้ายด้วย `/v1` อยู่แล้วจะไม่ซ้ำ `/v1` ชื่อผู้ให้บริการที่ไม่รู้จักจะเตือนแล้วถอยกลับไปใช้ `openclaw`

## การตั้งค่า

รวมเฉพาะจุดเข้าของการปรับแต่งที่ใช้บ่อย เอกสารอ้างอิงฉบับเต็มคือ [docs/operations.md](docs/operations.md)

| ต้องการ… | ดูที่ |
|---|---|
| ให้ตอบกลับเร็วขึ้น | [การจูน Soniox](docs/operations.md#stt-プロバイダ切替soniox-チューニング) |
| เปลี่ยนเสียง ความเร็วพูด หรือพฤติกรรม TTS | [โปรไฟล์เสียง](docs/operations.md#音声プロファイルtts) |
| ย้อนกลับการตั้งค่าเมื่อมีปัญหา | [env สำหรับ rollback ฉุกเฉิน](docs/operations.md#緊急-rollback-用-env) |
| ใช้การมอบหมายงานเบื้องหลังสำหรับงานหนัก | [กรอบมอบหมายงาน](docs/operations.md#委譲強制ハーネス79) |
| ป้อนเสียงบันทึกจริงเข้าแคช TTS | [การป้อนเสียงบันทึก](docs/operations.md#実収録テイクのシード72--75) |

## การแก้ไขปัญหา

**Q. หลังพูดจบ คำตอบกลับมาช้า**
ลด `SONIOX_MAX_ENDPOINT_DELAY_MS` จาก `1500` เป็น `1000` (หรือ `800` หากจำเป็น) แล้วรีสตาร์ทเซิร์ฟเวอร์ หากคำพูดเริ่มถูกตัดกลางประโยค ให้ลด `SONIOX_ENDPOINT_SENSITIVITY` ไปทาง `0.0〜-0.2` รายละเอียด: [การจูน Soniox](docs/operations.md#stt-プロバイダ切替soniox-チューニング)

**Q. โพสต์ลงแชทของที่ประชุมไม่สำเร็จ**
ข้อความที่มีอิโมจิหรืออักขระหายากจะถูกเซิร์ฟเวอร์ Attendee ปฏิเสธด้วย 400 ("Message cannot contain emojis or rare script characters.") คำเตือนการส่งล้มเหลวออกที่ `logs/meet-server.stderr.log` ให้ตรวจสอบที่นั่นก่อน

**Q. เสียง TTS ไม่เสถียรหรือเพี้ยน**
S2-Pro มักเสียงเพี้ยนเมื่อพูดโดยไม่มีแท็ก การออกแบบจึงถือ "รูปแบบ anchor": ใส่แท็กอารมณ์หนึ่งตัวในทุกการพูด ([โปรไฟล์เสียง](docs/operations.md#音声プロファイルtts)) หากยังไม่เสถียร `FISH_AUDIO_MODEL=s1` จะย้อนกลับไปโมเดลเก่าได้ทันที

**Q. ความแม่นยำ STT แย่ลงกะทันหัน**
ตั้ง `STT_PROVIDER=deepgram` ใน `.env` แล้วรีสตาร์ทเพื่อสลับไป Deepgram ทันที การจดจำชื่อคนและศัพท์เฉพาะผิดจะดีขึ้นเมื่อเพิ่มรายการคั่นด้วยจุลภาคใน `SONIOX_CONTEXT_TERMS`

**Q. เสียงประโยคคงที่ (เสียงตอบรับ ฯลฯ) ต่างจากปกติ**
แคช TTS ไม่ hit จึงถอยกลับไปสังเคราะห์สด คีย์แคชขึ้นกับ `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE` เมื่อเปลี่ยนค่าเหล่านี้ให้รัน `node scripts/seed-tts-cache-from-fillers.js` ใหม่ ([ขั้นตอนการป้อน](docs/operations.md#実収録テイクのシード72--75))

**Q. จะตรวจสอบว่ากรอบมอบหมายงานทำงานอยู่ได้อย่างไร**
บันทึกเป็น JSONL ที่ `logs/metrics.jsonl` สรุปได้ด้วย `node scripts/aggregate-metrics.js logs/metrics.jsonl`

หากยังแก้ไม่ได้ โปรดรายงานที่ [Issues](https://github.com/caty-ai/meetmate/issues) พร้อมบันทึก (ภายใต้ `logs/`) และขั้นตอนการทำซ้ำ

## เอกสาร

| เอกสาร | เนื้อหา |
|---|---|
| [docs/setup-guide.md](docs/setup-guide.md) | คู่มือติดตั้งโดยละเอียด |
| [docs/architecture.md](docs/architecture.md) | คำอธิบายสถาปัตยกรรม |
| [docs/operations.md](docs/operations.md) | เอกสารอ้างอิงการปฏิบัติงานและการจูนฉบับเต็ม |
| [docs/deploy-checklist.md](docs/deploy-checklist.md) | เช็กลิสต์การ deploy |
| [docs/deep-interview-79-delegation-harness.md](docs/deep-interview-79-delegation-harness.md) | สเปกการออกแบบกรอบมอบหมายงาน |

> ℹ️ เอกสารบางส่วนใน `docs/` ยังเป็นภาษาญี่ปุ่น ตารางอ้างอิงและตัวอย่างคำสั่งไม่ขึ้นกับภาษา

## การพัฒนา

### เซิร์ฟเวอร์สำหรับพัฒนา

```bash
npm run dev   # เริ่มแบบรีโหลดอัตโนมัติผ่าน node --watch
```

### การทดสอบ

ใช้ test runner ในตัวของ Node.js (`node:test`) ไม่ต้องพึ่งบริการภายนอก ชุดทดสอบทั้งหมดเสร็จในไม่กี่วินาที

```bash
node --test                       # ทดสอบทั้งหมด (35 ไฟล์ / 245 การทดสอบ)
npm run test:meet:repro           # เฉพาะการทดสอบจำลองผู้เข้าร่วมหลายคนของ Meet
```

### สคริปต์ smoke และปฏิบัติการ

| สคริปต์ | วัตถุประสงค์ |
|---|---|
| [`scripts/soniox-smoke.js`](scripts/soniox-smoke.js) | ตรวจการเชื่อมต่อ Soniox STT |
| [`scripts/seed-tts-cache-from-fillers.js`](scripts/seed-tts-cache-from-fillers.js) | สร้างแคช TTS ล่วงหน้าจากเสียงบันทึกจริง |
| [`scripts/aggregate-metrics.js`](scripts/aggregate-metrics.js) | สรุปตัวชี้วัดของกรอบมอบหมายงาน |
| [`scripts/install-launchagent.sh`](scripts/install-launchagent.sh) | ตั้งเป็น daemon ผ่าน macOS launchd (พร้อม watchdog) |

### บันทึก

บันทึกการทำงานอยู่ภายใต้ `logs/` คำเตือน/ข้อผิดพลาดฝั่งแอป: `logs/meet-server.stderr.log` ตัวชี้วัดการมอบหมายงาน: `logs/metrics.jsonl`

## สถานะโครงการ

- **ล่าสุด**: `v7.9.0-rc.1` (2026-07-07 ใช้งานจริงด้วย `GATEWAY_EVENTS_ENABLED=true`)
- **เสถียร**: [`v7.8.0-stable`](https://github.com/caty-ai/meetmate/releases/tag/v7.8.0-stable)
- **กำลังดำเนินการ**: การเผยแพร่ npm และการเปิดสาธารณะ ([#136](https://github.com/caty-ai/meetmate/issues/136) / [#107](https://github.com/caty-ai/meetmate/issues/107))

## การมีส่วนร่วม

ยินดีรับการมีส่วนร่วม ดูขั้นตอนการพัฒนาแบบ issue-first ระเบียบ branch และแนวทางเขียน PR ที่ [CONTRIBUTING.md](CONTRIBUTING.md)

## กิตติกรรมประกาศ

โครงการนี้ตั้งอยู่บนบริการและโครงการต่อไปนี้:

- [Attendee](https://attendee.dev/) — API นำ bot เข้าร่วม Google Meet / Zoom
- [Soniox](https://soniox.com/) — การรู้จำเสียงแบบเรียลไทม์ (`stt-rt-v5`)
- [Fish Audio](https://fish.audio/) — การสังเคราะห์เสียงที่สื่ออารมณ์ (S2-Pro)
- OpenClaw Gateway — โครงสร้างพื้นฐาน agent (SOUL / memory / skills / tools)

## สัญญาอนุญาต

[Apache License 2.0](LICENSE) — ดูเพิ่มเติมที่ [NOTICE](NOTICE)
