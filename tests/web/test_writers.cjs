// Several people on one device: slug rules, no recording without a writer, per-writer progress
// (local and from the dataset listing), new session id on switching, upload path, backup.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('./lib.cjs');

const mod = (p) => import(pathToFileURL(path.resolve(__dirname, '..', '..', 'web', 'js', p)).href);

function promptIds() {
  try {
    const d = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'prompts', 'de-core.json'), 'utf8'));
    if (Array.isArray(d.prompts) && d.prompts.length > 3) return d.prompts.slice().sort((a, b) => a.block - b.block).map((p) => p.id);
  } catch (_) {}
  return ['fallback-0001', 'fallback-0002', 'fallback-0003', 'fallback-0004'];
}

async function unit() {
  const { slugify, makeWriter, cleanName } = await mod('writer.js');
  L.check('slug: lowercase', slugify('Finn') === 'finn');
  L.check('slug: umlauts and sharp s', slugify('Jörg Müller Groß') === 'joerg-mueller-gross', slugify('Jörg Müller Groß'));
  L.check('slug: capital umlauts', slugify('ÄÖÜ') === 'aeoeue', slugify('ÄÖÜ'));
  L.check('slug: other characters reduced to a-z 0-9 and "-"', slugify('  Anna_Lena (7b)!  ') === 'anna-lena-7b', slugify('  Anna_Lena (7b)!  '));
  L.check('slug: accents folded, no leading/trailing dash', slugify('--José--') === 'jose', slugify('--José--'));
  L.check('slug: at most 24 characters, no trailing dash', slugify('abcdefghijklmnopqrstuvwxyz0123').length === 24 && !slugify('abcdefghijklmnopqrstuvw xyz').endsWith('-') && slugify('abcdefghijklmnopqrstuvw xyz') === 'abcdefghijklmnopqrstuvw', slugify('abcdefghijklmnopqrstuvw xyz'));
  L.check('slug: empty input gives no slug', slugify('') === '' && slugify('   ') === '' && slugify('!?-') === '' && slugify('日本') === '' && slugify(null) === '');
  L.check('writer: empty input gives no writer', makeWriter('  ') === null && makeWriter('???') === null);
  L.check('writer: display name trimmed and kept as typed', makeWriter('  Finn   Müller ').name === 'Finn Müller' && makeWriter('  Finn   Müller ').id === 'finn-mueller' && cleanName(' a  b ') === 'a b');
}

(async () => {
  await unit();
  const server = await L.start();
  const browser = await L.launch();
  try {
    // ---- two writers on one device, nothing signed in ----
    {
      const { page, cdp, errors } = await L.newApp(browser, server);
      const p = L.pen(cdp);
      async function line() {
        const rect = await L.canvasRect(page);
        await p.stroke(L.glyph(rect.left + 80, rect.top + rect.height * 0.64, 6));
        await L.settle(page);
        await page.click('#cap-done');
        await page.waitForSelector('#cap[data-state="confirm"]');
        await L.settle(page);
        await page.click('#confirm-ok');
        await page.waitForSelector('#cap[data-state="write"], #cap[data-state="block"]');
      }
      const promptNow = () => page.textContent('#cap-prompt');
      const writerNow = () => page.textContent('#cap-writer');

      await page.fill('#start-writer', '   ');
      await page.click('#start-go');
      L.check('a blank name is not accepted', (await page.isVisible('#start-err')) && (await page.evaluate(() => window.__hw.app.writer)) === null);
      await page.fill('#start-writer', 'Finn');
      await page.click('#start-go');
      await page.waitForSelector('#cap[data-state="write"]');
      await page.waitForTimeout(150);
      const first = await promptNow();
      await line(); await line();
      L.check('Finn: "2 Zeilen geschrieben", shown with his name', (await page.textContent('#cap-total')) === '2 Zeilen geschrieben' && (await writerNow()) === 'Finn', await page.textContent('#cap-total'));
      L.check('Finn: next line is line 3', /Zeile 3 von/.test(await page.textContent('#cap-progress')));
      const finnNext = await promptNow();
      const finnRecs = (await L.lines(page)).map((e) => e.record);
      const finnSession = finnRecs[0].session_id;
      L.check('Finn: both records have the same session and his writer', finnRecs.length === 2 && finnRecs.every((r) => r.writer_id === 'finn' && r.writer_name === 'Finn' && r.session_id === finnSession));

      // Settings: known writers as choices, add another person.
      await page.click('a[data-route="einstellungen"]');
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      L.check('settings: "Wer schreibt?" shows the current writer and one choice', (await page.textContent('#g-writer')) === 'Wer schreibt?' && (await page.textContent('#wr-current')) === 'Finn' && (await page.$$('#wr-list .choice')).length === 1);
      L.check('settings: "Andere Person hinzufügen" is offered', (await page.textContent('#wr-add')).trim() === 'Andere Person hinzufügen');
      await page.click('#wr-add');
      await page.fill('#wr-input', '  ');
      await page.click('#wr-ok');
      L.check('settings: a blank name is refused with a hint', await page.isVisible('#wr-err'));
      await page.fill('#wr-input', 'Lena Weiß');
      await page.click('#wr-ok');
      await page.waitForTimeout(200);
      L.check('settings: new person becomes the current writer; both are choices', (await page.textContent('#wr-current')) === 'Lena Weiß'
        && (await page.$$eval('#wr-list .choice', (b) => b.map((x) => x.textContent.trim() + ':' + x.getAttribute('aria-checked')).join())) === 'Finn:false,Lena Weiß:true');
      L.check('settings: writer list and current writer are kept in the kv store', await page.evaluate(async () => {
        const w = await window.__hw.store.kvGet('writers'); const c = await window.__hw.store.kvGet('writer');
        return JSON.stringify(w) === JSON.stringify([{ id: 'finn', name: 'Finn' }, { id: 'lena-weiss', name: 'Lena Weiß' }]) && c === 'lena-weiss';
      }));
      await page.click('a[data-route="erfassen"]');
      await page.waitForSelector('#cap[data-state="write"]');
      await page.waitForTimeout(150);
      L.check('Lena: own progress, starts at line 1 with the first prompt', (await writerNow()) === 'Lena Weiß' && (await page.textContent('#cap-total')) === '' && /Block 1 · Zeile 1 von/.test(await page.textContent('#cap-progress')) && (await promptNow()) === first);
      await line();
      L.check('Lena: "1 Zeile geschrieben"', (await page.textContent('#cap-total')) === '1 Zeile geschrieben', await page.textContent('#cap-total'));
      const lena = (await L.lines(page)).map((e) => e.record).find((r) => r.writer_id === 'lena-weiss');
      L.check('Lena: record has her writer_id and writer_name, new session id', lena && lena.writer_name === 'Lena Weiß' && lena.session_id !== finnSession && lena.seq === 0, JSON.stringify(lena && [lena.writer_id, lena.session_id, lena.seq]));
      const lenaEntry = (await L.lines(page)).find((e) => e.record.id === lena.id);
      L.check('Lena: upload path contains her writer id', lenaEntry.path === `raw/v1/lena-weiss/${lena.session_id}/${lena.prompt.id}__${lena.id}.json`, lenaEntry.path);
      L.check('Finn\'s stored lines keep their writer', (await L.lines(page)).filter((e) => e.record.writer_id === 'finn').length === 2);

      // Back to Finn: his progress, a new session.
      await L.switchWriter(page, 'Finn');
      await page.waitForTimeout(150);
      L.check('Finn again: his count and his next prompt', (await writerNow()) === 'Finn' && (await page.textContent('#cap-total')) === '2 Zeilen geschrieben' && (await promptNow()) === finnNext);
      await line();
      const all = (await L.lines(page)).map((e) => e.record);
      const finn3 = all.filter((r) => r.writer_id === 'finn').sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[2];
      L.check('switching writer starts a new session id (and seq 0)', finn3.session_id !== finnSession && finn3.session_id !== lena.session_id && finn3.seq === 0, JSON.stringify([finn3.session_id, finn3.seq]));
      L.check('switching to the same writer keeps the session', await (async () => {
        await L.switchWriter(page, 'Finn');
        await line();
        const f = (await L.lines(page)).map((e) => e.record).filter((r) => r.writer_id === 'finn').sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        return f[3].session_id === f[2].session_id && f[3].seq === 1;
      })());

      // A writer chosen once is still current after a reload.
      await page.reload();
      await page.waitForFunction(() => window.__hwReady);
      await page.waitForSelector('#cap[data-state="write"]');
      L.check('current writer survives a reload', (await writerNow()) === 'Finn' && (await page.textContent('#cap-total')) === '4 Zeilen geschrieben', await page.textContent('#cap-total'));

      // Backup: all writers' lines, each with its writer fields.
      await page.click('a[data-route="einstellungen"]');
      await page.waitForSelector('#v-einstellungen:not([hidden])');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
      const rows = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      L.check('backup holds the lines of all writers, each with writer_id and writer_name', rows.length === 5
        && rows.filter((r) => r.writer_id === 'finn' && r.writer_name === 'Finn').length === 4
        && rows.filter((r) => r.writer_id === 'lena-weiss' && r.writer_name === 'Lena Weiß').length === 1);
      L.check('records satisfy the schema (with writer_name)', rows.every((r) => L.schemaErrors(r).length === 0), rows.map((r) => L.schemaErrors(r).join(';')).join('|'));
      L.check('no page errors', errors.length === 0, errors.join(' | '));
    }

    // ---- progress from a dataset listing that holds both writers' folders; upload path ----
    {
      const ids = promptIds();
      const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const commits = [];
      const hf = (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/api/whoami-v2') return { status: 200, body: { name: L.FAKE_USER } };
        if (u.pathname === `/api/datasets/${L.FAKE_USER}/handwriting-fable/tree/main/raw/v1`) {
          return { status: 200, body: [
            { type: 'file', path: `raw/v1/finn/s1/${ids[0]}__${uuid(1)}.json` },
            { type: 'file', path: `raw/v1/finn/s1/${ids[1]}__${uuid(2)}.json` },
            { type: 'file', path: `raw/v1/lena/s2/${ids[0]}__${uuid(3)}.json` },
            { type: 'file', path: `raw/v1/lena/s2/${ids[2]}__${uuid(4)}.json` },
            { type: 'file', path: `raw/v1/lena/s2/${ids[3]}__${uuid(5)}.json` },
            { type: 'file', path: `raw/v1/finn-x/s3/${ids[2]}__${uuid(6)}.json` },
          ] };
        }
        if (u.pathname.endsWith('/commit/main')) { commits.push(req); return { status: 200, body: { success: true } }; }
        return null;
      };
      const { page, cdp, errors } = await L.newApp(browser, server, { signedIn: true, hf, writer: 'Finn' });
      const total = () => page.textContent('#cap-total');
      const shownId = () => page.evaluate(() => window.__hw.app.prompts.prompts.find((p) => p.text === document.getElementById('cap-prompt').textContent).id);
      await L.until(async () => (await total()) === '2 Zeilen geschrieben');
      L.check('listing with two folders: Finn counts only his own 2 lines', (await total()) === '2 Zeilen geschrieben', await total());
      L.check('Finn: next prompt is the first he has not written', (await shownId()) === ids[2], await shownId());
      await L.switchWriter(page, 'Lena');
      await L.until(async () => (await total()) === '3 Zeilen geschrieben');
      L.check('Lena counts only the 3 lines of her folder', (await total()) === '3 Zeilen geschrieben', await total());
      L.check('Lena: next prompt is the first she has not written', (await shownId()) === ids[1], await shownId());
      L.check('progress per writer is also kept for later (offline)', await page.evaluate(async () => {
        const kv = await window.__hw.store.kvGet('remoteDone');
        return kv && kv.user === 'testwriter' && kv.by.finn.length === 2 && kv.by.lena.length === 3;
      }));

      // A line written by Lena is uploaded into her folder and counts for her only.
      const rect = await L.canvasRect(page);
      await L.pen(cdp).stroke(L.glyph(rect.left + 80, rect.top + rect.height * 0.64, 6));
      await L.settle(page);
      await page.click('#cap-done');
      await page.waitForSelector('#cap[data-state="confirm"]');
      await L.settle(page);
      await page.click('#confirm-ok');
      await page.waitForSelector('#cap[data-state="write"]');
      await page.evaluate(() => window.__hw.outbox.flush('manual'));
      await L.until(() => commits.length === 1);
      const nd = commits[0].body.split('\n').map((l) => JSON.parse(l));
      L.check('uploaded file path is raw/v1/<writer>/<session>/<prompt>__<id>.json', nd.length === 2 && /^raw\/v1\/lena\/[0-9a-f-]{36}\/[^/]+__[0-9a-f-]{36}\.json$/.test(nd[1].value.path), nd[1] && nd[1].value.path);
      L.check('the uploaded record names its writer', JSON.parse(nd[1].value.content).writer_id === 'lena' && JSON.parse(nd[1].value.content).writer_name === 'Lena');
      await L.until(async () => (await total()) === '4 Zeilen geschrieben');
      await L.switchWriter(page, 'Finn');
      await page.waitForTimeout(200);
      L.check('Finn\'s count is not changed by Lena\'s upload', (await total()) === '2 Zeilen geschrieben', await total());
      L.check('no page errors', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.join(' | '));
    }
  } catch (e) {
    console.error(e); L.check('test ran without exception', false, String(e));
  } finally {
    await browser.close(); await server.close();
  }
  process.exit(L.summary() ? 0 : 1);
})();
