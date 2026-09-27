// Records docs/assets/demo.gif from the ?demo kitchen: npm run demo:record.
// The page runs on Playwright's fake clock, and every GIF frame advances it by exactly one
// frame interval, so the output doesn't depend on how fast this machine renders (software
// WebGL is fine). One demo loop plays as a warm-up first, so the GIF loops seamlessly.
// Needs a build (npm run build) and Chromium: npx playwright install --only-shell chromium.
// Options: --fps 20 --width 800 --height 450 --tolerance 16 --out docs/assets/demo.gif
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import gifenc from 'gifenc';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = path.join(import.meta.dirname, '..');
const MAX_BYTES = 5 * 1024 * 1024;

const { values: opts } = parseArgs({
  options: {
    fps: { type: 'string', default: '20' },
    width: { type: 'string', default: '800' },
    height: { type: 'string', default: '450' },
    tolerance: { type: 'string', default: '16' },
    out: { type: 'string', default: 'docs/assets/demo.gif' },
  },
});
const fps = Number(opts.fps);
const width = Number(opts.width);
const height = Number(opts.height);
const tolerance = Number(opts.tolerance);
const out = path.resolve(root, opts.out);
const frameMs = 1000 / fps;
if (!Number.isInteger(frameMs)) throw new Error(`--fps must divide 1000 evenly (got ${fps})`);

// The loop length lives in the web app; read it rather than keep a second copy.
const script = readFileSync(path.join(root, 'packages/web/src/demo/script.ts'), 'utf8');
const loopMs = Number(/DEMO_LOOP_MS = ([\d_]+)/.exec(script)?.[1].replaceAll('_', ''));
if (!loopMs) throw new Error('DEMO_LOOP_MS not found in packages/web/src/demo/script.ts');

const bin = path.join(root, 'packages/cli/bin/orderup.js');
if (!existsSync(path.join(root, 'packages/cli/dist/web/index.html'))) {
  throw new Error('orderup-cli is not built: run npm run build first.');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Starts the built CLI in demo mode with a throwaway HOME. */
async function startKitchen(home) {
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, [bin, '--demo', '--no-open', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('OrderUp kitchen open at')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`orderup exited ${code}:\n${output}`)));
  });
  return { child, url: `http://127.0.0.1:${port}/?demo` };
}

async function captureFrames(url) {
  const browser = await chromium.launch({
    // Software WebGL, so headless machines without a GPU record the same frames.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });
    // Fakes Date, timers, performance.now and requestAnimationFrame from the first script on.
    // Paused before the page loads: page time then moves only with runFor(), never with the
    // real time spent loading or taking screenshots.
    const start = new Date('2026-01-01T12:00:00Z');
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 1000));
    // The fake clock ticks rAF every 16 ms; software WebGL would then render three frames for
    // each one kept. Draw exactly once per GIF frame instead (setTimeout is the fake one).
    // CSS animations and transitions (bell, bubbles) run on the real compositor clock, so
    // each one is paused when first seen and driven from fake time on every frame.
    await page.addInitScript((ms) => {
      const born = new WeakMap();
      const syncCss = () => {
        const now = performance.now();
        for (const anim of globalThis.document.getAnimations()) {
          if (!born.has(anim)) {
            born.set(anim, now);
            anim.pause();
          }
          anim.currentTime = now - born.get(anim);
        }
      };
      globalThis.requestAnimationFrame = (cb) =>
        setTimeout(() => {
          syncCss();
          cb(performance.now());
          syncCss();
        }, ms);
      globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }, frameMs);
    await page.goto(url);
    await page.locator('canvas').first().waitFor();

    process.stdout.write(`warm-up: one ${loopMs / 1000} s loop… `);
    await page.clock.runFor(loopMs);
    console.log('done');

    const count = Math.round(loopMs / frameMs);
    const frames = [];
    for (let i = 0; i < count; i++) {
      await page.clock.runFor(frameMs);
      const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
      frames.push(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length));
      if ((i + 1) % fps === 0) process.stdout.write(`\rcaptured ${i + 1}/${count} frames`);
    }
    console.log();
    return frames;
  } finally {
    await browser.close();
  }
}

/**
 * One palette for the whole GIF (no colour flicker). A pixel is only redrawn when it moved
 * more than `tolerance` (sum of RGB differences) from what is already on screen; the rest
 * is transparent over the previous frame. That halves the size without visible change.
 */
function encode(frames) {
  const pixels = width * height * 4;
  const step = Math.max(1, Math.floor(frames.length / 12));
  const sample = new Uint8Array(pixels * Math.ceil(frames.length / step));
  for (let i = 0, k = 0; i < frames.length; i += step, k++) sample.set(frames[i], k * pixels);
  const palette = quantize(sample, 255);
  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);

  const gif = GIFEncoder();
  let shown = null;
  for (const [i, rgba] of frames.entries()) {
    const index = applyPalette(rgba, palette);
    if (!shown) {
      shown = index.slice();
    } else {
      for (let p = 0; p < index.length; p++) {
        const [r, g, b] = palette[shown[p]];
        const diff =
          Math.abs(rgba[4 * p] - r) + Math.abs(rgba[4 * p + 1] - g) + Math.abs(rgba[4 * p + 2] - b);
        if (index[p] === shown[p] || diff <= tolerance) index[p] = transparentIndex;
        else shown[p] = index[p];
      }
    }
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: frameMs,
      repeat: 0,
      transparent: i > 0,
      transparentIndex,
      dispose: 1, // keep the previous frame under the transparent pixels
    });
  }
  gif.finish();
  return gif.bytes();
}

const home = mkdtempSync(path.join(os.tmpdir(), 'orderup-record-'));
const { child, url } = await startKitchen(home);
try {
  console.log(`recording ${url} at ${width}×${height}, ${fps} fps`);
  const bytes = encode(await captureFrames(url));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  const mb = (bytes.length / 1024 / 1024).toFixed(2);
  console.log(`wrote ${path.relative(root, out)}: ${mb} MB`);
  if (bytes.length > MAX_BYTES) {
    console.error('over the 5 MB budget: lower --fps, --width/--height.');
    process.exitCode = 1;
  }
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}
