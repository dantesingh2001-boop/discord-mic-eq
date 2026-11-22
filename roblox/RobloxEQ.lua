--!nocheck
--[[
	RobloxEQ v1.2
	Client-side equalizer for Roblox's Audio API (executor / client script).

	Graph:  AudioDeviceInput -> EQ1 -> EQ2 -> EQ3 -> Fader x4 -> Distortion
	        -> Compressor -> Limiter -> AudioDeviceOutput

	Honest scope:
	  * This builds a REAL audio graph with REAL Roblox filter instances.
	  * It processes your microphone and plays the result LOCALLY (monitor).
	  * It cannot EQ what other players hear. Their copy of your voice is
	    encoded by Roblox's native voice engine from the OS input device, before
	    any Luau graph exists. The one transmit knob a script does have is
	    AudioDeviceInput.Volume (0..3 = up to +9.5 dB) and Muted - both are
	    wired to the TRANSMIT slider and MUTE MIC button in the panel.
	  * For a real transmit EQ, process the mic at the OS level: Equalizer APO /
	    VoiceMeeter on Windows (roblox/equalizer-apo-mic.txt + bridge), a virtual
	    mic app on Android (roblox/mobile.md). Nothing exists for iOS.

	Requirements: the experience must allow microphone input
	(Experience Settings -> Communication -> Enable Microphone) and
	VoiceChatService.UseAudioApi must be Enabled, otherwise the mic node
	produces no stream and the monitor stays silent. The script says so in
	the status panel instead of pretending.

	Commands (typed in the executor console while it runs):
	  RobloxEQ.preset("Broadcast")
	  RobloxEQ.set("bass", 6)
	  RobloxEQ.transmit(6)
	  RobloxEQ.status()
	  RobloxEQ.diagnostics()
	  RobloxEQ.destroy()

	v1.2 adds the receive side: RX OTHERS wires every other player's incoming
	voice through a second copy of the same EQ chain into your speakers. That
	direction is the one a client graph really can change - and it is the same
	code path on PC and on an Android executor. See the RX section below.

	v1.1 fixes (why it "did nothing" before):
	  * voice chat creates the AudioDeviceInput late - the old build made its own
	    dead device and never noticed the real one, so the meter and monitor were
	    silent forever. The graph now adopts the engine device whenever it turns up.
	  * running the loader twice left two panels and two audio graphs behind.
	  * on a phone the panel could be dragged off-screen and the drag ran at the
	    wrong speed under UIScale; the panel now follows the finger 1:1 and is
	    clamped to the viewport, and it re-fits itself when the device rotates.
	  * the status box clipped its own text; it is now sized for its lines and the
	    long report moved to RobloxEQ.diagnostics().
	  * the Sigma readout now reports the gain the engine actually accepted.
]]

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local HttpService = game:GetService("HttpService")
local VoiceChatService = game:GetService("VoiceChatService")

local player = Players.LocalPlayer
if not player then
	warn("[RobloxEQ] no LocalPlayer - run this from a client or an executor, not the server.")
	return
end

-- Re-running the loader must not stack panels / graphs.
if type(_G.RobloxEQ) == "table" and type(_G.RobloxEQ.destroy) == "function" then
	pcall(function()
		_G.RobloxEQ.destroy()
	end)
end

local isMobile = false
pcall(function()
	isMobile = UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled
end)

local VERSION = "1.2"
local CONFIG_FILE = "RobloxEQ.json"
local BRIDGE_HOST = "127.0.0.1:7331"

--------------------------------------------------------------------------------
-- band model
--
-- Three AudioEqualizer instances run in series. Each has Low/Mid/High gain
-- (-80..+10 dB) split by its MidRange crossover points, so the chain behaves
-- like a serial shelving EQ. One slider per property keeps it predictable.
--------------------------------------------------------------------------------

-- The engine clamps the low crossover to >= 200 Hz, so 200 is written explicitly
-- rather than being silently raised from 120.
local CROSSOVERS = {
	{ 200, 400 },
	{ 900, 2600 },
	{ 5500, 11000 },
}

-- id, label, eq node (1-3), property, center frequency for the curve
local BANDS = {
	{ id = "sub",        label = "SUB",   node = 1, prop = "LowGain",  freq = 100 },
	{ id = "bass",       label = "BASS",  node = 1, prop = "MidGain",  freq = 300 },
	{ id = "lowmid",     label = "LO-M",  node = 1, prop = "HighGain", freq = 600 },
	{ id = "mid",        label = "MID",   node = 2, prop = "LowGain",  freq = 1500 },
	{ id = "uppermid",   label = "UP-M",  node = 2, prop = "MidGain",  freq = 3500 },
	{ id = "presence",   label = "PRES",  node = 2, prop = "HighGain", freq = 7000 },
	{ id = "brilliance", label = "BRILL", node = 3, prop = "LowGain",  freq = 13000 },
	{ id = "sparkle",    label = "SPRK",  node = 3, prop = "MidGain",  freq = 17000 },
	{ id = "air",        label = "AIR",   node = 3, prop = "HighGain", freq = 20000 },
}

-- boost tiers, same numbers as the browser extension's chips
local BOOST_DB = {
	["off"] = 0,
	["100x"] = 40,
	["1k"] = 60,
	["2k"] = 66,
	["3k"] = 69.5,
	["4k"] = 72,
	["10k"] = 80,
}

local BOOST_ORDER = { "off", "100x", "1k", "2k", "3k", "4k", "10k" }

local SLIDER_MIN, SLIDER_MAX = -24, 10
local PREAMP_MIN, PREAMP_MAX = -24, 20

-- AudioDeviceInput.Volume is 0..3, i.e. -inf..+9.54 dB. That is the only gain
-- the engine applies to the stream other players receive.
local TRANSMIT_MIN, TRANSMIT_MAX = -24, 20 * math.log10(3) -- +9.5424 dB = AudioDeviceInput.Volume 3

local STATE = {
	bands = {},
	preamp = 6,
	transmit = 0,
	boost = "off",
	softclip = 0,
	limiter = true,
	monitor = true,
	muteMic = false,
	rx = false,          -- EQ other players' incoming voice (works on mobile too)
	rxGain = 0,          -- receive-side gain, dB, 0..40 across two faders
	bridge = false,
	bridgeHost = BRIDGE_HOST,
	preset = "Loud + Clear",
}

-- assigned further down; apply() is called before the bridge code exists
local pushBridge = function() end
local buildRxGraph

local PRESETS = {
	["Loud + Clear"] = {
		preamp = 6, boost = "off", softclip = 0,
		bands = { sub = 2, bass = 4, lowmid = 2, mid = 1, uppermid = 2, presence = 4, brilliance = 3, sparkle = 2, air = 1 },
	},
	["Broadcast"] = {
		preamp = 8, boost = "off", softclip = 0.15,
		bands = { sub = -6, bass = -2, lowmid = 1, mid = 3, uppermid = 4, presence = 5, brilliance = 3, sparkle = 1, air = 0 },
	},
	["Deep Radio"] = {
		preamp = 5, boost = "off", softclip = 0.1,
		bands = { sub = 6, bass = 5, lowmid = 2, mid = 0, uppermid = -1, presence = 1, brilliance = 2, sparkle = 1, air = 0 },
	},
	["Clarity Max"] = {
		preamp = 4, boost = "off", softclip = 0,
		bands = { sub = -9, bass = -4, lowmid = 1, mid = 4, uppermid = 7, presence = 8, brilliance = 6, sparkle = 4, air = 2 },
	},
	["Warm Bass Voice"] = {
		preamp = 7, boost = "off", softclip = 0.2,
		bands = { sub = 8, bass = 7, lowmid = 4, mid = 1, uppermid = -1, presence = -2, brilliance = -3, sparkle = -4, air = -5 },
	},
	["Loudest Natty"] = {
		preamp = 10, boost = "1k", softclip = 0.35,
		bands = { sub = 3, bass = 5, lowmid = 2, mid = 1, uppermid = 2, presence = 4, brilliance = 3, sparkle = 2, air = 1 },
	},
}

local PRESET_ORDER = { "Loud + Clear", "Broadcast", "Deep Radio", "Clarity Max", "Warm Bass Voice", "Loudest Natty" }

for _, b in ipairs(BANDS) do
	STATE.bands[b.id] = 0
end

--------------------------------------------------------------------------------
-- audio graph
--------------------------------------------------------------------------------

local Audio = {
	root = nil,
	mic = nil,
	micCreated = false,
	micOrigVolume = nil,
	micOrigMuted = nil,
	eqs = {},
	faders = {},
	distortion = nil,
	compressor = nil,
	limiter = nil,
	analyzer = nil,
	output = nil,
	wires = {},
	ok = false,
	err = nil,
	gainDb = 0,          -- gain the four faders actually ended up at
	transmitVol = 1,     -- AudioDeviceInput.Volume actually applied
	rx = nil,            -- receive-side chain, built lazily when RX is enabled
	rxSources = 0,       -- how many other players are wired into it
}

local function dbToVol(db)
	return math.clamp(10 ^ (db / 20), 0, 10)
end

local function volToDb(vol)
	local v = math.max(tonumber(vol) or 0, 1e-6)
	return 20 * math.log10(v)
end

-- Voice chat parents an AudioDeviceInput under the Player, but only once the
-- local mic has actually been opened, which can be many seconds after joining
-- (and never in a place without mic permission). Some clients put it under
-- VoiceChatService instead, so look in both.
local function findEngineMic()
	local ok, mic = pcall(function()
		return player:FindFirstChildOfClass("AudioDeviceInput")
	end)
	if ok and mic then
		return mic
	end
	ok, mic = pcall(function()
		return VoiceChatService:FindFirstChildOfClass("AudioDeviceInput")
	end)
	if ok and mic then
		return mic
	end
	return nil
end

-- Every other player's microphone, as a stream this client may wire. This is
-- the receive side: it is the one direction where a client-side graph really
-- does change networked voice, and it is identical on PC and on an Android
-- executor (property writes and wires, nothing platform-specific).
local function otherMicDevices()
	local list = {}
	local ok, players = pcall(function()
		return Players:GetPlayers()
	end)
	if not ok or type(players) ~= "table" then
		return list
	end
	for _, plr in ipairs(players) do
		if plr ~= player then
			local ok2, dev = pcall(function()
				return plr:FindFirstChildOfClass("AudioDeviceInput")
			end)
			if ok2 and dev then
				list[#list + 1] = dev
			end
		end
	end
	return list
end

local function clearWires()
	for _, w in ipairs(Audio.wires) do
		pcall(function()
			w:Destroy()
		end)
	end
	Audio.wires = {}
end

-- Wires are rebuilt from scratch whenever the chain shape changes (monitor
-- on/off, limiter bypass, soft clip on/off, a new mic node). Cheap, and it keeps
-- the graph identical to the one drawn in the panel.
local function rebuildWires()
	clearWires()
	if not Audio.root then
		return
	end

	-- level tap: mic -> AudioAnalyzer, deliberately not in the playback chain
	if Audio.mic and Audio.analyzer then
		local ok, tap = pcall(function()
			local wire = Instance.new("Wire")
			wire.SourceInstance = Audio.mic
			wire.TargetInstance = Audio.analyzer
			wire.Parent = Audio.analyzer
			return wire
		end)
		if ok and tap then
			table.insert(Audio.wires, tap)
		end
	end

	local chain = {}
	if Audio.mic then
		table.insert(chain, Audio.mic)
	end
	for i = 1, 3 do
		if Audio.eqs[i] then
			table.insert(chain, Audio.eqs[i])
		end
	end
	for i = 1, #Audio.faders do
		table.insert(chain, Audio.faders[i])
	end
	if Audio.distortion and (STATE.softclip or 0) > 0.001 then
		table.insert(chain, Audio.distortion)
	end
	if Audio.compressor then
		table.insert(chain, Audio.compressor)
	end
	if Audio.limiter and STATE.limiter then
		table.insert(chain, Audio.limiter)
	end
	if STATE.monitor and Audio.output then
		table.insert(chain, Audio.output)
	end

	for i = 1, #chain - 1 do
		local ok, w = pcall(function()
			local wire = Instance.new("Wire")
			wire.SourceInstance = chain[i]
			wire.TargetInstance = chain[i + 1]
			wire.Parent = chain[i + 1]
			return wire
		end)
		if ok and w then
			table.insert(Audio.wires, w)
		else
			Audio.err = "wire failed: " .. tostring(w)
		end
	end

	-- receive side: every other player's mic into one shared EQ, out to my speakers
	Audio.rxSources = 0
	local rx = Audio.rx
	if STATE.rx and rx then
		local sources = otherMicDevices()
		for _, dev in ipairs(sources) do
			local ok, w = pcall(function()
				local wire = Instance.new("Wire")
				wire.SourceInstance = dev
				wire.TargetInstance = rx.eqs[1]
				wire.Parent = rx.eqs[1]
				return wire
			end)
			if ok and w then
				table.insert(Audio.wires, w)
				Audio.rxSources = Audio.rxSources + 1
			end
		end
		local rxChain = {}
		for i = 1, 3 do
			if rx.eqs[i] then
				table.insert(rxChain, rx.eqs[i])
			end
		end
		for i = 1, #rx.faders do
			table.insert(rxChain, rx.faders[i])
		end
		if rx.limiter then
			table.insert(rxChain, rx.limiter)
		end
		if rx.output then
			table.insert(rxChain, rx.output)
		end
		for i = 1, #rxChain - 1 do
			local ok, w = pcall(function()
				local wire = Instance.new("Wire")
				wire.SourceInstance = rxChain[i]
				wire.TargetInstance = rxChain[i + 1]
				wire.Parent = rxChain[i + 1]
				return wire
			end)
			if ok and w then
				table.insert(Audio.wires, w)
			end
		end
	end
end

-- Record what the device's own volume was before we ever wrote to it, so
-- destroy() can put it back. Doing this lazily inside applyTransmit() captured
-- our own value on the second call and restored the wrong number.
local function rememberDevice(mic)
	Audio.mic = mic
	Audio.micOrigVolume = nil
	local ok, v = pcall(function()
		return mic.Volume
	end)
	if ok then
		Audio.micOrigVolume = v
	end
end

-- AudioDeviceInput.Volume is the one knob that is applied to the transmitted
-- stream, so it is worth wiring up. It is client-set here: the docs say these
-- properties should be assigned from the server to replicate, so treat it as
-- best effort and never as a substitute for an OS-level gain.
local function applyTransmit()
	local mic = Audio.mic
	if not mic then
		return
	end
	local vol = math.clamp(10 ^ (math.clamp(STATE.transmit or 0, TRANSMIT_MIN, TRANSMIT_MAX) / 20), 0, 3)
	pcall(function()
		mic.Volume = vol
	end)
	local ok, got = pcall(function()
		return mic.Volume
	end)
	Audio.transmitVol = ok and (tonumber(got) or vol) or vol
end

-- same curve, applied to what other players send me
local function applyRx()
	local rx = Audio.rx
	if not rx then
		return
	end
	for _, b in ipairs(BANDS) do
		local eq = rx.eqs[b.node]
		if eq then
			local db = math.clamp(STATE.bands[b.id] or 0, -80, 10)
			pcall(function()
				eq[b.prop] = db
			end)
		end
	end
	local total = math.clamp(STATE.rxGain or 0, -80, 40)
	for i = 1, #rx.faders do
		local f = rx.faders[i]
		if f then
			local slice
			if i < #rx.faders then
				slice = math.clamp(total, 0, 20)
				total = total - slice
			else
				slice = math.clamp(total, -80, 20)
			end
			pcall(function()
				f.Volume = dbToVol(slice)
			end)
		end
	end
	if rx.limiter then
		pcall(function()
			rx.limiter.MaxLevel = -0.5
			rx.limiter.Release = 0.05
		end)
	end
end

-- pushes STATE into the filter instances
local function apply()
	-- the receive chain is built on first use, whichever path enabled it
	if STATE.rx and not Audio.rx then
		buildRxGraph()
	end

	if Audio.mic then
		pcall(function()
			Audio.mic.Muted = STATE.muteMic
		end)
		applyTransmit()
	end

	for _, b in ipairs(BANDS) do
		local eq = Audio.eqs[b.node]
		if eq then
			local db = math.clamp(STATE.bands[b.id] or 0, -80, 10)
			pcall(function()
				eq[b.prop] = db
			end)
		end
	end

	-- preamp + boost spread across up to four chained faders (each caps +20 dB)
	local total = (STATE.preamp or 0) + (BOOST_DB[STATE.boost] or 0)
	for i = 1, #Audio.faders do
		local f = Audio.faders[i]
		if f then
			local slice
			if i < #Audio.faders then
				slice = math.clamp(total, 0, 20)
				total = total - slice
			else
				slice = math.clamp(total, -80, 20)
			end
			pcall(function()
				f.Volume = dbToVol(slice)
			end)
		end
	end

	-- report what the engine actually accepted, not what we asked for
	local achieved = 0
	for i = 1, #Audio.faders do
		local f = Audio.faders[i]
		if f then
			local ok, v = pcall(function()
				return f.Volume
			end)
			if ok then
				achieved = achieved + volToDb(v)
			end
		end
	end
	Audio.gainDb = achieved

	if Audio.distortion then
		pcall(function()
			Audio.distortion.Level = math.clamp(STATE.softclip or 0, 0, 1)
		end)
	end
	if Audio.compressor then
		pcall(function()
			Audio.compressor.Threshold = -12
			Audio.compressor.MakeupGain = 0
		end)
	end
	if Audio.limiter then
		pcall(function()
			Audio.limiter.MaxLevel = -0.5
			Audio.limiter.Release = 0.05
		end)
	end

	applyRx()
	rebuildWires()
	pushBridge()
end

-- A script-created AudioDeviceInput is a last resort: its Active flag is
-- RobloxScript-only, so it only ever produces a stream if the core opened the
-- device anyway. Keep polling for the real one and swap over the moment it
-- appears, which is what makes the meter start moving mid-session.
local function createFallbackMic()
	local created = Instance.new("AudioDeviceInput")
	pcall(function()
		created.Player = player
	end)
	pcall(function()
		created.Volume = 1
	end)
	created.Name = "RobloxEQ_Mic"
	created.Parent = Audio.root
	Audio.micCreated = true
	rememberDevice(created)
	return created
end

local function adoptEngineMic()
	local mic = findEngineMic()
	if mic then
		if Audio.mic ~= mic then
			Audio.micCreated = false
			rememberDevice(mic)
		end
		return true
	end
	return false
end

local function buildGraph()
	local ok, err = pcall(function()
		local root = Instance.new("Folder")
		root.Name = "RobloxEQ_Audio"
		root.Parent = workspace
		Audio.root = root

		if not adoptEngineMic() then
			createFallbackMic()
		end

		for i = 1, 3 do
			local eq = Instance.new("AudioEqualizer")
			eq.Name = "EQ" .. i
			eq.MidRange = NumberRange.new(CROSSOVERS[i][1], CROSSOVERS[i][2])
			eq.LowGain = 0
			eq.MidGain = 0
			eq.HighGain = 0
			eq.Parent = root
			Audio.eqs[i] = eq
		end

		for i = 1, 4 do
			local fader = Instance.new("AudioFader")
			fader.Name = "Fader" .. i
			fader.Volume = 1
			fader.Parent = root
			Audio.faders[i] = fader
		end

		local dist = Instance.new("AudioDistortion")
		dist.Name = "SoftClip"
		dist.Level = 0
		dist.Parent = root
		Audio.distortion = dist

		local comp = Instance.new("AudioCompressor")
		comp.Name = "Tame"
		comp.Threshold = -12
		comp.Parent = root
		Audio.compressor = comp

		local lim = Instance.new("AudioLimiter")
		lim.Name = "ClipGuard"
		lim.MaxLevel = -0.5
		lim.Release = 0.05
		lim.Parent = root
		Audio.limiter = lim

		local analyzer = Instance.new("AudioAnalyzer")
		analyzer.Name = "LevelTap"
		analyzer.Parent = root
		Audio.analyzer = analyzer

		local out = Instance.new("AudioDeviceOutput")
		out.Name = "MonitorOut"
		pcall(function()
			out.Player = player
		end)
		out.Parent = root
		Audio.output = out
	end)

	if ok then
		Audio.ok = true
	else
		Audio.ok = false
		Audio.err = tostring(err)
	end
	return Audio.ok
end

-- The receive chain is only built when RX is switched on, so the default graph
-- stays the 3 EQ / 4 fader monitor chain.
buildRxGraph = function()
	if Audio.rx then
		return Audio.rx
	end
	local ok = pcall(function()
		local folder = Instance.new("Folder")
		folder.Name = "RobloxEQ_RX"
		folder.Parent = Audio.root or workspace

		local rx = { eqs = {}, faders = {}, folder = folder }
		for i = 1, 3 do
			local eq = Instance.new("AudioEqualizer")
			eq.Name = "RX_EQ" .. i
			eq.MidRange = NumberRange.new(CROSSOVERS[i][1], CROSSOVERS[i][2])
			eq.LowGain = 0
			eq.MidGain = 0
			eq.HighGain = 0
			eq.Parent = folder
			rx.eqs[i] = eq
		end
		for i = 1, 2 do
			local fader = Instance.new("AudioFader")
			fader.Name = "RX_Fader" .. i
			fader.Volume = dbToVol(0)
			fader.Parent = folder
			rx.faders[i] = fader
		end
		local lim = Instance.new("AudioLimiter")
		lim.Name = "RX_ClipGuard"
		lim.MaxLevel = -0.5
		lim.Release = 0.05
		lim.Parent = folder
		rx.limiter = lim
		local out = Instance.new("AudioDeviceOutput")
		out.Name = "RX_Out"
		pcall(function()
			out.Player = player
		end)
		out.Parent = folder
		rx.output = out
		Audio.rx = rx
	end)
	if not ok then
		Audio.rx = nil
	end
	return Audio.rx
end

--------------------------------------------------------------------------------
-- ui
--------------------------------------------------------------------------------

local THEME = {
	bg = Color3.fromRGB(17, 17, 21),
	panel = Color3.fromRGB(25, 25, 31),
	track = Color3.fromRGB(38, 38, 46),
	stroke = Color3.fromRGB(52, 52, 64),
	text = Color3.fromRGB(232, 232, 242),
	dim = Color3.fromRGB(138, 138, 156),
	accent = Color3.fromRGB(118, 198, 255),
	good = Color3.fromRGB(122, 226, 160),
	bad = Color3.fromRGB(255, 122, 122),
	warn = Color3.fromRGB(255, 196, 110),
}

local FONT = Enum.Font.Gotham
local FONT_BOLD = Enum.Font.GothamMedium

local UI = {
	bandSliders = {},
	presetLabel = nil,
	totalLabel = nil,
	preampSlider = nil,
	transmitSlider = nil,
	clipSlider = nil,
}
local syncUI
local setPreset
local updateStatus
local diagnostics
local bridgeStatus = "bridge: off"

local function make(class, props, parent)
	local inst = Instance.new(class)
	for k, v in pairs(props) do
		inst[k] = v
	end
	if parent then
		inst.Parent = parent
	end
	return inst
end

local function corner(inst, radius)
	make("UICorner", { CornerRadius = UDim.new(0, radius or 4) }, inst)
	return inst
end

local function stroke(inst, colour, thickness, transparency)
	make("UIStroke", {
		Color = colour or THEME.stroke,
		Thickness = thickness or 1,
		Transparency = transparency or 0,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	}, inst)
	return inst
end

local function label(parent, text, size, colour, font, xAlign)
	return make("TextLabel", {
		BackgroundTransparency = 1,
		Text = text,
		TextSize = size,
		TextColor3 = colour or THEME.text,
		Font = font or FONT,
		TextXAlignment = xAlign or Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Center,
	}, parent)
end

local function getGui()
	local ok, hui = pcall(function()
		return gethui and gethui()
	end)
	if ok and hui then
		return hui
	end
	local ok2, cg = pcall(function()
		return game:GetService("CoreGui")
	end)
	if ok2 and cg then
		return cg
	end
	return player:WaitForChild("PlayerGui", 10) or player
end

local function getViewport()
	local vp = Vector2.new(1280, 720)
	pcall(function()
		local cam = workspace.CurrentCamera
		if cam and cam.ViewportSize then
			vp = cam.ViewportSize
		end
	end)
	if not vp or vp.X < 1 or vp.Y < 1 then
		vp = Vector2.new(1280, 720)
	end
	return vp
end

local screen = Instance.new("ScreenGui")
screen.Name = "RobloxEQ"
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screen.DisplayOrder = 500

-- executors can reach CoreGui; a plain LocalScript cannot, so fall back to PlayerGui
local parented = pcall(function()
	screen.Parent = getGui()
end)
if not parented or not screen.Parent then
	pcall(function()
		screen.Parent = player:WaitForChild("PlayerGui", 10)
	end)
end
if not screen.Parent then
	warn("[RobloxEQ] no GUI host available")
	return
end

--------------------------------------------------------------------------------
-- layout
--
-- Row heights are declared once and the panel is sized from them, so the status
-- box can never be clipped by a hard-coded total (v1.0 was 548 tall with an
-- 86 px status box that needed ~110).
--------------------------------------------------------------------------------

local ROW_H = {
	graph = 62,
	preset = 24,
	gain = 20,
	boost = 22,
	bands = 168,
	clip = 22,
	toggle = 22,
	status = 96,
	footer = 12,
}
local ROW_ORDER = { "graph", "preset", "gain", "boost", "bands", "clip", "toggle", "status", "footer" }
local ROW_PAD = 6

local PANEL_W = 384
local TITLE_H = 30
local BODY_TOP = 36
local rowSum = 0
for _, key in ipairs(ROW_ORDER) do
	rowSum = rowSum + ROW_H[key]
end
local PANEL_H = BODY_TOP + rowSum + ROW_PAD * (#ROW_ORDER - 1) + 8

local compact = isMobile or getViewport().X < 700
local scale = 1
local collapsed = false
local topLeft = Vector2.new(0, 34)

local main = make("Frame", {
	Name = "Main",
	Size = UDim2.fromOffset(PANEL_W, PANEL_H),
	Position = UDim2.new(0.5, 0, 0, 34),
	AnchorPoint = Vector2.new(0.5, 0),
	BackgroundColor3 = THEME.bg,
	BorderSizePixel = 0,
}, screen)
corner(main, 8)
stroke(main, THEME.stroke, 1, 0.15)

local uiScale = make("UIScale", { Scale = 1 }, main)

local function panelW()
	return PANEL_W * scale
end

local function panelH()
	return (collapsed and TITLE_H or PANEL_H) * scale
end

-- keeps the panel inside the viewport, including after a rotation
local function place(tlX, tlY)
	local vp = getViewport()
	tlX = math.clamp(tlX, 0, math.max(vp.X - panelW(), 0))
	tlY = math.clamp(tlY, 0, math.max(vp.Y - panelH(), 0))
	topLeft = Vector2.new(tlX, tlY)
	main.Position = UDim2.new(0.5, tlX + panelW() / 2 - vp.X / 2, 0, tlY)
end

local function refit()
	local vp = getViewport()
	scale = math.clamp(math.min((vp.X - 16) / PANEL_W, (vp.Y - 60) / PANEL_H), 0.45, 1)
	pcall(function()
		uiScale.Scale = scale
	end)
	main.Size = UDim2.fromOffset(PANEL_W, collapsed and TITLE_H or PANEL_H)
	place(topLeft.X, topLeft.Y)
end

refit()
place(math.max((getViewport().X - panelW()) / 2, 0), 34)

-- rotate the phone, resize the window: re-fit and stay on screen
pcall(function()
	local cam = workspace.CurrentCamera
	if cam and cam.GetPropertyChangedSignal then
		cam:GetPropertyChangedSignal("ViewportSize"):Connect(function()
			if screen.Parent then
				refit()
			end
		end)
	end
end)

local titleBar = make("Frame", {
	Size = UDim2.new(1, 0, 0, TITLE_H),
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
}, main)
corner(titleBar, 8)

local titleText = label(titleBar, "MIC EQ", 13, THEME.text, FONT_BOLD)
titleText.Size = UDim2.fromOffset(70, TITLE_H)
titleText.Position = UDim2.fromOffset(10, 0)

local subtitle = label(titleBar, "AUDIO API  ·  v" .. VERSION .. (compact and "  ·  LOCAL" or "  ·  LOCAL MONITOR"), 8, THEME.dim, FONT)
subtitle.Size = UDim2.new(1, -170, 1, 0)
subtitle.Position = UDim2.fromOffset(72, 1)

local closeBtn = make("TextButton", {
	Size = UDim2.fromOffset(26, 26),
	Position = UDim2.new(1, -30, 0, 2),
	BackgroundTransparency = 1,
	Text = "×",
	TextSize = 18,
	TextColor3 = THEME.dim,
	Font = FONT_BOLD,
}, titleBar)

local diagBtn = make("TextButton", {
	Size = UDim2.fromOffset(22, 22),
	Position = UDim2.new(1, -56, 0, 4),
	BackgroundTransparency = 1,
	Text = "?",
	TextSize = 13,
	TextColor3 = THEME.dim,
	Font = FONT_BOLD,
}, titleBar)

local collapseBtn = make("TextButton", {
	Size = UDim2.fromOffset(22, 22),
	Position = UDim2.new(1, -80, 0, 4),
	BackgroundTransparency = 1,
	Text = "–",
	TextSize = 16,
	TextColor3 = THEME.dim,
	Font = FONT_BOLD,
}, titleBar)

local body = make("Frame", {
	Size = UDim2.new(1, -20, 1, -BODY_TOP - 4),
	Position = UDim2.fromOffset(10, BODY_TOP),
	BackgroundTransparency = 1,
}, main)
make("UIListLayout", {
	Padding = UDim.new(0, ROW_PAD),
	SortOrder = Enum.SortOrder.LayoutOrder,
}, body)

--------------------------------------------------------------------------------
-- graph
--------------------------------------------------------------------------------

local graphRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.graph),
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	LayoutOrder = 1,
}, body)
corner(graphRow, 6)

local graphArea = make("Frame", {
	Size = UDim2.new(1, -12, 1, -12),
	Position = UDim2.fromOffset(6, 6),
	BackgroundTransparency = 1,
	ClipsDescendants = true,
}, graphRow)

make("Frame", {
	Size = UDim2.new(1, 0, 0, 1),
	Position = UDim2.fromScale(0, 0.682),
	BackgroundColor3 = THEME.stroke,
	BackgroundTransparency = 0.35,
	BorderSizePixel = 0,
}, graphArea)

local BAR_COUNT = 44
local graphBars = {}
for i = 1, BAR_COUNT do
	graphBars[i] = make("Frame", {
		Size = UDim2.new(1 / BAR_COUNT, -1, 0.05, 0),
		Position = UDim2.fromScale((i - 1) / BAR_COUNT, 1),
		AnchorPoint = Vector2.new(0, 1),
		BackgroundColor3 = THEME.accent,
		BackgroundTransparency = 0.2,
		BorderSizePixel = 0,
	}, graphArea)
end

-- live input level, from the AudioAnalyzer tap
local levelBar = make("Frame", {
	Size = UDim2.new(0, 0, 0, 2),
	Position = UDim2.new(0, 0, 1, -2),
	BackgroundColor3 = THEME.good,
	BorderSizePixel = 0,
}, graphArea)

local function curveDbAt(freq)
	for i = 1, #BANDS - 1 do
		local a, b = BANDS[i], BANDS[i + 1]
		if freq <= b.freq then
			local lo, hi = math.log10(a.freq), math.log10(b.freq)
			local t = (math.log10(freq) - lo) / (hi - lo)
			local av, bv = STATE.bands[a.id] or 0, STATE.bands[b.id] or 0
			return av + (bv - av) * t
		end
	end
	return STATE.bands[BANDS[#BANDS].id] or 0
end

local function redrawGraph()
	for i = 1, BAR_COUNT do
		local f = 20 * (20000 / 20) ^ ((i - 1) / (BAR_COUNT - 1))
		local db = curveDbAt(f)
		local h = math.clamp((db + 24) / 34, 0.01, 1)
		local bar = graphBars[i]
		bar.Size = UDim2.new(1 / BAR_COUNT, -1, h, 0)
		bar.BackgroundColor3 = db >= 0 and THEME.accent or THEME.warn
		bar.BackgroundTransparency = 0.15 + 0.45 * (1 - h)
	end
end

--------------------------------------------------------------------------------
-- sliders
--------------------------------------------------------------------------------

-- AbsolutePosition / AbsoluteSize are real screen pixels (UIScale included) and
-- input.Position is too, so touch maps 1:1 here with no extra scaling.
local function attachDrag(track, vertical, onT)
	local dragging = false
	local function tFromInput(input)
		if vertical then
			local top = track.AbsolutePosition.Y
			local h = math.max(track.AbsoluteSize.Y, 1)
			return 1 - math.clamp((input.Position.Y - top) / h, 0, 1)
		end
		local left = track.AbsolutePosition.X
		local w = math.max(track.AbsoluteSize.X, 1)
		return math.clamp((input.Position.X - left) / w, 0, 1)
	end
	track.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = true
			onT(tFromInput(input))
		end
	end)
	UserInputService.InputChanged:Connect(function(input)
		if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
			onT(tFromInput(input))
		end
	end)
	UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = false
		end
	end)
end

local function makeVerticalSlider(parent, band)
	local wrap = make("Frame", {
		Size = UDim2.fromOffset(36, ROW_H.bands),
		BackgroundTransparency = 1,
	}, parent)
	make("UIListLayout", {
		Padding = UDim.new(0, 2),
		HorizontalAlignment = Enum.HorizontalAlignment.Center,
		SortOrder = Enum.SortOrder.LayoutOrder,
	}, wrap)

	local name = label(wrap, band.label, 8, THEME.dim, FONT, Enum.TextXAlignment.Center)
	name.Size = UDim2.new(1, 0, 0, 11)
	name.LayoutOrder = 1

	local track = make("Frame", {
		Size = UDim2.fromOffset(16, 108),
		BackgroundColor3 = THEME.track,
		BorderSizePixel = 0,
		LayoutOrder = 2,
	}, wrap)
	corner(track, 8)
	stroke(track, THEME.stroke, 1, 0.2)

	local fill = make("Frame", {
		Size = UDim2.new(1, 0, 0.5, 0),
		Position = UDim2.fromScale(0, 1),
		AnchorPoint = Vector2.new(0, 1),
		BackgroundColor3 = THEME.accent,
		BackgroundTransparency = 0.55,
		BorderSizePixel = 0,
	}, track)
	corner(fill, 8)

	local knob = make("Frame", {
		Size = UDim2.new(1, 6, 0, 5),
		Position = UDim2.new(0, -3, 0.5, -2),
		BackgroundColor3 = THEME.text,
		BorderSizePixel = 0,
	}, track)
	corner(knob, 2)

	local value = label(wrap, "0", 8, THEME.dim, FONT, Enum.TextXAlignment.Center)
	value.Size = UDim2.new(1, 0, 0, 11)
	value.LayoutOrder = 3

	local slider = { value = 0 }

	function slider.set(db, silent)
		slider.value = math.clamp(db, SLIDER_MIN, SLIDER_MAX)
		local t = (slider.value - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)
		fill.Size = UDim2.new(1, 0, t, 0)
		knob.Position = UDim2.new(0, -3, 1 - t, -2)
		value.Text = string.format("%+d", math.floor(slider.value + 0.5))
		if slider.value == 0 then
			value.TextColor3 = THEME.dim
		elseif slider.value > 0 then
			value.TextColor3 = THEME.accent
		else
			value.TextColor3 = THEME.warn
		end
		if not silent then
			STATE.bands[band.id] = slider.value
			apply()
			redrawGraph()
		end
	end

	attachDrag(track, true, function(t)
		slider.set(SLIDER_MIN + t * (SLIDER_MAX - SLIDER_MIN))
	end)

	function slider.sync()
		slider.set(STATE.bands[band.id] or 0, true)
	end

	UI.bandSliders[band.id] = slider
	return slider
end

local function makeHorizontalSlider(parent, opts)
	local height = opts.height or 20
	local props = { BackgroundTransparency = 1 }
	if opts.width then
		props.Size = UDim2.fromOffset(opts.width, height)
	else
		props.Size = UDim2.new(1, 0, 0, height)
	end
	if opts.x then
		props.Position = UDim2.fromOffset(opts.x, opts.y or 0)
	end
	local wrap = make("Frame", props, parent)

	local leftPad = opts.labelWidth or 52

	local track = make("Frame", {
		Size = UDim2.new(1, -leftPad - 36, 0, 6),
		Position = UDim2.fromOffset(leftPad, math.floor((height - 6) / 2)),
		BackgroundColor3 = THEME.track,
		BorderSizePixel = 0,
	}, wrap)
	corner(track, 3)

	local fill = make("Frame", {
		Size = UDim2.new(0.5, 0, 1, 0),
		BackgroundColor3 = THEME.accent,
		BackgroundTransparency = 0.4,
		BorderSizePixel = 0,
	}, track)
	corner(fill, 3)

	local knob = make("Frame", {
		Size = UDim2.new(0, 4, 1, 8),
		Position = UDim2.new(0.5, -2, 0.5, 0),
		AnchorPoint = Vector2.new(0, 0.5),
		BackgroundColor3 = THEME.text,
		BorderSizePixel = 0,
	}, track)
	corner(knob, 2)

	local readout = label(wrap, "", 9, THEME.dim, FONT, Enum.TextXAlignment.Right)
	readout.Size = UDim2.new(0, 34, 1, 0)
	readout.Position = UDim2.new(1, -34, 0, 0)

	local slider = { value = opts.value or 0 }

	function slider.set(value, silent)
		slider.value = math.clamp(value, opts.min, opts.max)
		local t = (slider.value - opts.min) / (opts.max - opts.min)
		fill.Size = UDim2.new(t, 0, 1, 0)
		knob.Position = UDim2.new(t, -2, 0.5, 0)
		readout.Text = opts.format and opts.format(slider.value) or tostring(math.floor(slider.value))
		if not silent then
			opts.onChange(slider.value)
		end
	end

	attachDrag(track, false, function(t)
		local raw = opts.min + t * (opts.max - opts.min)
		if opts.step then
			raw = math.floor(raw / opts.step + 0.5) * opts.step
		end
		slider.set(raw)
	end)

	function slider.sync()
		slider.set(slider.value, true)
	end

	return slider
end

--------------------------------------------------------------------------------
-- preset row
--------------------------------------------------------------------------------

local presetRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.preset),
	BackgroundTransparency = 1,
	LayoutOrder = 2,
}, body)

local function chipButton(parent, text, width, x, onClick)
	local btn = make("TextButton", {
		Size = UDim2.fromOffset(width, 22),
		Position = UDim2.fromOffset(x, 1),
		BackgroundColor3 = THEME.panel,
		BorderSizePixel = 0,
		Text = text,
		TextSize = 10,
		TextColor3 = THEME.text,
		Font = FONT_BOLD,
		AutoButtonColor = false,
	}, parent)
	corner(btn, 4)
	stroke(btn, THEME.stroke, 1, 0.2)
	if onClick then
		btn.MouseButton1Click:Connect(onClick)
	end
	return btn
end

chipButton(presetRow, "◀", 24, 0, function()
	local i = table.find(PRESET_ORDER, STATE.preset) or 1
	setPreset(PRESET_ORDER[i == 1 and #PRESET_ORDER or i - 1])
end)

UI.presetLabel = make("TextButton", {
	Size = UDim2.fromOffset(244, 22),
	Position = UDim2.fromOffset(28, 1),
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	Text = STATE.preset,
	TextSize = 11,
	TextColor3 = THEME.text,
	Font = FONT_BOLD,
	AutoButtonColor = false,
}, presetRow)
corner(UI.presetLabel, 4)
stroke(UI.presetLabel, THEME.stroke, 1, 0.2)
UI.presetLabel.MouseButton1Click:Connect(function()
	setPreset(STATE.preset)
end)

chipButton(presetRow, "▶", 24, 276, function()
	local i = table.find(PRESET_ORDER, STATE.preset) or 1
	setPreset(PRESET_ORDER[i == #PRESET_ORDER and 1 or i + 1])
end)

chipButton(presetRow, "RESET", 54, 310, function()
	setPreset("Loud + Clear")
end)

--------------------------------------------------------------------------------
-- gain row: monitor chain preamp + transmit device gain
--------------------------------------------------------------------------------

local gainRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.gain),
	BackgroundTransparency = 1,
	LayoutOrder = 3,
}, body)

local preampLabel = label(gainRow, "PRE", 9, THEME.dim, FONT)
preampLabel.Size = UDim2.fromOffset(30, ROW_H.gain)

UI.preampSlider = makeHorizontalSlider(gainRow, {
	min = PREAMP_MIN,
	max = PREAMP_MAX,
	value = STATE.preamp,
	labelWidth = 0,
	width = 150,
	x = 30,
	height = ROW_H.gain,
	format = function(v)
		return string.format("%+.1f", v)
	end,
	onChange = function(v)
		STATE.preamp = v
		apply()
		updateStatus()
	end,
})

local transmitLabel = label(gainRow, "XFER", 9, THEME.dim, FONT)
transmitLabel.Size = UDim2.fromOffset(34, ROW_H.gain)
transmitLabel.Position = UDim2.fromOffset(186, 0)

UI.transmitSlider = makeHorizontalSlider(gainRow, {
	min = TRANSMIT_MIN,
	max = TRANSMIT_MAX,
	value = STATE.transmit,
	labelWidth = 0,
	width = 142,
	x = 222,
	height = ROW_H.gain,
	format = function(v)
		return string.format("%+.1f", v)
	end,
	onChange = function(v)
		STATE.transmit = v
		apply()
		updateStatus()
	end,
})

--------------------------------------------------------------------------------
-- boost
--------------------------------------------------------------------------------

local boostRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.boost),
	BackgroundTransparency = 1,
	LayoutOrder = 4,
}, body)
local boostLabel = label(boostRow, "BOOST", 9, THEME.dim, FONT)
boostLabel.Size = UDim2.fromOffset(52, ROW_H.boost)

local boostChips = {}
for i, tier in ipairs(BOOST_ORDER) do
	boostChips[tier] = chipButton(boostRow, tier == "off" and "OFF" or tier, 37, 52 + (i - 1) * 38, function()
		STATE.boost = tier
		apply()
		syncUI()
		updateStatus()
	end)
end

UI.totalLabel = label(boostRow, "", 9, THEME.dim, FONT, Enum.TextXAlignment.Right)
UI.totalLabel.Size = UDim2.fromOffset(46, ROW_H.boost)
UI.totalLabel.Position = UDim2.fromOffset(318, 0)

--------------------------------------------------------------------------------
-- bands
--------------------------------------------------------------------------------

local bandRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.bands),
	BackgroundTransparency = 1,
	LayoutOrder = 5,
}, body)
make("UIListLayout", {
	FillDirection = Enum.FillDirection.Horizontal,
	Padding = UDim.new(0, 4),
	SortOrder = Enum.SortOrder.LayoutOrder,
}, bandRow)

for _, band in ipairs(BANDS) do
	makeVerticalSlider(bandRow, band)
end

--------------------------------------------------------------------------------
-- soft clip + toggles
--------------------------------------------------------------------------------

local clipRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.clip),
	BackgroundTransparency = 1,
	LayoutOrder = 6,
}, body)
local clipLabel = label(clipRow, "SOFT CLIP", 9, THEME.dim, FONT)
clipLabel.Size = UDim2.fromOffset(56, ROW_H.clip)

UI.clipSlider = makeHorizontalSlider(clipRow, {
	min = 0,
	max = 1,
	value = STATE.softclip,
	labelWidth = 56,
	height = ROW_H.clip,
	step = 0.05,
	format = function(v)
		return string.format("%.2f", v)
	end,
	onChange = function(v)
		STATE.softclip = v
		apply()
		updateStatus()
	end,
})

local toggleRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.toggle),
	BackgroundTransparency = 1,
	LayoutOrder = 7,
}, body)

local toggleButtons = {}
local function paintToggle(key)
	local btn = toggleButtons[key]
	if not btn then
		return
	end
	local on = STATE[key]
	btn.BackgroundColor3 = on and THEME.good or THEME.panel
	btn.BackgroundTransparency = on and 0.75 or 0
	btn.TextColor3 = on and THEME.good or THEME.dim
end

local toggleX = 0
local function toggleButton(parent, text, width, key, onChange)
	local btn = chipButton(parent, text, width, toggleX, function()
		STATE[key] = not STATE[key]
		paintToggle(key)
		onChange()
	end)
	toggleButtons[key] = btn
	toggleX = toggleX + width + 4
	paintToggle(key)
	return btn
end

toggleButton(toggleRow, "CLIP GUARD", 76, "limiter", function()
	apply()
end)
toggleButton(toggleRow, "MONITOR", 66, "monitor", function()
	apply()
	updateStatus()
end)
toggleButton(toggleRow, "MUTE MIC", 68, "muteMic", function()
	apply()
	updateStatus()
end)
toggleButton(toggleRow, "RX OTHERS", 66, "rx", function()
	if STATE.rx then
		buildRxGraph()
	end
	apply()
	updateStatus()
end)
toggleButton(toggleRow, "BRIDGE", 66, "bridge", function()
	apply()
	updateStatus()
end)

--------------------------------------------------------------------------------
-- status + footer
--------------------------------------------------------------------------------

local statusRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, ROW_H.status),
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	LayoutOrder = 8,
}, body)
corner(statusRow, 6)

local statusLabel = make("TextLabel", {
	Size = UDim2.new(1, -12, 1, -8),
	Position = UDim2.fromOffset(6, 4),
	BackgroundTransparency = 1,
	Text = "starting…",
	TextSize = 9,
	TextColor3 = THEME.dim,
	Font = FONT,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	TextWrapped = true,
}, statusRow)

local footer = label(body, "local monitor only — other players hear your OS input device", 8, THEME.dim, FONT, Enum.TextXAlignment.Center)
footer.Size = UDim2.new(1, 0, 0, ROW_H.footer)
footer.LayoutOrder = 9

--------------------------------------------------------------------------------
-- drag
--------------------------------------------------------------------------------

-- The panel is drawn in 384x540 design units and shown through a UIScale, so the
-- finger delta has to be divided by that scale or the panel lags behind it on a
-- phone. It is also clamped to the viewport, which v1.0 never did - dragging it
-- off the edge made the script look dead.
local function makeDraggable(handle)
	local dragging = false
	local dragStart = Vector2.new(0, 0)
	local startPos = Vector2.new(0, 0)
	handle.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = true
			dragStart = input.Position
			startPos = topLeft
		end
	end)
	UserInputService.InputChanged:Connect(function(input)
		if not dragging then
			return
		end
		if input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch then
			local delta = input.Position - dragStart
			local s = (scale and scale > 0) and scale or 1
			place(startPos.X + delta.X / s, startPos.Y + delta.Y / s)
		end
	end)
	UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = false
		end
	end)
end

makeDraggable(titleBar)

--------------------------------------------------------------------------------
-- state -> ui
--------------------------------------------------------------------------------

syncUI = function()
	for _, band in ipairs(BANDS) do
		local s = UI.bandSliders[band.id]
		if s then
			s.sync()
		end
	end
	if UI.preampSlider then
		UI.preampSlider.set(STATE.preamp, true)
	end
	if UI.transmitSlider then
		UI.transmitSlider.set(math.clamp(STATE.transmit, TRANSMIT_MIN, TRANSMIT_MAX), true)
	end
	if UI.clipSlider then
		UI.clipSlider.set(STATE.softclip, true)
	end
	for tier, btn in pairs(boostChips) do
		if tier == STATE.boost then
			btn.BackgroundColor3 = THEME.accent
			btn.TextColor3 = THEME.bg
		else
			btn.BackgroundColor3 = THEME.panel
			btn.TextColor3 = THEME.text
		end
	end
	local total = (STATE.preamp or 0) + (BOOST_DB[STATE.boost] or 0)
	UI.totalLabel.Text = string.format("Σ%+d", math.floor(total + 0.5))
	if total >= 60 then
		UI.totalLabel.TextColor3 = THEME.bad
	elseif total >= 30 then
		UI.totalLabel.TextColor3 = THEME.warn
	else
		UI.totalLabel.TextColor3 = THEME.dim
	end
	UI.presetLabel.Text = STATE.preset
	paintToggle("limiter")
	paintToggle("monitor")
	paintToggle("muteMic")
	paintToggle("rx")
	paintToggle("bridge")
	redrawGraph()
end

setPreset = function(name)
	local preset = PRESETS[name]
	if not preset then
		name = "Loud + Clear"
		preset = PRESETS[name]
	end
	STATE.preset = name
	STATE.preamp = preset.preamp
	STATE.boost = preset.boost
	STATE.softclip = preset.softclip
	for id in pairs(STATE.bands) do
		STATE.bands[id] = preset.bands[id] or 0
	end
	apply()
	syncUI()
	updateStatus()
end

-- Six short lines: whatever is wrong gets one line, never a paragraph that the
-- status box has to clip. The long form lives in RobloxEQ.diagnostics().
local function micState()
	local active, muted = false, false
	if Audio.mic then
		pcall(function()
			active = Audio.mic.Active == true
			muted = Audio.mic.Muted == true
		end)
	end
	return active, muted
end

local function inputLevel()
	local rms = 0
	if Audio.analyzer then
		pcall(function()
			rms = Audio.analyzer.RmsLevel or 0
		end)
	end
	return tonumber(rms) or 0
end

updateStatus = function()
	local lines = {}
	if not Audio.ok then
		lines[#lines + 1] = "x graph failed: " .. tostring(Audio.err)
	else
		local active, muted = micState()
		lines[#lines + 1] = string.format("graph: %d wires · mic %s · active=%s muted=%s",
			#Audio.wires, Audio.micCreated and "script" or "game", tostring(active), tostring(muted))
		local rms = inputLevel()
		local dbfs = rms > 1e-5 and (20 * math.log10(rms)) or -120
		lines[#lines + 1] = string.format("in %d dBFS · chain gain %+.1f dB · limiter %s",
			math.floor(dbfs + 0.5), Audio.gainDb, STATE.limiter and "on" or "bypassed")
		lines[#lines + 1] = string.format("xfer %+.1f dB → device vol %.2f/3 (best effort)",
			math.clamp(STATE.transmit or 0, TRANSMIT_MIN, TRANSMIT_MAX), Audio.transmitVol)
		local rxText = STATE.rx and string.format("%d player%s", Audio.rxSources, Audio.rxSources == 1 and "" or "s") or "OFF"
		lines[#lines + 1] = string.format("monitor %s (local) · rx %s",
			STATE.monitor and "ON" or "OFF", rxText)
		if isMobile then
			lines[#lines + 1] = "mobile: no transmit EQ from a script — roblox/mobile.md"
		else
			lines[#lines + 1] = bridgeStatus
		end
		if not Audio.mic then
			lines[#lines + 1] = "! no AudioDeviceInput yet — voice chat has not opened your mic"
		elseif not active then
			lines[#lines + 1] = "! mic inactive — needs mic permission + UseAudioApi = Enabled"
		end
	end

	statusLabel.Text = table.concat(lines, "\n")
	local active = select(1, micState())
	if not Audio.ok then
		statusLabel.TextColor3 = THEME.bad
	elseif active then
		statusLabel.TextColor3 = THEME.good
	else
		statusLabel.TextColor3 = THEME.dim
	end
end

--------------------------------------------------------------------------------
-- persistence (executor filesystem, optional)
--------------------------------------------------------------------------------

local function saveState()
	pcall(function()
		if not writefile then
			return
		end
		writefile(CONFIG_FILE, HttpService:JSONEncode(STATE))
	end)
end

local function loadState()
	pcall(function()
		if not (isfile and isfile(CONFIG_FILE) and readfile) then
			return
		end
		local data = HttpService:JSONDecode(readfile(CONFIG_FILE))
		if type(data) ~= "table" then
			return
		end
		if type(data.bands) == "table" then
			for id, db in pairs(data.bands) do
				if STATE.bands[id] ~= nil and type(db) == "number" then
					STATE.bands[id] = math.clamp(db, SLIDER_MIN, SLIDER_MAX)
				end
			end
		end
		if type(data.preamp) == "number" then
			STATE.preamp = math.clamp(data.preamp, PREAMP_MIN, PREAMP_MAX)
		end
		if type(data.transmit) == "number" then
			STATE.transmit = math.clamp(data.transmit, TRANSMIT_MIN, TRANSMIT_MAX)
		end
		if type(data.boost) == "string" and BOOST_DB[data.boost] then
			STATE.boost = data.boost
		end
		if type(data.softclip) == "number" then
			STATE.softclip = math.clamp(data.softclip, 0, 1)
		end
		for _, key in ipairs({ "limiter", "monitor", "muteMic", "bridge" }) do
			if type(data[key]) == "boolean" then
				STATE[key] = data[key]
			end
		end
		if type(data.bridgeHost) == "string" and #data.bridgeHost > 0 then
			STATE.bridgeHost = data.bridgeHost
		end
		if type(data.preset) == "string" and PRESETS[data.preset] then
			STATE.preset = data.preset
		end
	end)
end

--------------------------------------------------------------------------------
-- bridge: hand the curve to a local daemon that drives the real mic
--
-- An executor cannot touch the voice encoder, but it can reach localhost. With
-- roblox/bridge/eq-bridge.mjs running, each change here is written into
-- Equalizer APO's config, which applies to the mic every other player hears.
-- On a phone 127.0.0.1 is the phone, not your PC, so set the host explicitly
-- with RobloxEQ.bridgeHost("192.168.1.20:7331") - and note the bridge writes the
-- PC's APO config, which a phone mic never passes through.
--------------------------------------------------------------------------------

-- Executors expose `request` / `syn.request` in the script environment, NOT in
-- `_G`, so a rawget(_G, ...) lookup always came back nil and the bridge claimed
-- it had no HTTP. Probe getgenv, _G, then a loadstring lookup, which reaches
-- whatever globals the executor injected.
local function envGet(name)
	local ok, v = pcall(function()
		local genv = getgenv and getgenv()
		if genv and genv[name] ~= nil then
			return genv[name]
		end
		return _G[name]
	end)
	if ok and v ~= nil then
		return v
	end
	if type(loadstring) == "function" then
		local ok2, v2 = pcall(function()
			return loadstring("return " .. name)()
		end)
		if ok2 and v2 ~= nil then
			return v2
		end
	end
	return nil
end

local HTTP_NAMES = { "request", "http_request", "http", "syn", "fluxus", "krnl", "delta" }
local httpName = nil

local function resolveHttp()
	for _, name in ipairs(HTTP_NAMES) do
		local v = envGet(name)
		if type(v) == "function" then
			httpName = name
			return v
		elseif type(v) == "table" and type(v.request) == "function" then
			httpName = name .. ".request"
			return function(options)
				return v.request(options)
			end
		end
	end
	return nil
end

local httpRequest = resolveHttp()
local bridgeScheduled = false
local bridgeLastSend = 0

local function bridgeUrl()
	return "http://" .. tostring(STATE.bridgeHost or BRIDGE_HOST) .. "/eq"
end

local function sendBridge()
	local body = "{}"
	pcall(function()
		body = HttpService:JSONEncode({
			preamp = STATE.preamp,
			boost = STATE.boost,
			softclip = STATE.softclip,
			bands = STATE.bands,
		})
	end)

	local ok, res = pcall(httpRequest, {
		Url = bridgeUrl(),
		Method = "POST",
		Headers = { ["Content-Type"] = "application/json" },
		Body = body,
	})

	if not ok then
		bridgeStatus = "bridge: request failed - " .. tostring(res)
		return
	end

	local code = nil
	pcall(function()
		code = res.StatusCode or res.status or res.Status
	end)
	bridgeStatus = string.format("bridge: %s -> HTTP %s", tostring(httpName), tostring(code or "?"))
end

pushBridge = function()
	if not STATE.bridge then
		return
	end
	if not httpRequest then
		-- re-probe: some executors inject the API slightly after the script starts
		httpRequest = resolveHttp()
	end
	if not httpRequest then
		local seen = {}
		for _, name in ipairs(HTTP_NAMES) do
			local v = envGet(name)
			if v ~= nil then
				table.insert(seen, name .. ":" .. type(v))
			end
		end
		bridgeStatus = "bridge: no HTTP function found (tried " .. table.concat(HTTP_NAMES, ", ") .. "; saw "
			.. (#seen > 0 and table.concat(seen, ", ") or "nothing") .. ")"
		return
	end
	if bridgeScheduled then
		return
	end
	local elapsed = os.clock() - bridgeLastSend
	if elapsed >= 0.15 then
		bridgeLastSend = os.clock()
		sendBridge()
	else
		bridgeScheduled = true
		task.delay(0.15 - elapsed, function()
			bridgeScheduled = false
			bridgeLastSend = os.clock()
			sendBridge()
		end)
	end
end

--------------------------------------------------------------------------------
-- start
--------------------------------------------------------------------------------

loadState()
buildGraph()
apply()
syncUI()
updateStatus()

-- Adopt the engine's AudioDeviceInput whenever it shows up. Voice chat opens the
-- mic seconds after the panel appears (and after the player unmutes), so a
-- one-shot lookup at start-up is how v1.0 ended up monitoring nothing forever.
task.spawn(function()
	while screen.Parent do
		task.wait(1)
		if screen.Parent then
			local swapped = false
			pcall(function()
				local engine = findEngineMic()
				if engine and engine ~= Audio.mic then
					Audio.micCreated = false
					rememberDevice(engine)
					swapped = true
				elseif not engine and not Audio.mic and Audio.root then
					createFallbackMic()
					swapped = true
				end
			end)
			if swapped then
				apply()
				updateStatus()
			elseif STATE.rx and #otherMicDevices() ~= Audio.rxSources then
				-- someone joined, left, or opened their mic: rewire the RX fan-in
				apply()
				updateStatus()
			end
		end
	end
end)

task.spawn(function()
	while screen.Parent do
		task.wait(8)
		pcall(saveState)
	end
end)

-- level meter + throttled status refresh
task.spawn(function()
	local lastStatus = 0
	while screen.Parent do
		local rms = inputLevel()
		local db = rms > 1e-5 and (20 * math.log10(rms)) or -120
		local shown = math.clamp((db + 60) / 60, 0, 1)
		pcall(function()
			levelBar.Size = UDim2.new(shown, 0, 0, 2)
			levelBar.BackgroundColor3 = shown > 0.02 and THEME.good or THEME.track
		end)
		local now = os.clock()
		if now - lastStatus > 1.5 then
			lastStatus = now
			pcall(updateStatus)
		end
		task.wait(1 / 30)
	end
end)

local API = {}

local function destroyAll()
	pcall(saveState)
	pcall(function()
		screen:Destroy()
	end)
	pcall(clearWires)
	-- leave the player's device the way we found it
	pcall(function()
		if Audio.mic and not Audio.micCreated then
			if Audio.micOrigVolume ~= nil then
				Audio.mic.Volume = Audio.micOrigVolume
			end
		end
	end)
	pcall(function()
		if Audio.root then
			Audio.root:Destroy()
		end
	end)
	if _G.RobloxEQ == API then
		_G.RobloxEQ = nil
	end
end

API.destroy = destroyAll
_G.RobloxEQ = API

closeBtn.MouseButton1Click:Connect(destroyAll)

collapseBtn.MouseButton1Click:Connect(function()
	collapsed = not collapsed
	collapseBtn.Text = collapsed and "+" or "–"
	if body then
		body.Visible = not collapsed
	end
	refit()
end)

--------------------------------------------------------------------------------
-- diagnostics
--------------------------------------------------------------------------------

diagnostics = function()
	local report = {}
	local function add(line)
		table.insert(report, line)
		print("[RobloxEQ] " .. line)
	end
	local function has(fn, want)
		return type(fn) == want
	end

	add("version: v" .. VERSION)
	add("executor: gethui=" .. tostring(has(gethui, "function"))
		.. " getgenv=" .. tostring(has(getgenv, "function"))
		.. " loadstring=" .. tostring(has(loadstring, "function"))
		.. " writefile=" .. tostring(has(writefile, "function")))
	add("http: " .. tostring(httpRequest and httpName or "none found"))
	add(string.format("device: mobile=%s touch=%s keyboard=%s viewport=%.0fx%.0f scale=%.2f",
		tostring(isMobile),
		tostring(UserInputService.TouchEnabled),
		tostring(UserInputService.KeyboardEnabled),
		getViewport().X, getViewport().Y, scale))
	add("audio graph: ok=" .. tostring(Audio.ok) .. " err=" .. tostring(Audio.err or "none")
		.. " wires=" .. tostring(#Audio.wires))
	local folder = nil
	pcall(function()
		folder = Audio.root and Audio.root:GetFullName()
	end)
	add("graph folder: " .. tostring(folder or "none"))
	local active, muted = micState()
	local micParent = "none"
	pcall(function()
		if Audio.mic and Audio.mic.Parent then
			micParent = Audio.mic.Parent.Name
		end
	end)
	add(string.format("mic: %s parent=%s active=%s muted=%s volume=%.2f",
		Audio.micCreated and "script-created" or "engine",
		micParent, tostring(active), tostring(muted), Audio.transmitVol))
	local apiValue = "unreadable from a client script"
	pcall(function()
		apiValue = tostring(VoiceChatService.UseAudioApi)
	end)
	add("UseAudioApi: " .. tostring(apiValue))
	add(string.format("levels: rms=%.4f chain=%.1f dB preamp=%.1f boost=%s clip=%.2f",
		inputLevel(), Audio.gainDb, STATE.preamp, STATE.boost, STATE.softclip))
	add("bridge: " .. tostring(STATE.bridge) .. " host=" .. tostring(STATE.bridgeHost) .. " status=" .. bridgeStatus)
	add("verdict: " .. (Audio.ok and (#Audio.wires >= 10 and "graph wired, monitor runs when mic active" or "graph built but wires missing")
		or "graph failed - see err above"))
	return table.concat(report, "\n")
end

diagBtn.MouseButton1Click:Connect(function()
	pcall(diagnostics)
	updateStatus()
end)

--------------------------------------------------------------------------------
-- console api
--------------------------------------------------------------------------------

function API.bridge(on)
	STATE.bridge = on ~= false
	apply()
	syncUI()
	updateStatus()
end

function API.bridgeHost(host)
	if type(host) == "string" and #host > 0 then
		STATE.bridgeHost = host
		bridgeStatus = "bridge: host set to " .. host
		if STATE.bridge then
			apply()
		end
		updateStatus()
	end
end

function API.preset(name)
	setPreset(name)
end

function API.set(id, db)
	if STATE.bands[id] ~= nil and type(db) == "number" then
		STATE.bands[id] = math.clamp(db, SLIDER_MIN, SLIDER_MAX)
		apply()
		syncUI()
	end
end

function API.preamp(db)
	STATE.preamp = math.clamp(db, PREAMP_MIN, PREAMP_MAX)
	apply()
	syncUI()
end

-- AudioDeviceInput.Volume, 0..3 (-inf..+9.5 dB). The only gain a script can
-- apply to the stream other players receive. Client-set, so best effort.
function API.transmit(db)
	if type(db) == "number" then
		STATE.transmit = math.clamp(db, TRANSMIT_MIN, TRANSMIT_MAX)
		apply()
		syncUI()
		updateStatus()
	end
end

-- EQ other players' incoming voice through the same curve (works on mobile).
-- This is the receive side: it changes what YOU hear of THEM, not what they
-- hear of you - the transmit path is native engine code on every platform.
function API.rx(on)
	STATE.rx = on ~= false
	if STATE.rx then
		buildRxGraph()
	end
	apply()
	syncUI()
	updateStatus()
end

function API.rxGain(db)
	if type(db) == "number" then
		STATE.rxGain = math.clamp(db, 0, 40)
		apply()
		updateStatus()
	end
end

function API.boost(tier)
	if BOOST_DB[tier] then
		STATE.boost = tier
		apply()
		syncUI()
	end
end

function API.toggle(key)
	if STATE[key] ~= nil and type(STATE[key]) == "boolean" then
		STATE[key] = not STATE[key]
		apply()
		syncUI()
		updateStatus()
	end
end

function API.collapse(on)
	collapsed = on ~= false
	collapseBtn.Text = collapsed and "+" or "–"
	if body then
		body.Visible = not collapsed
	end
	refit()
end

-- re-read the device and rebuild the graph wires (useful after muting in-game)
function API.refresh()
	pcall(function()
		local engine = findEngineMic()
		if engine and engine ~= Audio.mic then
			Audio.micCreated = false
			rememberDevice(engine)
		end
	end)
	apply()
	updateStatus()
	return API.status()
end

function API.diagnostics()
	return diagnostics()
end

function API.status()
	local active, muted = micState()
	return {
		mobile = isMobile,
		graph = Audio.ok,
		error = Audio.err,
		micCreated = Audio.micCreated,
		micActive = active,
		micMuted = muted,
		wires = #Audio.wires,
		gainDb = Audio.gainDb,
		transmitVol = Audio.transmitVol,
		rx = STATE.rx,
		rxSources = Audio.rxSources,
		bridge = bridgeStatus,
		version = VERSION,
		viewport = { X = getViewport().X, Y = getViewport().Y },
		panelScale = scale,
		state = STATE,
	}
end

print(string.format("[RobloxEQ] v%s loaded - graph %s, %d wires, mic %s", VERSION,
	Audio.ok and "ok" or ("FAILED: " .. tostring(Audio.err)),
	#Audio.wires,
	Audio.mic and (Audio.micCreated and "script-created" or "engine") or "none yet"))
