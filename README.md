# Discord Mic EQ

Preamp boost + full parametric EQ + clip guard on your microphone, applied to the stream
Discord (web) receives. Browser-side replacement for Equalizer APO's mic chain.

## What it actually does

Chrome extensions can't touch Discord's audio from outside. This one goes *inside* the page:

```
content script (MAIN world, document_start)
  -> wraps navigator.mediaDevices.getUserMedia
  -> raw mic -> preamp gain -> N biquads -> soft clip -> look-ahead-ish limiter
  -> MediaStreamAudioDestinationNode stream -> handed back to Discord
```

Discord believes it's the normal microphone. Everything downstream (Opus, WebRTC) sends the
processed audio. The returned track is disguised (`getSettings`, `applyConstraints`, `label`,
`stop`) so Discord's device handling keeps working.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `~/projects/discord-mic-eq/extension`
4. Open `https://discord.com/app`, join a call, then talk. The popup shows live state.

## Settings

| Control | Meaning |
|---|---|
| Preamp | Gain into the chain, `-24..+24 dB`. This is your "loud". |
| Boost | Hostile-gain tiers: `off`, `100x`, `1k`, `2k` … `10k` (+40 to +80 dB), multiplied on top of preamp. This is the "1000x module" behaviour. |
| Clip guard | Limiter after the EQ, so +24 dB doesn't turn your voice into a square wave. |
| Soft clip | Tanh saturation before the limiter, gentler than digital clipping. Above `1k` boost it *is* the ceiling: the curve saturates at 0.85 FS so the 4x-oversampled output never exceeds 0 dBFS. |
| Kill browser AGC | Forces `autoGainControl: false` on the mic constraint. **Leave on** — Chrome's AGC otherwise pumps your level back down and fights the preamp. |
| Filterless mic | Forces `noiseSuppression: false`, `echoCancellation: false`, `autoGainControl: false` — raw full-band capture, like the "filterless" Discord voice modules. Only use on headphones; speakers will echo. |

Presets: Loud + Clear (default), Broadcast, Deep Radio, Clarity Max, Warm Bass Voice.
Graph: drag a dot to move frequency/gain, wheel-free Q editing in the band row, double-click
the graph to add a band, `×` to remove.

## Measured, not assumed

`node test/run.mjs` runs two suites against real Chrome audio:

- **79 response checks** (+ boost-tier peak/RMS checks): every filter type rendered through `OfflineAudioContext`, measured by
  RMS against the analytic curve, tolerance 0.35 dB.
- **Live capture test**: loads the extension, uses Chrome's fake mic device, verifies the
  `getUserMedia` hook is installed, that +6 dB preamp shows up as +6 dB in the *captured*
  stream, and that a 2 kHz high-pass kills a 440 Hz tone by ~27 dB.

Current state: all checks pass (79 response checks + boost tiers + live capture + filterless constraints).

Boost tiers are measured, not guessed: `1k` runs a -28 dBFS fake mic up to **-1.9 dBFS RMS**
with true peak capped at/below 0 dBFS, so it is loud without inter-sample crackle.

### On the "1000x filterless" modules

I checked the binaries. `Downloads/YOO/x1000 filterless modules new/discord_voice.node` is
**byte-identical to stock Discord 1.0.9268** (md5 `becdd10d…`), so there are no gain values in it to
copy. The only edits in that folder are in `index.js` (feature flags). The separate
`24x filterless modules new` binary is patched at exactly one site — `add eax, 0x3e8` instead of
`add eax, 0x18` — i.e. a hard-coded integer bump, not an EQ curve. The extension therefore
reproduces the *effect* (huge gain, saturate to full scale, filters off) rather than any literal
constant from those modules.

Two real bugs this caught:
- Chrome's `BiquadFilterNode` takes **Q in dB** for `lowpass`/`highpass` and linear elsewhere.
- Analytic magnitude needs the filter's own cutoff `w0`, not the evaluation frequency.

## Limits (read before asking why it doesn't work)

- **Discord web only.** Discord desktop app is Electron and ignores Chrome extensions.
- **Not Roblox.** No browser player.
- The +24 dB path raises your noise floor with your voice. That's physics, not a bug; the
  clip guard protects against overload, not hiss.
- Discord's own noise suppression still runs. If your voice sounds gated, disable it in
  Discord's voice settings and rely on the EQ.
- `.apo` config import is not implemented yet — the band model matches APO's `Filter:` lines,
  so the parser is a small standalone job.

---

# BetterDiscord plugin (`betterdiscord/MicEQ.plugin.js`)

Separate deliverable from the extension — same DSP core, but it hooks the **Discord desktop client**
(Electron renderer), so it covers the app you actually use. One self-contained file, no manifest.

## Install

1. Put `MicEQ.plugin.js` in `%AppData%\BetterDiscord\plugins`
2. Discord → Settings → BetterDiscord → Plugins → enable **MicEQ**
3. Open the plugin's settings panel (gear) for preamp, **boost tier**, presets, bands, filterless
4. **Leave and rejoin the voice channel** (or flip the input device) so Discord asks for the mic
   again — the hook applies to new `getUserMedia` calls, not to a stream already open.
   Preamp/boost/EQ are live; **filterless** changes mic constraints, so it needs the rejoin.

Verify in Discord → Voice & Video → **Mic Test**: you should hear the boosted/EQ'd voice.

## Controls

| Control | Meaning |
|---|---|
| Preamp | `-24..+24 dB` into the chain |
| Boost | `off`, `100x`, `1k`, `2k` … `10k` (+40 to +80 dB), multiplied on top of preamp — the "1000x module" behaviour |
| total | Combined preamp + boost gain; turns red at ≥60 dB |
| Clip guard / Soft clip | Same as the extension: tanh saturation owns the ceiling above 1k, limiter guards the flat path |
| Filterless mic | `noiseSuppression:false`, `echoCancellation:false`, `autoGainControl:false` — raw full-band capture. Headphones only |

## What's verified

`node test/run.mjs` also covers the plugin:

- hook installed, `stop()` restores the original `getUserMedia`
- +6 dB preamp lands as **+6.1 dB** on the captured stream
- 2 kHz high-pass kills a 440 Hz tone by **-26.5 dB**
- **1k boost** raises the fake mic from -27.7 dBFS to **-1.9 dBFS RMS**, peaks still ≤ 0 dBFS
- **filterless** reaches the real device: `echoCancellation/noiseSuppression/autoGainControl` all false
- the returned track keeps the real device label, so Discord's picker looks normal
- `getSettingsPanel()` survives a missing `BdApi.React` instead of exploding

`node panel-shot.mjs` renders the settings panel with real React 18 (screenshotted + inspected):
preamp row right-aligned, boost dropdown + total readout, five toggles, six band rows in clean
columns, graph curve drawn, nothing clipped.

## Not verified

- I have no Discord desktop client here, so the plugin has not been loaded by real BetterDiscord.
  The interception mechanism, the audio math and the React panel are each proven; the one unknown
  is BD's loader quirks on your version.
- AudioContext starts suspended in Electron until real input — the plugin resumes it on any
  click/keypress and on stream creation. If your mic is silent right after enabling, click once in
  the Discord window.

---

# Kettu / Bunny / Vendetta plugin (`kettu/`)

Separate deliverable for **Discord mobile** (`kettu/manifest.json` + `kettu/index.js`). Nothing here
is shared with the extension or the BetterDiscord plugin.

Mobile Discord has no Web Audio: voice is captured and encoded in native WebRTC code, so a JS plugin
cannot run biquads or a 1k gain stage. What a plugin *can* do is find the native voice setters through
Metro and drive them — so this one does the honest half:

- **filterless**: `setNoiseSuppression(false)`, `setEchoCancellation(false)`, `setAutomaticGainControl(false)`
- **boost tiers**: the tier value is handed to `setInputVolume` / `setMicVolume` (builds usually clamp it)
- **diagnostics**: lists which setters your build exposes, re-probes, and says "cannot change anything"
  when none match instead of pretending

### Hosting on GitHub

`node kettu/build-pages.mjs` generates a Pages-ready `docs/` tree (`repo.json`, `builds/miceq.mobile/`,
and `kettu/`). Enable **Settings → Pages → main / docs**, then either paste
`https://<user>.github.io/<repo>/kettu/` into Kettu's `+` button, or add
`https://<user>.github.io/<repo>/` as a plugin repository. Re-run the script after editing
`index.js`; `npm run test:kettu` fails if `docs/` drifts or hashes/versions disagree.

GitHub only hosts the Kettu plugin for install — the extension is loaded unpacked by Chrome and the
BetterDiscord file has to sit in `%AppData%\BetterDiscord\plugins`, so those are source backups
only, not URL installs. See `kettu/README.md`.
