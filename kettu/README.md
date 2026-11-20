# MicEQ Mobile — Kettu plugin

Separate deliverable from the browser extension and the BetterDiscord plugin. Same "loud mic"
goal, but Kettu runs in Discord mobile's **React Native** runtime, where there is no Web Audio.

## What it can actually do

| Piece | Extension / BetterDiscord | This Kettu plugin |
|---|---|---|
| Biquad EQ (drag curve, presets) | yes, Web Audio | **no — impossible in JS on mobile** |
| Tanh saturator + limiter ceiling | yes | no |
| Filterless (NS / AEC / AGC off) | yes, via mic constraints | **yes — via native voice setters, if your build exposes them** |
| Boost tiers 1k…10k | yes, real gain stage | **handed to the native input-volume setter; most builds clamp it** |

Discord mobile captures and encodes voice in native WebRTC code. A plugin never sees the PCM
buffer, so it cannot insert a filter chain or a 1k gain stage. For real mobile gain you'd need a
native/Xposed module (KettuXposed) or a patched APK — a different project.

## Install

### Option A — GitHub Pages (works, permanent)

Kettu fetches over HTTPS from any static host, so Pages is fine. The repo already contains a
Pages-ready `docs/` tree; regenerate it whenever `index.js` changes:

```bash
node kettu/build-pages.mjs
```

Then push and enable Pages: **Settings → Pages → Source: Deploy from a branch → Branch: main,
folder: /docs**. Private repos need a paid plan for Pages; a public repo works on the free tier.

You get two ways to install from the same site:

- **Direct URL** — Kettu → Settings → Plugins → `+` → paste
  `https://<user>.github.io/<repo>/kettu/`
- **Plugin repo** — add `https://<user>.github.io/<repo>/` as a repository; Kettu reads
  `repo.json` and shows *MicEQ Mobile* in the browser under `builds/miceq.mobile/`

The trailing slash matters: Kettu resolves `manifest.json`, `index.js` and `repo.json` relative to
the URL you give it.

### Option B — local HTTP server

```bash
cd Projects/discord-mic-eq/kettu
python -m http.server 8099
```

Paste `http://<your-pc-lan-ip>:8099/` on the phone. Keep the server running.

### Updating

- Direct URL: Kettu only refetches JS when `manifest.hash` changes, so re-run `build-pages.mjs`
  after editing `index.js` (it recomputes the hash).
- Plugin repo: bump `VERSION` in `build-pages.mjs`; Kettu compares versions in `repo.json`.

`npm run test:kettu` fails if `docs/` is stale or the hashes/versions disagree.

After installing, enable it and open its settings. The **Diagnostics** block is the honest part:

- `voice modules found: 0` → your build hides the setters; nothing can change, and the plugin
  says so instead of silently doing nothing.
- Setters listed → filterless and the boost tier are being applied every 4 s, because Discord
  creates a new voice engine per call.

Leave and rejoin a voice channel after enabling so the engine is recreated with the new values.

## Verified (what can be tested here)

`node test/kettu-plugin.mjs` loads the file exactly like Kettu does (`vendetta => { return <file> }`)
with a stubbed Metro registry:

- manifest hash matches `index.js`
- load turns NS / AEC / AGC off through the setters
- boost tier is passed to `setInputVolume`
- duplicate module matches apply once
- no matching module → zero calls, no throw
- unload restores NS / AEC / AGC and resets input volume to 1
- settings component returns null instead of exploding when Metro React is missing

Not verifiable here: whether your Discord build exposes those setters at all, and whether it clamps
input volume above 1.0. The Diagnostics block answers both on-device.
