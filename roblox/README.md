# Roblox

Two different things live here, and only one of them changes what other players hear.

| File | What it is | Changes what others hear? |
|---|---|---|
| `RobloxEQ.lua` | Executor/client script: a real mic EQ built from Roblox's `AudioDeviceInput` + `AudioEqualizer` + `AudioFader` + `AudioLimiter` chain, with a draggable panel and presets | **No.** It monitors your mic **locally** |
| `equalizer-apo-mic.txt` | Equalizer APO config for the mic capture device | **Yes**, in Roblox and every other app |

Read the first two sections before expecting the script to boost your voice in a call.

---

## Install from GitHub (one line, works on mobile too)

Paste this into an executor — desktop or Android mobile:

```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/loader.lua"))()
```

`loader.lua` fetches `RobloxEQ.lua` from the repo and falls back to the jsDelivr mirror
(`https://cdn.jsdelivr.net/gh/dantesingh2001-boop/discord-mic-eq@main/roblox/RobloxEQ.lua`)
if raw.githubusercontent is blocked. If you want a direct link instead of the loader:

```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/RobloxEQ.lua"))()
```

GitHub changes **how the script arrives**, not what it can do. Everything earlier in this
document still holds after it loads.

### Roblox mobile, specifically

| Question | Answer |
|---|---|
| Can the panel run on mobile? | Yes, if you have an Android executor. Tap-drag the sliders, the level meter reads your mic |
| Can GitHub replace localhost so mobile voice gets EQ'd? | **No.** Hosting is delivery; the processing has to happen on the device holding the mic |
| Why not? | iOS has no executor at all. Android executors are Luau-only, same as desktop, so they still cannot reach the native voice encoder |
| Could the phone talk to the PC bridge? | It could POST to it over Wi-Fi, but the bridge writes **the PC's** APO config. Your phone's mic never passes through the PC, so nothing changes |

There is no scriptable mic EQ on mobile, from GitHub or anywhere else. To change your voice
for other players you need the chain where the audio is captured: **play Roblox on the PC**
with `equalizer-apo-mic.txt` / VoiceMeeter, or use a headset whose own app (or an OEM sound
panel) offers mic EQ. Root-level Android DSP modules exist (JamesDSP, ViPER) but they target
playback and are not a reliable mic path.

### What GitHub does buy you

* One paste line instead of copying 1300 lines into a console — matters on mobile keyboards.
* Updates without reinstalling: re-run the loader, it pulls the current file.
* The bridge daemon can also live in the repo, so `git pull` keeps both ends in step.

---

## Measured in Roblox Studio, not assumed

Ran against Studio 2026 `Place1` (Play Solo) with `VoiceChatService.UseAudioApi = Enabled`:

| Check | Result |
|---|---|
| `Instance.new` for EQ / Fader / Limiter / Distortion / Compressor / Analyzer / DeviceInput / DeviceOutput / Wire | all creatable |
| `AudioEqualizer.LowGain` | clamps at `-80 .. 10` (setting `99` gives `10`) |
| `AudioEqualizer.MidRange` lower crossover | **clamps to `>= 200 Hz`** — `NumberRange.new(120, 400)` becomes `200 .. 400`, so the SUB band is a sub-200 Hz shelf, not a 60 Hz bell. Crossovers are now written as `200/400` explicitly and the graph's SUB point sits at 100 Hz |
| `AudioFader.Volume` | clamps `0 .. 10` (`-5` becomes `0`), so +20 dB per fader is the hard ceiling |
| `AudioDistortion.Level` | clamps `0 .. 1` |
| `AudioLimiter` | `MaxLevel -12..0`, `Release 0.001..1` accepted |
| `AudioAnalyzer` | pins are `Input` only, **no output pin** — it is a tap, which is how the script wires it |
| `AudioDeviceOutput` | `Volume` **does not exist** (script never touches it); `Input` pin only |
| Full 11-wire chain `mic -> EQ x3 -> Fader x4 -> Distortion -> Compressor -> Limiter -> Output` | engine accepted every wire; `GetConnectedWires` agrees |
| Live build in Play Solo | folder with 3 EQ + 4 faders + limiter + distortion + compressor + analyzer + output, `Fader1.Volume = 1.9953` (+6 dB preset), 11 wires, `MonitorOut` wired 1/1 |
| Panel geometry (measured, not eyeballed) | main `384x548` at `344,36`, right edge 728 of 1072, all 9 rows inside the frame, 9 band columns `36 px` wide spanning `354..710`, **0 clipped labels**, status text needs `334x72` in a `352x78` box |
| `VoiceChatService.UseAudioApi` read from a LocalScript | **fails** (Studio/plugin identity only) — the panel now says so instead of printing a fake `unknown` |
| `screen.Parent = CoreGui` from a LocalScript | **fails** — the panel falls back to `PlayerGui`, so it works in a real client as well as in an executor |

### What Studio could not prove

* **No audible output.** Play Solo never initializes voice chat: no core-created
  `AudioDeviceInput` appears under `LocalPlayer`, `Active` stays `false`, `AudioAnalyzer.RmsLevel`
  stays `0`. The panel reports exactly that instead of pretending. Testing the monitor needs a
  real client with a verified, voice-eligible account in a voice-enabled experience.
* **Transmit EQ.** Engine-side, unchanged by any tooling.

Place `Place1` still contains `StarterPlayerScripts.RobloxEQ` (the exact hosted file) so you can
press Play and see the panel yourself; delete that LocalScript when you are done.

---

## Why a script cannot EQ your Roblox voice chat

Roblox captures and encodes voice in the native engine (RbxAudio → Opus), one device at a
time, straight from the OS input device. By the time any Luau runs, the samples are already
encoded and in flight. There is no mic buffer in Luau, no `getUserMedia`, no Web Audio, and
no API that redirects the transmit encoder through a script-built effect graph.

Executor capabilities don't change that. `hookfunction` / `getrawmetatable` patch *Luau*
functions and Luau C-bindings; the voice pipeline is C++, so there is nothing to hook. The
only mic-related properties exposed to scripts are:

* `AudioDeviceInput.Muted` — writable, kills your transmit (and your monitor)
* `AudioDeviceInput.Active` — **read-only** (`RobloxScriptSecurity`), core scripts own it
* `AudioDeviceInput.Volume` — 0..3, applies to the stream other players get, +9.5 dB max

So the honest ceiling for a script is a mute and a +9.5 dB fader. Not an EQ chain, and not
the +60/+80 dB boost tiers.

---

## What `RobloxEQ.lua` actually does

It builds a real graph out of real engine nodes and plays it to your own output device:

```
AudioDeviceInput
  -> AudioEqualizer x3   (crossovers 200/400, 900/2600, 5500/11000 Hz)
  -> AudioFader x4       (each caps at +20 dB, so 4 = +80 dB total)
  -> AudioDistortion     (soft clip, only when amount > 0)
  -> AudioCompressor     (threshold -12 dB)
  -> AudioLimiter        (MaxLevel -0.5 dB, Release 0.05 s)
  -> AudioDeviceOutput   (your speakers/headphones)

AudioDeviceInput -> AudioAnalyzer   (tap for the live level meter, not in the audio path)
```

That is a genuine EQ: 9 sliders, one per `AudioEqualizer` gain property, so what you drag is
exactly what the engine sees. Measurements are in `test/luau-smoke.mjs` (37 checks):
band gains land on the filter instances, `+20 dB` preamp sums to `20.0 dB` across the faders,
`1k` boost to `60.0 dB`, `10k` to `80.0 dB`, clamps match engine ranges, the mic feeds both the
level tap and the chain, wires appear and disappear as toggles change the chain shape, and
teardown leaves no dangling wires.

### Install

1. Join an experience that allows microphones (Experience Settings → Communication →
   **Enable Microphone**) with `VoiceChatService.UseAudioApi = Enabled`.
2. Paste `RobloxEQ.lua` into your executor and run it.
3. The panel appears top-centre; drag the title bar to move it.

### Controls

| Control | Meaning |
|---|---|
| 9 band sliders | `SUB BASS LO-M MID UP-M PRES BRILL SPRK AIR`, `-24..+10 dB` each |
| PREAMP | `-24..+20 dB`, spread across the four faders |
| BOOST | `OFF 100x 1k 2k 3k 4k 10k` = `0 / +40 / +60 / +66 / +69.5 / +72 / +80 dB` on top of preamp |
| Σ readout | combined gain, amber ≥ +30 dB, red ≥ +60 dB |
| SOFT CLIP | `0..1` `AudioDistortion` amount, `.apo`-style saturation before the limiter |
| CLIP GUARD | keeps `AudioLimiter` in the chain (`MaxLevel -0.5 dB`) |
| MONITOR | wires/unwires `AudioDeviceOutput` |
| MUTE MIC | writes `AudioDeviceInput.Muted` — also silences the monitor |
| preset | ◀ ▶ cycle, `RESET`, or click the name |
| level meter | the thin green bar at the bottom of the graph is live `AudioAnalyzer.RmsLevel` at 30 Hz — if it never moves, there is no mic stream and nothing downstream will help |

Presets: Loud + Clear, Broadcast, Deep Radio, Clarity Max, Warm Bass Voice, Loudest Natty.

### Console API

```lua
RobloxEQ.preset("Broadcast")
RobloxEQ.set("bass", 6)
RobloxEQ.preamp(12)
RobloxEQ.boost("1k")
RobloxEQ.toggle("monitor")
RobloxEQ.status()   --> { graph = true, micCreated = false, wires = 11, state = {...} }
RobloxEQ.destroy()
```

Settings persist to `RobloxEQ.json` in the executor workspace (`writefile`/`readfile`, guarded
with `pcall` so executors without a filesystem just skip it).

### The status panel is the honest part

It reads back the real state instead of assuming: whether the graph built, whether the mic
node is `Active`, what `UseAudioApi` says, how many wires exist, and the measured input level in
`dBFS` from the analyzer tap. If the mic is inactive it
says so — the monitor is silent then, and no amount of gain will fix it. Expect that in most
games: `AudioDeviceInput.Active` is set by Roblox core scripts only.

### Limits, stated plainly

* **Local monitor only.** Other players get the OS mic device, unprocessed.
* Needs the experience's mic permission + `UseAudioApi`; without them there is no stream.
* 3 shelf bands per `AudioEqualizer`, not parametric biquads, so the curve is a series of
  shelves rather than the browser extension's `BiquadFilterNode` response. The graph widget
  interpolates between band centres, so it approximates the shape.
* Per-band gain caps at `+10 dB` and preamp at `+20 dB` per fader — that is why boost needs
  four faders instead of one.
* `+80 dB` on a mic is unusable on most setups. The limiter stops clipping, not the noise
  floor. Use boost tiers as an effect, not a default.
* Executors violate the Roblox ToS and many are hostile. Nothing here needs the injection
  beyond the UI: the audible-result route is the APO config below.

---

## The route that actually reaches other players

Roblox records from the OS input device, so process the mic before Roblox ever opens it.

### Equalizer APO (parametric EQ + preamp)

1. Install **Equalizer APO**, run **Configurator**, tick your **microphone**, reboot.
2. Open `C:\Program Files\EqualizerAPO\config\config.txt` and paste
   [`equalizer-apo-mic.txt`](equalizer-apo-mic.txt).
3. Fix the `Device:` line to your mic's exact name (the Configurator lists it).
4. Roblox → Settings → Voice & Video → input device = that mic.

The file carries the `Loud + Clear` curve and documents the other presets as `Filter:` lines
so you can swap them in. It cannot do the boost tiers or the tanh soft clip — see below.

### VoiceMeeter (adds the clip guard / boost)

`Mic → VoiceMeeter strip (EQ, compressor, gate, gain) → B1 → VB-Audio Virtual Cable`, then
pick **VB-Audio Virtual Cable** as Roblox's input. This is the only route that reproduces the
`100x`…`10k` behaviour, because a real audio engine does the saturation.

### Chain both

Equalizer APO on the mic *and* VoiceMeeter after it gives you the parametric graph plus the
boost/limiter — the closest thing to the browser extension that Roblox will accept.

---

## Tests

```
node test/luau-smoke.mjs      # or: npm run test:luau
```

Runs `RobloxEQ.lua` under Lua 5.3 (fengari) against Roblox API stubs in `test/stubs.lua`,
then asserts on the resulting instance graph and gain math. It checks what a Lua-only harness
can check: node creation (3 EQ, 4 faders, limiter, distortion, analyzer, output), wire topology,
preset application, dB accounting across chained faders, clamping, toggle rewiring, the level
tap, and teardown. It cannot check whether the engine produces sound — `AudioDeviceInput`
`Active` state and actual monitoring need a real client.
