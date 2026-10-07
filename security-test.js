// Hostile-site security checks against server.js. Run: npm test (needs ~70s: one case waits for the render deadline)
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');
const SP = 3999, GP = 3997, EP = 4001, sleep = ms => new Promise(r => setTimeout(r, ms));

let pings = 0, okHits = 0;
const pages = {
  '/ok': '<h1 style="background:red">Hello</h1><p>world</p>',
  // corrupts extract(): giant height + junk items, opens popups that phone home forever
  '/evil': `<p>evil</p><script>
    for (let i = 0; i < 5; i++) window.open('/popup');
    const m = Math.min; Math.min = (...a) => a.includes(2400) ? 1e7 : m(...a);
    const p = Array.prototype.push; Array.prototype.push = function (o) { return o && o.k ? p.call(this, { ...o, x: 1e300, w: 'x'.repeat(1e5), junk: 'y'.repeat(1e4), k: 'zz' }) : p.apply(this, arguments); };
  </script>`,
  '/popup': `<script>setInterval(() => fetch('/ping'), 300)</script>`,
  '/hang': `<p>hang</p><script>Object.defineProperty(document.fonts, 'ready', { get: () => new Promise(() => {}) })</script>`,
};
http.createServer((q, s) => {
  if (q.url === '/ping') { pings++; return s.end(); }
  if (q.url === '/ok') okHits++;
  s.writeHead(200, { 'content-type': 'text/html' }).end(pages[q.url] || '');
}).listen(EP);

const get = (path, headers = { 'x-hole': '1' }, method = 'GET', port = SP) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: 'localhost:' + port, ...headers } }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => ok({ code: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', no); r.end();
  return r;
});
const render = (p, h) => get('/api/render?rs=1&url=' + encodeURIComponent(`http://127.0.0.1:${EP}${p}`), h);

const start = (port, env) => spawn(process.execPath, [require('path').join(__dirname, 'server.js')], { env: { ...process.env, PUBLIC: '', ALLOW_PRIVATE: '', PORT: port, ...env }, stdio: 'inherit' });
const renderAt = (port, url) => get('/api/render?rs=1&url=' + encodeURIComponent(url), undefined, 'GET', port);

(async () => {
  // egress guard (default config): Chrome must not reach loopback/LAN/metadata, directly or via redirect
  const guard = start(GP, {});
  await sleep(4000);
  try {
    for (const u of [`http://127.0.0.1:${EP}/ok`, `http://localtest.me:${EP}/ok`, 'http://169.254.169.254/computeMetadata/v1/', 'http://[::1]:' + EP + '/ok', 'http://2130706433:' + EP + '/ok']) {
      const r = await renderAt(GP, u);
      assert(r.code === 500 && /blocked|ENOTFOUND/.test(r.body), u + ' → ' + r.code + ' ' + r.body.slice(0, 100));
    }
    const pub = await renderAt(GP, 'https://example.com');
    assert.equal(pub.code, 200, 'public site via proxy: ' + pub.body.slice(0, 100));
    const rd = await renderAt(GP, 'https://httpbin.org/redirect-to?url=' + encodeURIComponent(`http://127.0.0.1:${EP}/ok`));
    assert.equal(okHits, 0, 'redirect reached loopback');
    console.log('ok: egress guard (public site 200, redirect→loopback blocked, httpbin', rd.code + ')');
  } finally { guard.kill(); }

  const srv = start(SP, { ALLOW_PRIVATE: '1' }); // rest of the suite serves its hostile pages from 127.0.0.1
  await sleep(4000);
  try {
    // CSRF / method / headers
    assert.equal((await render('/ok', {})).code, 403, 'no x-hole → 403');
    assert.equal((await render('/ok', { 'x-hole': '1', 'sec-fetch-site': 'cross-site' })).code, 403, 'cross-site → 403');
    assert.equal((await get('/api/render', { 'x-hole': '1' }, 'POST')).code, 405, 'POST → 405');
    const home = await get('/', {});
    assert.equal(home.headers['x-frame-options'], 'DENY');
    console.log('ok: csrf / method / framing');

    // normal page still works
    const ok = await render('/ok');
    assert.equal(ok.code, 200, ok.body.slice(0, 200));
    const d = JSON.parse(ok.body);
    assert(d.items.length > 3 && d.items.some(i => i.k === 'b' && i.bg) && d.obj && d.txt && d.bg);
    console.log('ok: normal render', d.items.length, 'items, h =', d.height);

    // hostile page: output clamped, popups die with the render
    const ev = await render('/evil');
    assert.equal(ev.code, 200, ev.body.slice(0, 200));
    const e = JSON.parse(ev.body);
    assert(e.height <= 2400, 'height clamped: ' + e.height);
    for (const i of e.items) {
      assert(['t', 'o', 'b'].includes(i.k) && !('junk' in i));
      for (const f of ['x', 'y', 'w', 'h']) assert(Number.isFinite(i[f]) && Math.abs(i[f]) <= 2400, f + '=' + i[f]);
    }
    assert(ev.body.length < 5e6, 'response small: ' + ev.body.length);
    await sleep(500); const p0 = pings; await sleep(2000);
    assert.equal(pings, p0, 'popups still alive after render');
    console.log('ok: hostile output clamped, popups killed (', p0, 'pings during render )');

    // concurrency cap + client abort frees the slot
    const a = http.request({ host: '127.0.0.1', port: SP, path: '/api/render?url=' + encodeURIComponent(`http://127.0.0.1:${EP}/hang`), headers: { host: 'localhost:' + SP, 'x-hole': '1' } });
    a.on('error', () => {}); a.end();
    const b = render('/hang');
    await sleep(500);
    assert.equal((await render('/ok')).code, 429, 'third job → 429');
    a.destroy(); await sleep(1000);
    const c = render('/ok');
    console.log('ok: 429 at cap');
    assert.equal((await c).code, 200, 'aborted client freed its slot');
    console.log('ok: abort frees slot');

    // hard deadline
    const t0 = Date.now(), hb = await b;
    assert.equal(hb.code, 500); assert.match(hb.body, /timed out/);
    console.log('ok: hang page timed out after', Math.round((Date.now() - t0) / 1000), 's');
    console.log('ALL PASS');
  } finally { srv.kill(); }
})().catch(e => { console.error("FAIL", e.message); process.exitCode = 1; }).then(() => process.exit());
