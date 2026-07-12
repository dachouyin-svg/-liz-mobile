# Liz Mobile 6.1 — 手机静态版

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
- The `6.1.0-rc.2` Validation Center runs in a Web Worker and never calls the provider API. It performs strict walk-forward PIT backtests on phone-local history, compares Independent/Liz6.0/Liz6.1, evaluates release gates, and exports an aggregate hash-addressed report with no API key, raw response, fixture row, or team detail.
- G10 is fail-closed and remains **BLOCKED** until a trusted 2023–2024, 456-match historical-odds archive satisfies both-market 95% coverage, bookmaker identity, pre-kickoff observation time, closing-line, de-vig, and out-of-sample requirements. No report can recommend promotion while G10 is blocked.
- Every newly generated prediction includes deterministic Chinese analysis based on both Liz6.0 Frozen and Liz6.1 MAIN. A research direction appears only when both versions independently clear the five-point edge and 3% EV gates. Cross-bookmaker median odds are explicitly non-actionable references, stored signals expire after ten minutes or at kickoff, and no executable stake is produced before G10 and formal validation pass.
- Match cards expand on demand to load current squad data. Player positions and all UI labels are Chinese. API-Football does not provide a reliable market-value field, so player value is shown as unavailable rather than estimated. The Liz6.1 match-strength index is a transparent expected-points share for that fixture, not a player valuation or a universal club rating.

The GitHub Pages shell is publicly reachable. The API key and phone-local data are not published to GitHub. Do not paste the API key into source code, issues, chat, screenshots, build variables, or Actions secrets.

## Local verification

```sh
npm ci
npm run check
```

`npm run check` runs the contract, parity, validation, and release-boundary tests plus a production TypeScript/Vite build.

## K1 release-candidate validation

1. Connect API-Football on the phone and run **完整历史** for K1.
2. Open **验证** and run **正式版验证**. The calculation stays in the Web Worker and can be cancelled safely.
3. Review API identity/season coverage, score completeness, unknown rounds, 300-match walk-forward sample, GLM convergence, PIT leakage, lambda gates, log loss, Brier, calibration ECE, and the G10 historical-odds blocker.
4. Export the `liz-validation-report-v2` JSON. With no trusted historical-odds input, the report must remain `BLOCKED`/`HOLD`; it never changes the K1 state automatically.

The report is invalidated after a new sync and must be rerun against the updated dataset.

## GitHub Pages deployment

The repository is `dachouyin-svg/-liz-mobile`; Vite therefore uses the base path `/-liz-mobile/`.

1. Push this directory to the `main` branch of `dachouyin-svg/-liz-mobile`.
2. In repository **Settings → Pages**, choose **GitHub Actions** as the source.
3. Run the included **Deploy GitHub Pages** workflow or push to `main`.
4. Open `https://dachouyin-svg.github.io/-liz-mobile/` on the phone.
5. In Liz Mobile settings, validate the API-Football key. Then use **同步本赛季** or the incremental **完整历史** operation.
6. Tap a fixture to view squad information and the Liz6.1 match-strength index. Generate a prediction to receive the Liz6.0/Liz6.1 comparison, Chinese analysis, and either a non-actionable research signal or a no-bet result.
7. Add it to the phone home screen from the browser share/menu action.

The CSP restricts API connectivity to API-Football and same-origin assets. Production builds do not emit source maps and load no third-party scripts.
