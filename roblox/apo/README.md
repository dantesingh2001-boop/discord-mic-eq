# Equalizer APO presets — the route that actually reaches other players

Six ready-to-paste configs, one per preset in `roblox/RobloxEQ.lua`, with the same gains. This is
the half of the project that changes what **other people hear**, because it runs *below* Roblox.

## How Equalizer APO does it (and why a script can't be a hook)

Equalizer APO is a Windows **APO** — an Audio Processing Object. That is a COM DLL the Windows audio
engine loads **inside the capture graph of the device**, on the OS side of the WASAPI boundary:

```
mic -> audiodg.exe capture graph [ APO chain: Equalizer APO ] -> WASAPI -> Roblox -> Opus -> other players
```

* It is registered per endpoint by an admin installer: `FX\...` properties on the capture endpoint's
  registry key plus the DLL, so `audiodg.exe` (the audio device graph process) loads it whenever that
  endpoint goes active — for **every** app that opens the mic in shared mode, not just Roblox.
* It never enters Roblox's process. Roblox asks the OS for samples and receives PCM that has
  *already* been filtered. That is exactly why other players hear it, and why Discord, OBS and Teams
  get it too.
* Its editor writes `config.txt` (`Preamp:` / `Filter:` lines) and the driver turns each line into a
  biquad and applies it per buffer. There is no per-app injection anywhere in that chain.

So yes, the thing you were reaching for *is* a hook — it just lives in the OS audio stack rather than
in the executor:

| Where the code sits | Possible? | What it means |
|---|---|---|
| Luau inside an executor | No | no samples exist in Lua; capture and Opus encoding are native and run first |
| Native DLL injected into Roblox (vtable-hook `IAudioCaptureClient::GetBuffer` or the encoder state) | technically yes | requires native code injection into a Hyperion/Byfron-protected process — that is anti-cheat tampering, not audio work. This repo does not do it and I will not build it |
| **Windows APO (this folder)** | **yes** | the supported mechanism: registered per endpoint, loaded by the OS, works for all apps |
| Virtual audio device (VB-Cable, Voicemeeter, MicUp) | yes | an app applies the DSP, the app-side device passes it on |

The last two rows are the only ones an end user can actually install, and they give the same audible
result: what leaves your machine is already processed.

## The six configs

| File | Preset | Preamp | Character |
|---|---|---|---|
| `loud-and-clear.txt` | Loud + Clear | +6 dB | the default: bright, small low-mid cut, presence lift |
| `broadcast.txt` | Broadcast | +8 dB | close-mic radio: thin low end, strong presence |
| `deep-radio.txt` | Deep Radio | +5 dB | warm and thick, rolled-off top |
| `clarity-max.txt` | Clarity Max | +4 dB | maximum intelligibility, thin bass |
| `warm-bass-voice.txt` | Warm Bass Voice | +7 dB | big low end, dark top |
| `loudest-natty.txt` | Loudest Natty | +10 dB | loudest of the six, mild saturation in the script version |

## Install

1. Install [Equalizer APO](https://sourceforge.net/projects/equalizerapo/), run **Configurator**, tick
   your **microphone** capture device, reboot.
2. Copy the preset you want to `C:\Program Files\EqualizerAPO\config\config.txt`.
3. Edit the `Device:` line to your mic's exact name — Configurator lists device names verbatim. A
   non-matching name means the config is *skipped*, it never lands on your speakers.
4. Roblox → Settings → Voice & Video → **Microphone** = that device.
5. Nothing else runs. The driver does the work whether Roblox is open or not.

## Verify it is really in the path

Record 10 seconds in Windows **Voice Recorder** with `clarity-max.txt` installed. If the recording is
obviously bright and thin, the APO is inline for the whole endpoint — and Roblox is just another app
on that endpoint. Then get one other player to confirm in-game; your own monitor proves nothing.

## The boost tiers need a real engine

APO cannot do the script's `100x`…`10k` tiers (+40…+80 dB) or the tanh soft clip — those are a
saturating gain stage, not a filter. For that: `Mic → VoiceMeeter strip (gate, EQ, comp, gain) →
B1 → VB-Audio Virtual Cable`, and pick **VB-Audio Virtual Cable** as Roblox's mic. Chain both
(APO on the real mic, VoiceMeeter after it) for the closest match to the browser extension.

## Android / iOS

No APO equivalent exists. Use the virtual-mic app route in [`../mobile.md`](../mobile.md): MicUp
(software loopback or Shizuku) on Android, hardware with onboard DSP on iOS.
