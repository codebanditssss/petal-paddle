// Self-Supplying Agent pipeline: an LLM on GMI designs the game, then GMI media
// models generate every asset. Zero hand-made files.
// Usage: GMI_API_KEY=... node pipeline/supply.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const KEY = process.env.GMI_API_KEY;
if (!KEY) { console.error('Set GMI_API_KEY'); process.exit(1); }
const LLM_BASE = 'https://api.gmi-serving.com/v1';
const RQ_BASE = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey';
const RQ_MODELS = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/models';
const LLM_MODEL = process.env.LLM_MODEL || 'google/gemini-4-carbon';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASSETS = path.join(ROOT, 'assets');
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

const MODELS = {
  mesh: process.env.MESH_MODEL || 'hunyuan-3d-pro',
  texture: process.env.TEXTURE_MODEL || 'seedream-5.0-lite',
  music: process.env.MUSIC_MODEL || 'minimax-music-3.0',
  voice: process.env.VOICE_MODEL || 'minimax-tts-speech-2.8-turbo',
  sprite: process.env.SPRITE_MODEL || 'gpt-image-2.5-flare-generate',
};

// ---------- 1. design the game with an LLM ----------
const DESIGN_PROMPT = `You are the lead designer of a tiny cozy browser game built in three.js.
Vibe: "Pocket Pond" — a calm low-poly pond at golden hour, soft pastel colors, charming and gentle.
Gameplay must be: the player steers a small character around a round pond (top-down-ish camera),
collects floating collectibles for points, and avoids a drifting obstacle (touching it costs a life, 3 lives).
Every asset will be AI-generated, so write production-ready generation prompts.
Return ONLY a JSON object with this exact shape:
{
 "title": "short catchy game title (2-3 words)",
 "tagline": "one short line",
 "how_to_play": "one sentence",
 "palette": {"water":"#hex","fog":"#hex","accent":"#hex"},
 "meshes": [
   {"id":"player","name":"...","prompt":"single cute low-poly 3D character description, one object, no base, no ground"},
   {"id":"collectible","name":"...","prompt":"single small collectible object"},
   {"id":"obstacle","name":"...","prompt":"single obstacle object that drifts on water"}
 ],
 "textures": [
   {"id":"ground","prompt":"seamless tileable top-down texture for the pond water surface, stylized, no objects, no text"},
   {"id":"sky","prompt":"wide panoramic painted sky backdrop at golden hour with soft clouds and distant low-poly hills, no text"}
 ],
 "music": {"style":"genre, mood, instruments, tempo (under 300 chars)","lyrics":"short gentle song with [Intro] [Verse] [Chorus] [Outro] tags, under 600 chars"},
 "voice_line": "one short warm welcome line spoken when the game starts, under 120 chars"
}`;

async function design() {
  const t0 = Date.now();
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      model: LLM_MODEL, max_tokens: 6000, temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: DESIGN_PROMPT }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
  let txt = j.choices?.[0]?.message?.content || '';
  txt = txt.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
  const spec = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return { spec, entry: { kind: 'design', model: LLM_MODEL, endpoint: 'chat/completions',
    started_at: new Date(t0).toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1),
    usage: j.usage || null } };
}

async function llmCost(model, usage) {
  try {
    const j = await (await fetch(`${LLM_BASE}/models`, { headers: auth })).json();
    const m = j.data.find((x) => x.id === model);
    if (!m?.pricing || !usage) return null;
    const list = usage.prompt_tokens * +m.pricing.prompt + usage.completion_tokens * +m.pricing.completion;
    const disc = m.discount_to_user ?? 0;
    return { list_usd: +list.toFixed(5), discount: disc, cost_usd: +(list * (1 - disc)).toFixed(5) };
  } catch { return null; }
}

// ---------- 2. request queue helpers ----------
let priceTable = {};
async function loadPrices() {
  try {
    const r = await fetch(RQ_MODELS, { headers: auth });
    const j = await r.json();
    for (const m of j.models || []) priceTable[m.model] = { price_info: m.price_info, pricing_details: m.pricing_details };
  } catch (e) { log('price table unavailable', e.message); }
}
function costFor(model, units = 1) {
  const p = priceTable[model]?.price_info;
  if (!p?.price) return null;
  return +(p.price / 1e6 * units).toFixed(4); // price is in micro-dollars
}

const RETRY_MIN = +(process.env.RETRY_MIN || 12); // keep retrying busy upstreams this long
async function submit(model, payload, attempts) {
  const t0 = Date.now();
  for (;;) {
    attempts.n++;
    const r = await fetch(`${RQ_BASE}/requests`, { method: 'POST', headers: auth, body: JSON.stringify({ model, payload }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const msg = `submit ${model} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
    attempts.errors.push(msg);
    const transient = r.status >= 500 || /ResourceInsufficient|retry|unavailable/i.test(msg);
    if (!transient || Date.now() - t0 > RETRY_MIN * 60000) throw new Error(msg);
    log(`  ${model} busy (${j.error || r.status}), retrying in 45s…`);
    await sleep(45000);
  }
}
async function poll(id, timeoutMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${RQ_BASE}/requests/${id}`, { headers: auth });
    const j = await r.json().catch(() => ({}));
    if (j.status === 'success') return j;
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(`request ${id} ${j.status}: ${JSON.stringify(j.outcome).slice(0, 400)}`);
    await sleep(5000);
  }
  throw new Error(`request ${id} timed out`);
}
function mediaUrls(outcome) {
  const urls = new Set();
  const walk = (o) => {
    if (!o) return;
    if (typeof o === 'string') { if (/^https?:\/\//.test(o)) urls.add(o); return; }
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === 'object') for (const v of Object.values(o)) walk(v);
  };
  walk(outcome?.media_urls); if (!urls.size) walk(outcome);
  return [...urls];
}
async function download(url, base) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let ext = path.extname(new URL(url).pathname).toLowerCase() || '';
  const ct = r.headers.get('content-type') || '';
  if (!ext) ext = ct.includes('png') ? '.png' : ct.includes('jpeg') ? '.jpg' : ct.includes('mpeg') ? '.mp3' : ct.includes('zip') ? '.zip' : '.bin';
  const file = path.join(ASSETS, base + ext);
  await fs.writeFile(file, buf);
  return { file, bytes: buf.length, ext };
}

async function runJob(job) {
  const entry = { kind: job.kind, id: job.id, model: job.model, payload: job.payload, submitted_at: now() };
  const t0 = Date.now();
  try {
    log(`→ ${job.model} (${job.id})`);
    entry.attempts = { n: 0, errors: [] };
    let done;
    for (let run = 1; ; run++) {           // generation-level retry for "please retry" failures
      const sub = await submit(job.model, job.payload, entry.attempts);
      entry.request_id = sub.request_id;
      try { done = sub.status === 'success' ? sub : await poll(sub.request_id); break; }
      catch (e) { entry.attempts.errors.push(e.message); if (run >= 3 || !/retry|INTERNAL|UPSTREAM|ResourceInsufficient/i.test(e.message)) throw e; log(`  ${job.id} failed (${run}), resubmitting…`); job.payload = { ...job.payload, idempotency_nonce: String(Date.now()) }; }
    }
    entry.completed_at = now();
    entry.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    entry.server_seconds = done.updated_at && done.created_at ? done.updated_at - done.created_at : null;
    const urls = mediaUrls(done.outcome);
    entry.files = [];
    for (const [i, u] of urls.entries()) {
      const d = await download(u, urls.length > 1 ? `${job.id}_${i}` : job.id);
      if (d.ext === '.zip') {
        const dir = path.join(ASSETS, job.id);
        await fs.mkdir(dir, { recursive: true });
        execFileSync('unzip', ['-o', '-q', d.file, '-d', dir]);
        entry.files.push({ file: path.relative(ROOT, d.file), bytes: d.bytes, extracted_to: path.relative(ROOT, dir) });
        const walk = async (dd) => (await Promise.all((await fs.readdir(dd, { withFileTypes: true })).map((x) => x.isDirectory() ? walk(path.join(dd, x.name)) : [path.join(dd, x.name)]))).flat();
        entry.mesh_files = (await walk(dir)).map((f) => path.relative(ROOT, f));
      } else entry.files.push({ file: path.relative(ROOT, d.file), bytes: d.bytes });
    }
    entry.cost_usd = costFor(job.model, job.units || 1);
    entry.cost_source = 'GMI request-queue price list (price_info)';
    entry.status = 'success';
    log(`✓ ${job.id} in ${entry.seconds}s → ${entry.files.map((f) => f.file).join(', ')}`);
  } catch (e) {
    entry.status = 'failed'; entry.error = e.message; entry.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    log(`✗ ${job.id}: ${e.message}`);
  }
  return entry;
}

// ---------- 3. main ----------
const tStart = Date.now();
await fs.mkdir(ASSETS, { recursive: true });
await loadPrices();
const FORCE = process.argv.includes('--fresh');
let prev = null;
try { prev = JSON.parse(await fs.readFile(path.join(ASSETS, 'manifest.json'), 'utf8')); } catch {}
let spec, designEntry;
if (!FORCE && prev) {
  spec = JSON.parse(await fs.readFile(path.join(ASSETS, 'game_spec.json'), 'utf8'));
  designEntry = prev.steps.find((s) => s.kind === 'design');
  log(`resuming: reusing design "${spec.title}" and ${prev.steps.filter((s) => s.status === 'success').length} finished assets`);
} else {
  log(`designing game with ${LLM_MODEL}...`);
  ({ spec, entry: designEntry } = await design());
}
log(`concept: ${spec.title} — ${spec.tagline}`);
await fs.writeFile(path.join(ASSETS, 'game_spec.json'), JSON.stringify(spec, null, 2));
if (designEntry.cost_usd == null) {
  const c = await llmCost(designEntry.model, designEntry.usage);
  if (c) Object.assign(designEntry, c, { cost_source: 'GMI /v1/models pricing x token usage' });
}

const jobs = [
  ...spec.meshes.map((m) => ({ kind: 'mesh', id: m.id, model: MODELS.mesh,
    payload: { prompt: `${m.prompt}. Cute stylized low-poly game asset, soft pastel colors, single object, centered.`, generate_type: 'Normal', face_count: 40000 } })),
  ...spec.textures.map((t) => ({ kind: 'texture', id: t.id, model: MODELS.texture,
    payload: { prompt: t.prompt, size: t.id === 'sky' ? '3072x1536' : '2048x2048', output_format: 'png', watermark: false } })),
  { kind: 'music', id: 'music', model: MODELS.music,
    payload: { lyrics: spec.music.lyrics, prompt: spec.music.style, format: 'mp3' } },
  { kind: 'voice', id: 'voice', model: MODELS.voice, units: (spec.voice_line.length / 1000),
    payload: { text: spec.voice_line, voice_id: 'English_radiant_girl', format: 'mp3' } },
];
// Sprites: transparent PNG cut-outs of each character. Used as image-to-3D input
// for Hunyuan and as a 2.5D fallback if the 3D upstream is down.
jobs.push(...spec.meshes.map((m) => ({ kind: 'sprite', id: `${m.id}_sprite`, model: MODELS.sprite,
  payload: { prompt: `${m.prompt}. Cute storybook game sprite, three-quarter view, soft pastel cel shading, full object visible, transparent background.`, size: '1024x1024', quality: 'medium', background: 'transparent', output_format: 'png', moderation: 'low' } })));
const reuse = (job) => (!FORCE && prev?.steps.find((s) => s.id === job.id && s.status === 'success')) || null;
const results = await Promise.all(jobs.map((j) => { const r = reuse(j); if (r) { log(`= ${j.id} (cached)`); return r; } return runJob(j); }));

const manifest = {
  project: 'self-supplying-agent', generated_at: now(),
  total_wall_seconds: +((Date.now() - tStart) / 1000).toFixed(1),
  game: { title: spec.title, tagline: spec.tagline, how_to_play: spec.how_to_play, palette: spec.palette },
  steps: [designEntry, ...results],
  ...(prev?.music_variants ? { music_variants: prev.music_variants } : {}),
  totals: {
    media_cost_usd: +results.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(4),
    llm_cost_usd: designEntry.cost_usd ?? null,
    total_cost_usd: +(results.reduce((s, r) => s + (r.cost_usd || 0), 0) + (designEntry.cost_usd || 0)).toFixed(4),
    generation_seconds_sum: +results.filter((r) => r.status === 'success').reduce((s, r) => s + (r.server_seconds ?? r.seconds ?? 0), 0).toFixed(1),
    files: results.filter((r) => r.status === 'success').flatMap((r) => r.files.map((f) => f.file)),
    llm_tokens: designEntry.usage?.total_tokens ?? null,
    succeeded: results.filter((r) => r.status === 'success').length, failed: results.filter((r) => r.status !== 'success').length,
  },
};
await fs.writeFile(path.join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2));
log(`done in ${manifest.total_wall_seconds}s, media cost ~$${manifest.totals.media_cost_usd}`);
