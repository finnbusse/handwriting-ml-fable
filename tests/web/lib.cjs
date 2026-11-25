// Shared helpers for the web tests: browser, mocked Hugging Face, pen input via CDP.
const pw = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { start } = require('./server.cjs');

const SHOTS = path.join(__dirname, 'screenshots');
const SCHEMA = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'docs', 'schema', 'hwline_v1.schema.json'), 'utf8'));
const FAKE_TOKEN = 'hf_test_dummy_token';
const FAKE_USER = 'testwriter';

let results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${!cond && detail ? `  -- ${detail}` : ''}`);
}
function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

async function launch() {
  return pw.chromium.launch({ args: ['--disable-gpu'] });
}

/**
 * New context + page with every huggingface.co request mocked.
 * hfHandler(route, request) may fulfill; anything unhandled gets a 599 abort.
 */
async function newApp(browser, server, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 800 },
    deviceScaleFactor: opts.dsf || 2,
    colorScheme: opts.colorScheme || 'light',
    serviceWorkers: opts.serviceWorkers || 'block',
    locale: 'de-DE',
    acceptDownloads: true,
  });
  const hfLog = [];
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)?huggingface\.co\//, async (route, request) => {
    const entry = { method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() };
    hfLog.push(entry);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (opts.hf) {
      const r = await opts.hf(entry);
      if (r === 'abort') return route.abort('internetdisconnected');
      if (r) return route.fulfill({ status: r.status, headers: Object.assign({ 'content-type': 'application/json' }, cors, r.headers || {}), body: r.body === undefined ? '{}' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) });
    }
    return route.abort('connectionrefused');
  });
  if (opts.signedIn) {
    await ctx.addInitScript(([token, name]) => {
      if (!localStorage.getItem('hw.auth')) localStorage.setItem('hw.auth', JSON.stringify({ token, name, source: 'token', expiresAt: null }));
    }, [FAKE_TOKEN, FAKE_USER]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(opts.url || server.url + (opts.hash || ''));
  await page.waitForFunction(() => window.__hwReady).then(() => page.evaluate(() => window.__hwReady));
  return { ctx, page, cdp, hfLog, errors };
}

/** Pen helper. Coordinates are viewport CSS px. Timestamps spaced like a 480 Hz pen. */
function pen(cdp) {
  let clock = Date.now() / 1000;
  const send = (type, x, y, extra = {}) => {
    clock += 0.0021;
    return cdp.send('Input.dispatchMouseEvent', Object.assign({
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
      pointerType: 'pen', force: 0.5, tiltX: 0, tiltY: 20, twist: 0, timestamp: clock,
    }, extra));
  };
  return {
    /** points: [[x,y,pressure], ...]; first = down, last = up position (not stored). */
    async stroke(points, extra = {}) {
      const [x0, y0, p0] = points[0];
      await send('mousePressed', x0, y0, Object.assign({ force: p0 === undefined ? 0.5 : p0 }, extra));
      for (let i = 1; i < points.length - 1; i++) {
        const [x, y, p] = points[i];
        await send('mouseMoved', x, y, Object.assign({ force: p === undefined ? 0.5 : p }, extra));
      }
      const [xe, ye] = points[points.length - 1];
      await send('mouseReleased', xe, ye, Object.assign({ force: 0 }, extra));
      clock += 0.12;   // pen lifted between strokes
    },
    async touchTap(x, y) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

/** A small glyph-like stroke (loop) starting at (x, y). */
function glyph(x, y, n = 10, h = 28, w = 18) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 1.6;
    pts.push([x + w * 0.5 * (1 - Math.cos(a)) + i * 0.137, y - h * 0.5 * Math.sin(a) - i * 0.051, 0.3 + 0.03 * i]);
  }
  return pts;
}

async function canvasRect(page) {
  return page.evaluate(() => { const r = document.getElementById('cap-canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
}

/** Wait out the 300 ms button guard and the 250 ms double-activation guard. */
const settle = (page) => page.waitForTimeout(600);

/** Poll an async condition (page.waitForFunction does not await promises). */
async function until(fn, timeout = 10000, every = 50) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, every));
  }
}

async function lines(page) {
  return page.evaluate(() => window.__hw.store.allLines());
}

/** Minimal JSON-Schema check for the keywords used in hwline_v1.schema.json. */
function schemaErrors(value, schema = SCHEMA, at = '$') {
  const errs = [];
  const typeOk = (t, v) => (t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
    : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : t === 'null' ? v === null : typeof v === t);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) { errs.push(`${at}: type ${JSON.stringify(schema.type)}`); return errs; }
  }
  if ('const' in schema && value !== schema.const) errs.push(`${at}: const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: enum ${JSON.stringify(schema.enum)}`);
  if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: maxItems`);
    if (schema.items) value.forEach((v, i) => errs.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) errs.push(...schemaErrors(value[k], s, `${at}.${k}`));
  }
  return errs;
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

module.exports = { until, assert, launch, start, newApp, pen, glyph, canvasRect, settle, lines, schemaErrors, shot, check, summary, FAKE_TOKEN, FAKE_USER, SHOTS };
