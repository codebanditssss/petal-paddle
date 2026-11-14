// Prints a markdown table of what the pipeline actually did, from assets/manifest.json.
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync(new URL('../assets/manifest.json', import.meta.url)));
const rows = m.steps.map((s) => `| ${s.id || s.kind} | \`${s.model}\` | ${s.status || 'success'} | ${s.server_seconds ?? s.seconds ?? ''}s | ${s.cost_usd != null ? '$' + s.cost_usd : '—'} | ${s.files ? s.files.map((f) => f.file).join(', ') : s.usage ? s.usage.total_tokens + ' tokens' : (s.error || '').slice(0, 90)} |`);
const out = `| asset | model | status | gen time | cost | output |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n**Total spend: $${m.totals.total_cost_usd}** (media $${m.totals.media_cost_usd} + LLM $${m.totals.llm_cost_usd}) · ${m.totals.succeeded} assets generated · ${m.totals.generation_seconds_sum}s of summed generation time (jobs run in parallel)`;
const mv = m.music_variants || [];
const out2 = mv.length ? `\n\n**Soundtrack iterations** (minimax-music-3.0, $0.15 each, checked with ffmpeg plus a gemini-4-carbon listen for vocals):\n\n| variant | gen time | listen check | 10s preview |\n|---|---|---|---|\n` + mv.map((v) => `| ${v.id} | ${v.server_seconds ?? v.seconds}s | ${v.listen_check} | ${v.id.startsWith('v') ? `[preview](shots/music_previews/${v.id}_10s.mp3)` : '—'} |`).join('\n') + `\n\nAll-in spend including the rejected songs and listen checks: **$${m.totals.all_in_spend_usd}**` : '';
const outAll = out + out2;
if (process.argv.includes('--write')) {
  const p = new URL('../README.md', import.meta.url);
  const r = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, r.replace(/<!-- numbers -->[\s\S]*<!-- \/numbers -->/, `<!-- numbers -->\n${outAll}\n<!-- /numbers -->`));
}
console.log(outAll);
