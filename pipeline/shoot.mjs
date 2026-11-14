// Headless check: load the game, screenshot menu + gameplay, record a demo video.
import { chromium } from 'playwright';
import fs from 'node:fs';
const GAME = process.env.GAME_URL || 'http://localhost:4173';
const out = new URL('../shots/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out + 'video/', size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(GAME);
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: out + '01_menu.png' });
await page.click('#start');
// steer with real key presses for a bit, then let the autopilot-free game run
const press = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); };
await press('ArrowUp', 1200); await press('ArrowRight', 900);
await page.screenshot({ path: out + '02_play.png' });
await press('ArrowDown', 1500); await press('ArrowLeft', 1100);
await page.screenshot({ path: out + '03_play.png' });
const st = await page.evaluate(() => ({ state: window.__game.state, score: window.__game.score, kinds: window.__game.usedKinds,
  musicPlaying: window.__game.musicPlaying, musicTime: window.__game.musicTime }));
await ctx.close();
// separate autopilot demo recording
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out + 'video/', size: { width: 1280, height: 720 } } });
const p2 = await ctx2.newPage();
const tRec = Date.now();
await p2.goto(GAME + '/?demo');
await p2.waitForFunction(() => window.__game && window.__game.state === 'play', null, { timeout: 120000, polling: 50 });
const playOffset = (Date.now() - tRec) / 1000 + 0.5; // seconds into the recording where gameplay is on screen
await p2.waitForTimeout(+(process.env.DEMO_MS || 16000));
await p2.screenshot({ path: out + '04_demo.png' });
const st2 = await p2.evaluate(() => ({ state: window.__game.state, score: window.__game.score }));
const vpath = await p2.video().path();
await ctx2.close(); await browser.close();
fs.writeFileSync(out + 'check.json', JSON.stringify({ manual: st, demo: st2, demo_video: vpath, play_offset_s: playOffset, logs }, null, 2));
console.log(JSON.stringify({ manual: st, demo: st2, demo_video: vpath, errors: logs.filter((l) => /error/i.test(l)) }, null, 2));
