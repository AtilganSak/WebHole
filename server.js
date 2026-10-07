const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const PUBLIC = process.env.PUBLIC === '1';               // internet-facing: listen on all interfaces, no Host lock, per-IP limit
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // let Chrome reach localhost/LAN (local dev & tests only)
// ponytail: fixed render size; tall viewport makes lazy images load without scrolling
const W = 1440, H = 2400;
const MAX_RS = +process.env.MAX_RS || 2.5; // deviceScaleFactor cap: 3 layers × (W·RS)×(H·RS) px each must fit client RAM (and egress)
const RATE = 10;                  // PUBLIC: renders per IP per 10 min
const hits = new Map();
setInterval(() => hits.clear(), 600e3).unref(); // ponytail: fixed window, a burst at the boundary gets 2×RATE
const CAP = 20000;                // max eatable objects
const RENDER_MS = 60000;          // hard deadline for one render (goto alone may take 25s)
const MAX_JOBS = 2;               // concurrent renders; each holds ~3 huge screenshots in RAM
let jobs = 0;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browserP;

// Runs inside the target page. Returns {h, items} in CSS px. Items in DOM pre-order (≈ paint order):
//   k:'t' glyph (cut from txt layer) · k:'o' image/input/bg-image element (cut from obj layer)
//   k:'b' plain color/border box, drawn by the client from {bg, b:[t,r,b,l] ([width,color]|0), rad:[4 corners]}
// Marks elements with data-hole=a|g|b for the screenshot passes; window.__hole.keep = text past cap (+ its colors).
function extract(maxH, cap) {
  const ATOMIC = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD']);
  const h = Math.min(maxH, document.documentElement.scrollHeight);
  const ground = innerWidth * h * 0.6; // boxes bigger than this are the floor, not food
  const items = [], keep = [];
  window.__hole = { keep };
  const seen = c => c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(c); // alpha 0 → skip (rgb(…, 0) is opaque!)
  const vis = el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  const fits = r => r.width * r.height >= 3 && r.bottom > 0 && r.top < h && r.right > 0 && r.left < innerWidth;
  // false once cap is hit
  const add = (r, o) => items.length < cap && items.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)), ...o });
  const mark = (el, v) => el.setAttribute('data-hole', v);

  const range = document.createRange();
  const graphemes = new Intl.Segmenter(); // emoji / combining marks stay one sprite
  // returns false if cap cut this text short → its element keeps its glyphs in the bg pass
  const eatText = node => {
    for (const { segment, index } of graphemes.segment(node.textContent)) {
      if (!segment.trim()) continue;
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      const r = range.getBoundingClientRect();
      if (fits(r) && !add(r, { k: 't' })) return false;
    }
    return true;
  };

  const box = (el, r, cs) => {
    const b = ['Top', 'Right', 'Bottom', 'Left'].map(s => {
      const w = parseFloat(cs['border' + s + 'Width']), c = cs['border' + s + 'Color'];
      return w > 0 && seen(c) ? [w, c] : 0;
    });
    const bg = seen(cs.backgroundColor) ? cs.backgroundColor : '';
    if (!bg && !b.some(Boolean)) return;
    const m = Math.min(r.width, r.height);
    const rad = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(c => {
      const v = cs['border' + c + 'Radius'];
      return Math.min(m / 2, (v.endsWith('%') ? parseFloat(v) * m / 100 : parseFloat(v)) || 0);
    });
    if (add(r, { k: 'b', bg, b, rad })) mark(el, 'b');
  };

  // pre-order: a container is pushed before its children so it's drawn under them.
  // keeps walking past cap so leftover text gets marked in `keep`
  const walk = el => {
    const tag = el.tagName && el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    const r = el.getBoundingClientRect();
    if (ATOMIC.has(tag)) {
      if (fits(r) && vis(el) && add(r, { k: 'o' })) mark(el, 'a');
      return; // don't descend into images/svg/inputs
    }
    if (el !== document.body && fits(r) && r.width * r.height < ground && vis(el)) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') { if (add(r, { k: 'o' })) mark(el, 'g'); } // url()/gradient → sprite
      else box(el, r, cs);
    }
    for (const n of [...(el.shadowRoot ? el.shadowRoot.childNodes : []), ...el.childNodes]) {
      if (n.nodeType === 3) {
        if (n.textContent.trim() && vis(el) && !eatText(n) && !keep.some(k => k[0] === el)) {
          const c = getComputedStyle(el);
          keep.push([el, c.color, c.webkitTextFillColor, c.textShadow]);
        }
      } else if (n.nodeType === 1) walk(n);
    }
  };
  walk(document.body);
  return { h, items };
}

// Screenshot passes. Each isolates one layer:
//   obj: only images/bg-image elements, transparent elsewhere   txt: only glyphs, transparent elsewhere
//   bg:  page with every eaten thing removed (the floor under the sprites)
// transition:none → page's `transition: all .3s` would otherwise leave half-faded ghosts.
function pass(mode) {
  const s = document.getElementById('__hole') || document.head.appendChild(Object.assign(document.createElement('style'), { id: '__hole' }));
  const T = 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;';
  const BOX = 'background-color:transparent!important;background-image:none!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important;';
  const base = '*{transition:none!important;caret-color:transparent!important}';
  const pseudo = '*::before,*::after{opacity:0!important}'; // pseudo content isn't eatable; keep it out of sprites
  s.textContent = base + {
    obj: '*:not([data-hole=a]){' + T + '}*:not([data-hole=a]):not([data-hole=g]){' + BOX + '}' + pseudo,
    txt: '*{' + BOX + '}[data-hole=a]{opacity:0!important}' + pseudo,
    bg: '*{' + T + '}[data-hole=a]{opacity:0!important}[data-hole=g],[data-hole=b]{' + BOX + '}',
  }[mode];
  // text past the cap has no sprite → pin its original color (inline !important beats the sheet rule)
  if (mode === 'bg') window.__hole.keep.forEach(([el, c, f, ts]) => {
    el.style.setProperty('color', c, 'important');
    el.style.setProperty('-webkit-text-fill-color', f, 'important');
    el.style.setProperty('text-shadow', ts, 'important');
  });
}

// Egress guard: Chrome sends every request (page, subresources, redirects, WebSockets) through this proxy.
// It resolves the host once, refuses private/loopback/link-local (cloud metadata!) addresses, and connects to
// that exact IP, so DNS rebinding can't slip in between check and connect.
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, p, 'ipv4');
// no ::ffff:0:0/96 rule: BlockList already maps ::ffff:a.b.c.d onto the v4 rules (a /96 rule would block ALL IPv4)
for (const [a, p] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');
async function publicIp(host) {
  const addrs = await dns.lookup(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!ALLOW_PRIVATE && addrs.some(a => PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw new Error('blocked: private address');
  return addrs[0].address;
}
const proxy = http.createServer(async (req, res) => { // plain http://
  try {
    const u = new URL(req.url);
    if (u.protocol !== 'http:') throw new Error('bad proxy request');
    const ip = await publicIp(u.hostname);
    delete req.headers['proxy-connection'];
    const up = http.request({ host: ip, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  } catch (e) { res.writeHead(403).end(e.message); }
});
proxy.on('connect', async (req, sock, head) => { // https:// and ws(s):// tunnels
  sock.on('error', () => {});
  try {
    const i = req.url.lastIndexOf(':');
    const ip = await publicIp(req.url.slice(0, i));
    const up = net.connect(+req.url.slice(i + 1), ip, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head); sock.pipe(up); up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  } catch { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
});
const proxyPort = new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));

// sandbox stays ON: we render arbitrary untrusted sites. CHROME_NO_SANDBOX=1 only for containers where Chrome
// can't create its sandbox (it refuses to start, see logs). Failed launch / crashed browser → relaunch next request.
const browser = () => browserP ??= proxyPort.then(port => puppeteer.launch({ args: [
  `--proxy-server=http://127.0.0.1:${port}`,
  '--proxy-bypass-list=<-loopback>',                            // Chrome skips the proxy for localhost unless told not to
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // WebRTC UDP would go around the proxy
  ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  ...(PUBLIC ? ['--disable-dev-shm-usage'] : []),                // containers: tiny /dev/shm crashes big screenshots
] })).then(
  b => { b.on('disconnected', () => browserP = null); return b; },
  e => { browserP = null; throw e; });

// extract() runs in the page's own JS world, so the page can patch Math/DOM/prototypes and return anything.
// Treat its result as hostile: clamp every number, cap strings, rebuild items from known fields only.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
const color = v => typeof v === 'string' ? v.slice(0, 100) : '';
const clean = i => {
  const o = { k: ['t', 'o', 'b'].includes(i?.k) ? i.k : 'o', x: clamp(i?.x, -W, W), y: clamp(i?.y, -H, H), w: clamp(i?.w, 1, W), h: clamp(i?.h, 1, H) };
  if (o.k === 'b') {
    o.bg = color(i.bg);
    o.b = [0, 1, 2, 3].map(n => Array.isArray(i.b?.[n]) ? [clamp(i.b[n][0], 0, 100), color(i.b[n][1])] : 0);
    o.rad = [0, 1, 2, 3].map(n => clamp(i.rad?.[n], 0, H));
  }
  return o;
};

async function shoot(page, url, rs) {
  page.on('dialog', d => d.dismiss().catch(() => {})); // alert/confirm would block evaluate forever
  page.on('popup', p => p?.close().catch(() => {})); // popups push our tab to the background → screenshot never returns
  await page.setUserAgent(UA);
  await page.setViewport({ width: W, height: H, deviceScaleFactor: rs });
  // ponytail: slow sites get whatever loaded in 25s
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(e => { if (e.name !== 'TimeoutError') throw e; });
  await page.evaluate(() => document.fonts.ready.then(() => 0)); // glyph rects must match final fonts
  await sleep(1200);
  const res = await page.evaluate(extract, H, CAP);
  const h = Math.round(clamp(res?.h, 1, H));
  const items = Array.isArray(res?.items) ? res.items.slice(0, CAP).map(clean) : [];
  const clip = { x: 0, y: 0, width: W, height: h };
  const shot = async (mode, alpha) => {
    await page.evaluate(pass, mode);
    await sleep(120);
    return page.screenshot(alpha
      ? { type: 'webp', quality: 90, omitBackground: true, encoding: 'base64', clip } // webp keeps alpha → sprites are cut-outs
      : { type: 'jpeg', quality: 92, encoding: 'base64', clip });
  };
  const obj = await shot('obj', true), txt = await shot('txt', true), bg = await shot('bg', false);
  return { width: W, height: h, scale: rs, obj, txt, bg, items };
}

// Fresh context per render: closing it kills the page's popups (puppeteer disables the popup blocker),
// service workers and cookies, so nothing from a hostile site outlives its render. Downloads denied.
// Hard deadline + client-abort: a page that hangs evaluate (never-resolving fonts.ready, busy loop) can't leak a tab.
async function render(url, rs, signal) {
  const ctx = await (await browser()).createBrowserContext({ downloadBehavior: { policy: 'deny' } });
  let timer, onAbort;
  const stop = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error('render timed out')), RENDER_MS);
    onAbort = () => no(new Error('cancelled'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([ctx.newPage().then(p => shoot(p, url, rs)), stop]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await ctx.close().catch(() => {});
  }
}

http.createServer(async (req, res) => {
  // DNS rebinding guard: only answer requests addressed to us by a local name
  if (!PUBLIC && !/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || '')) return res.writeHead(403).end();
  const u = new URL(req.url, 'http://localhost');
  // gzip: screenshots are base64 → ~25% of it is encoding overhead gzip wins back; items JSON shrinks ~10×
  // ponytail: gzipSync blocks ~100ms on a big render; fine at MAX_JOBS=2
  const json = (code, body) => {
    const buf = Buffer.from(JSON.stringify(body)), gz = buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', vary: 'accept-encoding', ...(gz && { 'content-encoding': 'gzip' }) })
      .end(gz ? zlib.gzipSync(buf, { level: 4 }) : buf);
  };
  if (u.pathname === '/') {
    // no framing → no clickjacking the Play button
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (u.pathname !== '/api/render') return res.writeHead(404).end();
  if (req.method !== 'GET') return res.writeHead(405).end();
  // CSRF guard: a custom header can't be sent cross-origin without a CORS preflight, which we never grant.
  // Covers browsers that don't send Sec-Fetch-*; the Sec-Fetch-Site check stays as a second layer.
  const site = req.headers['sec-fetch-site'];
  if (req.headers['x-hole'] !== '1' || (site && site !== 'same-origin')) return res.writeHead(403).end();
  if (PUBLIC) {
    // Visitor IP. Via Firebase Hosting (the public URL) the last X-Forwarded-For entry is Hosting's own, rotating
    // egress address and the visitor is in Fastly-Client-IP. Direct run.app requests: the last XFF entry is the one
    // Google's front end appended (earlier entries are client-supplied).
    // ponytail: a direct run.app caller can forge Fastly-Client-IP to dodge this; MAX_JOBS + max-instances still cap cost
    const xff = req.headers['x-forwarded-for'] || '', fci = req.headers['fastly-client-ip'];
    const ip = net.isIP(fci) ? fci : xff.split(',').pop().trim() || req.socket.remoteAddress;
    console.log(JSON.stringify({ render: u.searchParams.get('url'), ip, xff }));
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > RATE) return json(429, { error: 'too many games from your network, try again in a few minutes' });
  }
  if (jobs >= MAX_JOBS) return json(429, { error: 'server busy, try again in a moment' });
  jobs++;
  const ac = new AbortController();
  res.on('close', () => ac.abort()); // client hit Esc / closed tab → stop rendering, free the slot
  try {
    let target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target; // also guarantees http(s)
    const rs = Math.min(MAX_RS, Math.max(1, +u.searchParams.get('rs') || 2)); // client asks for its screen's sharpness
    target = new URL(target);
    await publicIp(target.hostname); // clear error up front; the proxy enforces it again for redirects/subresources
    json(200, await render(target.href, rs, ac.signal));
  } catch (e) {
    json(500, { error: e.message });
  } finally {
    jobs--;
  }
// fetches arbitrary URLs: PUBLIC only behind the egress guard + per-IP limit above
}).listen(PORT, PUBLIC ? '0.0.0.0' : '127.0.0.1', () => console.log(`Web Hole: http://localhost:${PORT}${PUBLIC ? ' (public)' : ''}`));
