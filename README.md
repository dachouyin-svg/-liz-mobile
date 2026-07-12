# Liz Mobile 6.1 — static phone edition

Pure-static Vite/React/TypeScript deployment for GitHub Pages. It has no application server, Cloudflare binding, D1/R2 dependency, or ChatGPT authentication requirement.

## Runtime design

- 18 canonical competition profiles. K League 1 is the only `ALPHA`; the other 17 stay `SHADOW`.
- API calls go directly from the browser to `https://v3.football.api-sports.io` with a request-scoped `x-apisports-key` header.
- The API key is encrypted with an AES-GCM `CryptoKey` created as non-extractable and saved in IndexedDB. Only ciphertext is saved to localStorage.
- Fixtures, raw provider response snapshots, and predictions are stored only in IndexedDB on the current device.
- JSON backup/export includes data and predictions, never the API key.
- The score kernel and deterministic opponent-adjusted Poisson GLM are exact copies of the tested Sites 6.1.0a4 Cloud Alpha port. Python-generated golden vectors guard parity.
- T−60 point-in-time policy and the three-hour result availability buffer are enforced locally. A lock is labeled only from 60 through 70 minutes before kickoff.
- Cup `AET`/`PEN` records train on `score.fulltime` (90-minute score); domestic-league `PEN` records do not enter training.

The GitHub Pages shell is publicly reachable. The API key and phone-local data are not published to GitHub. Do not paste the API key into source code, issues, chat, screenshots, build variables, or Actions secrets.

## Local verification

```sh
npm ci
npm run check
```

`npm run check` runs the ten contract/parity tests and a production TypeScript/Vite build.

## GitHub Pages deployment

The repository is `dachouyin-svg/-liz-mobile`; Vite therefore uses the base path `/-liz-mobile/`.

1. Push this directory to the `main` branch of `dachouyin-svg/-liz-mobile`.
2. In repository **Settings → Pages**, choose **GitHub Actions** as the source.
3. Run the included **Deploy GitHub Pages** workflow or push to `main`.
4. Open `https://dachouyin-svg.github.io/-liz-mobile/` on the phone.
5. In Liz Mobile settings, validate the API-Football key. Then use **同步本赛季** or the incremental **完整历史** operation.
6. Add it to the phone home screen from the browser share/menu action.

The CSP restricts API connectivity to API-Football and same-origin assets. Production builds do not emit source maps and load no third-party scripts.
