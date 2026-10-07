# Web Hole

Feed any website to a black hole. Enter a URL and the page turns into a playground where you steer a hole that swallows it piece by piece: every letter, image, button and box. When nothing is left, the floor itself cracks and falls in.

**Play:** https://web-hole.web.app

**Demo video:** [WebHole.mp4](https://github.com/AtilganSak/ProjectImages/blob/main/WebHole/WebHole.mp4)

## How it works

1. The local Node server opens the site in headless Chrome ([Puppeteer](https://pptr.dev/)).
2. It walks the DOM and records every glyph, image and colored box with its position on the page.
3. It takes three screenshots: one with only images, one with only text (both with transparent backgrounds) and one with everything removed (the floor).
4. The browser cuts each object out of those layers and draws it on a canvas. Objects keep their real shape, without a rectangle of page background around them.

The hole grows as it eats, the camera zooms out with it, and you can always finish the page: once nothing left fits, the hole grows to the smallest leftover.

## Files

| File | Role |
|---|---|
| `server.js` | Render API, egress proxy, CSRF / Host guards, rate limit |
| `index.html` | The whole game client (canvas, controls, best scores) |
| `security-test.js` | Hostile-page and egress checks (`npm test`) |
| `Dockerfile` | Cloud Run image |
| `firebase.json`, `hosting/` | Firebase Hosting in front of Cloud Run |

## Run

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000, type a site (e.g. `wikipedia.org`) and press **Play**. Use the `PORT` environment variable to change the port.

### Environment variables

| Variable | Effect |
|---|---|
| `PORT` | Listen port (default 3000) |
| `PUBLIC=1` | Internet-facing: listen on all interfaces, accept any `Host`, limit renders per IP |
| `MAX_RS` | Max render sharpness (default 2.5; lower = smaller responses) |
| `ALLOW_PRIVATE=1` | Let the renderer reach localhost/LAN addresses (local dev only, never when public) |
| `CHROME_NO_SANDBOX=1` | Only if Chrome can't start its sandbox in a container |

### Deploy (Google Cloud Run)

The `Dockerfile` builds a public image (`PUBLIC=1`, `MAX_RS=1.5`). With the [gcloud CLI](https://cloud.google.com/sdk/docs/install):

```bash
gcloud iam service-accounts create webhole-run --display-name "Web Hole (no permissions)"
gcloud run deploy webhole --source . --region us-central1 --allow-unauthenticated --execution-environment gen2 --memory 2Gi --cpu 2 --max-instances 1 --concurrency 8 --timeout 90 --service-account webhole-run@PROJECT_ID.iam.gserviceaccount.com
```

The service account has no roles on purpose: the renderer loads untrusted pages, so it gets no cloud permissions.

The public address https://web-hole.web.app is Firebase Hosting forwarding to that service (`firebase.json`). After changing it:

```bash
npx firebase-tools deploy --only hosting --project webhole-510707
```

Behind Firebase the per-IP limit reads the visitor from `Fastly-Client-IP`. Each render is logged with its IP (`gcloud run services logs read webhole --region us-central1`).

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys | Move |
| Mouse drag | Move toward the cursor |
| Touch | Virtual joystick: touch anywhere, drag in a direction |
| Esc | Back to home (also cancels loading) |

Best scores are saved per site in your browser (`localStorage`) and shown on the home screen.

## Tuning

The gameplay constants are at the top of the script in `index.html`:

- `SPEED`, `SLOW`: start speed and how much the hole slows down as it grows
- `GROW`: how fast the hole grows
- `VIEW0`, `VIEWK`: camera zoom (start distance and zoom-out rate)
- `TILE`, `CRUMBLE`: the final floor collapse
- `JOY_R`: joystick radius

## Notes

- The server fetches arbitrary URLs. By default it only listens on `127.0.0.1` and rejects unexpected `Host` headers; requests from other origins are always rejected. All of Chrome's traffic goes through a built-in proxy that refuses private, loopback and link-local addresses (including cloud metadata), so a rendered page can't reach the host's network.
- `npm test` runs the security checks (hostile pages, egress guard, limits). It takes about 70 seconds and needs internet access.
- Only the top 2400px of a page is captured, at a 1440px desktop viewport.
- Sites with bot protection, login walls or cookie banners may render poorly.
- Each round decodes three large images, so expect a few hundred MB of memory. Phones with little RAM may struggle on heavy pages.
