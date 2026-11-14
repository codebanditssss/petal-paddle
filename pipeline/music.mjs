// Regenerate the soundtrack: several instrumental variants on minimax-music-3.0, logged into manifest.json.
import fs from 'node:fs/promises';
import path from 'node:path';
const KEY = process.env.GMI_API_KEY; if (!KEY) { console.error('Set GMI_API_KEY'); process.exit(1); }
const RQ = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests';
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'minimax-music-3.0', PRICE = 0.15;
const LYRICS = '[Inst]\n\n[Inst]\n\n[Interlude]\n\n[Inst]\n\n[Solo]\n\n[Inst]';
const BASE = 'Pure music, instrumental only, no vocals, no singing, no humming, no voice. Seamless loopable background music for a cozy video game, calm Animal Crossing and Stardew Valley vibes, warm and catchy, gentle melody that repeats, soft dynamics, no big build-ups, no abrupt ending.';
const VARIANTS = [
  { id: 'v4_kalimba_lofi', prompt: `Lo-fi cozy game loop, 88 BPM, soft kalimba lead melody, warm Rhodes chords, mellow brushed drums and soft kick, round upright bass, light vinyl crackle, sunny pond afternoon. ${BASE}` },
  { id: 'v5_plucked_guitar', prompt: `Cozy indie folk game theme, 92 BPM, fingerpicked nylon guitar melody, plucked ukulele, soft glockenspiel accents, gentle shaker and rim clicks, warm bass, cheerful and relaxed. ${BASE}` },
  { id: 'v6_marimba_bossa', prompt: `Playful cozy game loop, 90 BPM, marimba and kalimba melody, soft bossa nova groove with brushes, mellow electric piano, light flute counter-melody, warm and bouncy, golden hour by the water. ${BASE}` },
];
async function run(v) {
  const t0 = Date.now(), submitted_at = new Date().toISOString();
  const payload = { lyrics: LYRICS, prompt: v.prompt, format: 'mp3', lyrics_optimizer: false };
  for (let a = 1; a <= 3; a++) {
    const r = await fetch(RQ, { method: 'POST', headers: auth, body: JSON.stringify({ model: MODEL, payload }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log(v.id, 'submit failed', r.status, JSON.stringify(j).slice(0, 200)); await sleep(30000); continue; }
    let d = j;
    while (!['success', 'failed', 'cancelled'].includes(d.status)) { await sleep(5000); d = await (await fetch(`${RQ}/${j.request_id}`, { headers: auth })).json(); }
    if (d.status !== 'success') { console.log(v.id, 'failed', JSON.stringify(d.outcome).slice(0, 200)); continue; }
    const url = d.outcome.media_urls?.[0]?.url || d.outcome.audio_url || JSON.stringify(d.outcome).match(/https?:[^"]+\.mp3/)[0];
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const file = path.join(ROOT, 'assets/alt_music', `${v.id}.mp3`);
    await fs.writeFile(file, buf);
    const e = { kind: 'music_variant', id: v.id, model: MODEL, payload, request_id: j.request_id, submitted_at, completed_at: new Date().toISOString(),
      seconds: +((Date.now() - t0) / 1000).toFixed(1), server_seconds: d.updated_at - d.created_at, cost_usd: PRICE, cost_source: 'GMI request-queue price list (price_info)',
      status: 'success', files: [{ file: path.relative(ROOT, file), bytes: buf.length }] };
    console.log('✓', v.id, e.seconds + 's');
    return e;
  }
  return { kind: 'music_variant', id: v.id, model: MODEL, status: 'failed' };
}
const res = await Promise.all(VARIANTS.map(run));
await fs.writeFile(path.join(ROOT, 'assets/alt_music/variants.json'), JSON.stringify(res, null, 2));
