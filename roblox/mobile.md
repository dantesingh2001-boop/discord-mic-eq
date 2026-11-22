# EQ on a phone — what actually works

The script in this folder cannot EQ your transmit voice on mobile. Not because of a missing
feature — Roblox hands the Opus encoder whatever the OS gives it, and a Luau script runs after
that point. So the EQ has to happen **before the OS hands the mic to Roblox**. That is possible,
it just isn't a Roblox script. This page is the ladder of things that actually do it.

## The panel on a phone

`RobloxEQ.lua` runs on Android executors too, and v1.1 makes it fit: the panel scales to the
viewport, re-fits when the device rotates, is clamped to the screen while you drag it, tracks your
finger 1:1 under `UIScale`, collapses to its title bar with `–`, and sizes its status box from the
lines it actually prints. The level meter is live if the experience has opened your mic.

One thing that does work identically on a phone: **RX OTHERS** (or `RobloxEQ.rx(true)`) wires every
other player's incoming voice through a second copy of the same EQ chain into your speakers. It is
the receive side, so it changes what you hear of them, not what they hear of you - but it is a real
engine filter chain on real networked voice, on an Android executor, with no root and no PC.

What it still cannot do on a phone is change what other players hear. The `XFER` slider writes
`AudioDeviceInput.Volume` (the only stream gain a script has, up to +9.5 dB); it is set on the
client, so expect it to be best effort. For a real transmit EQ use the routes below.

## The verdict, per platform

| Where you play | Can your transmit voice be EQ'd? | How |
| --- | --- | --- |
| Windows PC | Yes, fully | This repo: `eq-bridge.mjs` → Equalizer APO. Best quality, real filters. |
| **Android (no root)** | **Yes — virtual mic app** | [MicUp](https://github.com/papergray/MicUp) software loopback / Shizuku tier |
| Android (root) | Yes | MicUp Magisk tier, or [Echidna](https://github.com/supermarsx/echidna) (experimental, read its warning) |
| Android + USB mic/earbuds | Yes, hardware DSP | Mic's own onboard EQ, processed before the phone sees it |
| **iOS** | **No software path at all** | Hardware only: USB-C earbuds/mic with onboard DSP |
| Any phone, no hardware, no root | No | Nothing in the app stores can do it — see below |

Why app stores can't help: Android and iOS sandbox apps away from each other's audio. Only an OS
component (or something installed as root) can present a *virtual* input device that another app
then records. On iOS that component requires a jailbreak; there is no App Store route.

---

## Android route 1 — MicUp (start here)

MicUp is an open-source (MIT) Android app that captures your mic, runs a DSP chain over it, and
feeds the result back as the microphone other apps record from. It ships a **10-band EQ**, noise
gate, compressor and reverb — the same tools as this repo's panel, on the phone itself.

It has four routing tiers, weakest first:

1. **VoIP stream** — no root, no ADB. Works for apps that let you *pick* an input. Roblox does not
   let you pick, so this tier alone usually cannot reach Roblox. Try it anyway; it costs nothing.
2. **Software loopback** (v1.0.5+) — no kernel module, no ALSA, no root. This is the tier most
   likely to work on a stock phone because it replaces the stream behind the system mic.
3. **Shizuku** — no root, but needs ADB-level access via wireless debugging (Android 11+).
   Most reliable non-root option.
4. **Magisk / root** — full ALSA-level replacement. Most reliable overall.

**Steps**

1. Install **Shizuku** from the Play Store, then start it via *Wireless debugging* (Developer
   options → Wireless debugging → pair). You do not need a PC.
2. Install the MicUp APK from its [releases page](https://github.com/papergray/MicUp/releases)
   (signed, not on the Play Store).
3. Open MicUp → grant microphone permission → Settings → **Shizuku → Grant**.
4. Settings → routing tier → try **Software loopback** first, then **Shizuku** if it's silent.
   MicUp tells you why a tier is unavailable instead of failing silently.
5. Turn the gate/compressor on, set the EQ using the tables below, leave **"hear yourself"** off
   unless you're on headphones.
6. Launch Roblox, join a voice-enabled experience, and have another player confirm. Testing alone
   proves nothing — your own monitor is a different audio path.

Known rough edges: device/input selection has been buggy on some phones
([issue #5](https://github.com/papergray/MicUp/issues/5)), and the maintainer is rebuilding that
part. If a tier routes to your earpiece instead of into the game, that's this bug, not your setup.

## Android route 2 — root

* **MicUp Magisk tier** — same app, full routing.
* **Echidna** — Zygisk + LSPosed module that hooks the capture path inside the target app. Its own
  docs say it is likely not to work on many phones and that a bad module can bootloop the device.
  Only touch it if you can recover from a broken Magisk module without the normal UI.

## iOS

There is no equivalent: no virtual mic, no Shizuku, no capture hook short of a jailbreak. The only
route is hardware.

## Hardware route (works on iOS and Android)

The EQ has to live inside a device that sits between your mouth and the phone:

* **Voice-changer earbuds / USB-C headsets with a companion app.** The DSP runs in the earbud or its
  dongle and returns processed audio over USB-C, which the OS then treats as a normal mic. No root,
  no PC, no jailbreak. Vendors market these specifically for Roblox mobile.
* **A USB mic with onboard DSP** (RØDE NT-USB+, PodMic USB, XDM-100 and friends) plugged in via OTG.
  RØDE's own compatibility table lists Android support; behaviour "may vary by app".
* **A small mixer / interface with channel EQ** between mic and phone. Bulkiest, but every knob is
  a real filter.

## Translating the six presets

Band centres here: 100 / 300 / 600 / 1500 / 3500 / 7000 / 13000 / 17000 / 20000 Hz.
MicUp's 10-band EQ uses standard centres, so each of these is the same curve re-sampled onto
31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz.

**Loud + Clear** — preamp +6
`31:0  62:+0.6  125:+1.4  250:+2.9  500:+2.5  1k:+0.9  2k:+1.0  4k:+2.4  8k:+4.5  16k:+4.8`

**Broadcast** — preamp +8
`31:0  62:-1.9  125:-4.1  250:-1.5  500:+0.2  1k:+1.5  2k:+2.5  4k:+4.2  8k:+5.0  16k:+3.0`

**Deep Radio** — preamp +5
`31:0  62:+1.9  125:+4.1  250:+3.7  500:+2.8  1k:+0.5  2k:-0.2  4k:-0.6  8k:+1.5  16k:+2.3`

**Clarity Max** — preamp +4
`31:0  62:-2.9  125:-6.1  250:-2.9  500:-0.3  1k:+1.9  2k:+3.7  4k:+7.2  8k:+8.9  16k:+9.5`

**Warm Bass Voice** — preamp +7
`31:0  62:+2.5  125:+5.5  250:+5.2  500:+4.8  1k:+1.5  2k:+0.4  4k:-1.2  8k:-3.8  16k:-9.8`

**Loudest Natty** — preamp +10, plus the +1k boost tier from the desktop script
`31:0  62:+1.0  125:+2.0  250:+3.7  500:+2.8  1k:+0.9  2k:+1.0  4k:+2.4  8k:+4.5  16k:+4.8`

Values above +8 dB: pull the preamp down before boosting the band, or you clip before the encoder.
The desktop script has a limiter for this; MicUp's compressor is the equivalent.

## What the phone route still cannot do

* Roblox's own voice pipeline applies Agora noise suppression and its own Opus bitrate. Heavy
  filtering survives; a +12 dB shelf mostly turns into artifacts.
* Nothing here boosts your loudness into the "boost tiers" (100x / 1k … 10k) from the desktop
  script. Those are input-gain multipliers above unity; MicUp caps at normal gain, so loudness
  comes from the compressor instead.
* There is no level meter wired to Roblox. MicUp's VU meters show *your* chain, not what players
  receive.
