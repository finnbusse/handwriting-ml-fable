// Renders web/icons/icon.svg to the PNG sizes the manifest lists. Run once
// after changing the SVG: node tests/web/make_icons.cjs
const pw = require('playwright');
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..', '..', 'web', 'icons');
(async () => {
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const b = await pw.chromium.launch();
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: path.join(dir, name) });
    await p.close();
  }
  await b.close();
  console.log('icons written to', dir);
})();
