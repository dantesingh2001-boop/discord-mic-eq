--!nocheck
--[[
	RobloxEQ v1.0
	Client-side equalizer for Roblox's Audio API (executor / client script).

	Graph:  AudioDeviceInput -> EQ1 -> EQ2 -> EQ3 -> Fader x4 -> Distortion
	        -> Compressor -> Limiter -> AudioDeviceOutput

	Honest scope:
	  * This builds a REAL audio graph with REAL Roblox filter instances.
	  * It processes your microphone and plays the result LOCALLY (monitor).
	  * It cannot change what other players hear. Their copy of your voice is
	    encoded by Roblox's native voice engine from the OS input device, before
	    any Luau graph exists. For that, EQ the mic at the OS level and select
	    the virtual device in Roblox settings. See roblox/README.md.

	Requirements: the experience must allow microphone input
	(Experience Settings -> Communication -> Enable Microphone) and
	VoiceChatService.UseAudioApi must be Enabled, otherwise the mic node
	produces no stream and the monitor stays silent. The script says so in
	the status panel instead of pretending.

	Commands (typed in the executor console while it runs):
	  RobloxEQ.preset("Broadcast")
	  RobloxEQ.set("bass", 6)
	  RobloxEQ.destroy()
]]

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local HttpService = game:GetService("HttpService")
local VoiceChatService = game:GetService("VoiceChatService")
local RunService = game:GetService("RunService")

local player = Players.LocalPlayer
if not player then
	return
end

local isMobile = false
pcall(function()
	isMobile = UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled
end)

local CONFIG_FILE = "RobloxEQ.json"
local BRIDGE_URL = "http://127.0.0.1:7331/eq"

--------------------------------------------------------------------------------
-- band model
--
-- Three AudioEqualizer instances run in series. Each has Low/Mid/High gain
-- (-80..+10 dB) split by its MidRange crossover points, so the chain behaves
-- like a serial shelving EQ. One slider per property keeps it predictable.
--------------------------------------------------------------------------------

local CROSSOVERS = {
	{ 120, 400 },
	{ 900, 2600 },
	{ 5500, 11000 },
}

-- id, label, eq node (1-3), property, center frequency for the curve
local BANDS = {
	{ id = "sub",        label = "SUB",   node = 1, prop = "LowGain",  freq = 60 },
	{ id = "bass",       label = "BASS",  node = 1, prop = "MidGain",  freq = 200 },
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

local STATE = {
	bands = {},
	preamp = 6,
	boost = "off",
	softclip = 0,
	limiter = true,
	monitor = true,
	muteMic = false,
	bridge = false,
	preset = "Loud + Clear",
}

-- assigned further down; apply() is called before the bridge code exists
local pushBridge = function() end

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
}

local function dbToVol(db)
	return math.clamp(10 ^ (db / 20), 0, 10)
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
-- on/off, limiter bypass, soft clip on/off). Cheap, and it keeps the graph
-- identical to the one drawn in the panel.
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
end

-- pushes STATE into the filter instances
local function apply()
	if Audio.mic then
		pcall(function()
			Audio.mic.Muted = STATE.muteMic
		end)
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

	rebuildWires()
	pushBridge()
end

local function buildGraph()
	local ok, err = pcall(function()
		local root = Instance.new("Folder")
		root.Name = "RobloxEQ_Audio"
		root.Parent = workspace
		Audio.root = root

		-- mic: reuse the one Roblox core scripts put under the Player
		local mic = player:FindFirstChildOfClass("AudioDeviceInput")
		if not mic then
			local created = Instance.new("AudioDeviceInput")
			created.Player = player
			pcall(function()
				created.Volume = 1
			end)
			created.Parent = root
			mic = created
			Audio.micCreated = true
		end
		Audio.mic = mic

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
	clipSlider = nil,
}
local syncUI
local setPreset
local updateStatus
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

local screen = Instance.new("ScreenGui")
screen.Name = "RobloxEQ"
screen.ResetOnSpawn = false
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screen.DisplayOrder = 500
screen.Parent = getGui()

local main = make("Frame", {
	Name = "Main",
	Size = UDim2.fromOffset(384, 548),
	Position = UDim2.new(0.5, -192, 0, 36),
	BackgroundColor3 = THEME.bg,
	BorderSizePixel = 0,
}, screen)
corner(main, 8)
stroke(main, THEME.stroke, 1, 0.15)

local titleBar = make("Frame", {
	Size = UDim2.new(1, 0, 0, 30),
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
}, main)
corner(titleBar, 8)

local titleText = label(titleBar, "MIC EQ", 13, THEME.text, FONT_BOLD)
titleText.Size = UDim2.fromOffset(70, 30)
titleText.Position = UDim2.fromOffset(10, 0)

local subtitle = label(titleBar, "ROBLOX AUDIO API  ·  LOCAL MONITOR", 8, THEME.dim, FONT)
subtitle.Size = UDim2.new(1, -110, 1, 0)
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

local body = make("Frame", {
	Size = UDim2.new(1, -20, 1, -40),
	Position = UDim2.fromOffset(10, 36),
	BackgroundTransparency = 1,
}, main)
make("UIListLayout", {
	Padding = UDim.new(0, 6),
	SortOrder = Enum.SortOrder.LayoutOrder,
}, body)

--------------------------------------------------------------------------------
-- graph
--------------------------------------------------------------------------------

local graphRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 62),
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
		Size = UDim2.fromOffset(36, 168),
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
	local wrap = make("Frame", {
		Size = UDim2.new(1, 0, 0, opts.height or 20),
		BackgroundTransparency = 1,
	}, parent)

	local leftPad = opts.labelWidth or 52

	local track = make("Frame", {
		Size = UDim2.new(1, -leftPad - 36, 0, 6),
		Position = UDim2.fromOffset(leftPad, math.floor(((opts.height or 20) - 6) / 2)),
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
	Size = UDim2.new(1, 0, 0, 24),
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
-- preamp + boost
--------------------------------------------------------------------------------

local preampRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 20),
	BackgroundTransparency = 1,
	LayoutOrder = 3,
}, body)
local preampLabel = label(preampRow, "PREAMP", 9, THEME.dim, FONT)
preampLabel.Size = UDim2.fromOffset(52, 20)

UI.preampSlider = makeHorizontalSlider(preampRow, {
	min = PREAMP_MIN,
	max = PREAMP_MAX,
	value = STATE.preamp,
	labelWidth = 52,
	height = 20,
	format = function(v)
		return string.format("%+.1f", v)
	end,
	onChange = function(v)
		STATE.preamp = v
		apply()
		updateStatus()
	end,
})

local boostRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 22),
	BackgroundTransparency = 1,
	LayoutOrder = 4,
}, body)
local boostLabel = label(boostRow, "BOOST", 9, THEME.dim, FONT)
boostLabel.Size = UDim2.fromOffset(52, 22)

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
UI.totalLabel.Size = UDim2.fromOffset(46, 22)
UI.totalLabel.Position = UDim2.fromOffset(318, 0)

--------------------------------------------------------------------------------
-- bands
--------------------------------------------------------------------------------

local bandRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 168),
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
	Size = UDim2.new(1, 0, 0, 22),
	BackgroundTransparency = 1,
	LayoutOrder = 6,
}, body)
local clipLabel = label(clipRow, "SOFT CLIP", 9, THEME.dim, FONT)
clipLabel.Size = UDim2.fromOffset(56, 22)

UI.clipSlider = makeHorizontalSlider(clipRow, {
	min = 0,
	max = 1,
	value = STATE.softclip,
	labelWidth = 56,
	height = 22,
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
	Size = UDim2.new(1, 0, 0, 22),
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

local toggleIndex = 0
local function toggleButton(parent, text, width, key, onChange)
	local btn = chipButton(parent, text, width, toggleIndex * (width + 4), function()
		STATE[key] = not STATE[key]
		paintToggle(key)
		onChange()
	end)
	toggleButtons[key] = btn
	toggleIndex = toggleIndex + 1
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
toggleButton(toggleRow, "BRIDGE", 66, "bridge", function()
	apply()
	updateStatus()
end)

--------------------------------------------------------------------------------
-- status + footer
--------------------------------------------------------------------------------

local statusRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 86),
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
footer.Size = UDim2.new(1, 0, 0, 12)
footer.LayoutOrder = 9

local function makeDraggable(handle, target)
	local dragging, dragStart, startPos
	handle.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = true
			dragStart = input.Position
			startPos = target.Position
		end
	end)
	UserInputService.InputChanged:Connect(function(input)
		if not dragging then
			return
		end
		if input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch then
			local delta = input.Position - dragStart
			target.Position = UDim2.new(
				startPos.X.Scale,
				startPos.X.Offset + delta.X,
				startPos.Y.Scale,
				startPos.Y.Offset + delta.Y
			)
		end
	end)
	UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = false
		end
	end)
end

makeDraggable(titleBar, main)

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

updateStatus = function()
	local lines = {}

	if not Audio.ok then
		table.insert(lines, "x audio graph failed: " .. tostring(Audio.err))
	else
		local mic = Audio.mic
		if mic then
			local active = "?"
			pcall(function()
				active = tostring(mic.Active)
			end)
			table.insert(lines, string.format(
				"mic: %s | active=%s | muted=%s",
				Audio.micCreated and "created by script" or "game-provided",
				active,
				tostring(STATE.muteMic)
			))
		end
	end

	local api = "unknown"
	pcall(function()
		api = tostring(VoiceChatService.UseAudioApi)
	end)
	table.insert(lines, "UseAudioApi: " .. api)

	local out = "none"
	pcall(function()
		if Audio.output then
			out = Audio.output.Name
		end
	end)
	table.insert(lines, string.format("monitor wiring: %s | limiter: %s | wires: %d",
		STATE.monitor and out or "unwired",
		STATE.limiter and "on" or "bypassed",
		#Audio.wires))

	local total = (STATE.preamp or 0) + (BOOST_DB[STATE.boost] or 0)
	table.insert(lines, string.format("total gain: %+.1f dB (API cap: fader +20 dB, eq +10 dB/band)", total))

	if Audio.mic then
		local active = false
		pcall(function()
			active = Audio.mic.Active == true
		end)
		if not active then
			table.insert(lines, "! mic inactive: enable microphones in this experience and set VoiceChatService.UseAudioApi = Enabled, or the monitor stays silent")
		end
	end
	table.insert(lines, "monitor is LOCAL. others hear your OS input device, not this.")

	if isMobile then
		table.insert(lines, "mobile: no transmit EQ path exists - the bridge/APO chain is desktop-only")
	end

	if Audio.analyzer then
		local rms = 0
		pcall(function()
			rms = Audio.analyzer.RmsLevel or 0
		end)
		local db = rms > 0 and 20 * math.log10(rms) or -80
		table.insert(lines, string.format("input level: %.1f dBFS %s", db,
			rms < 0.0005 and "(silent - check the mic or the experience's mic permission)" or ""))
	end

	table.insert(lines, bridgeStatus)

	statusLabel.Text = table.concat(lines, "\n")
	if not Audio.ok then
		statusLabel.TextColor3 = THEME.bad
	elseif Audio.mic and Audio.mic.Active then
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
--------------------------------------------------------------------------------

local function resolveHttp()
	for _, name in ipairs({ "request", "http_request", "http", "syn", "fluxus" }) do
		local fn = rawget(_G, name)
		if type(fn) == "function" then
			return fn
		elseif type(fn) == "table" and type(fn.request) == "function" then
			return function(options)
				return fn.request(options)
			end
		end
	end
	return nil
end

local httpRequest = resolveHttp()
local bridgeScheduled = false
local bridgeLastSend = 0

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
		Url = BRIDGE_URL,
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
	bridgeStatus = "bridge: HTTP " .. tostring(code or "?") .. " - other players get this curve"
end

pushBridge = function()
	if not STATE.bridge then
		return
	end
	if not httpRequest then
		bridgeStatus = "bridge: no request() in this executor - use syn.request / http_request"
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
		local rms = 0
		if Audio.analyzer then
			pcall(function()
				rms = Audio.analyzer.RmsLevel or 0
			end)
		end
		local shown = math.clamp(math.sqrt(rms) * 1.8, 0, 1)
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

local function destroyAll()
	pcall(saveState)
	pcall(function()
		screen:Destroy()
	end)
	pcall(clearWires)
	pcall(function()
		if Audio.root then
			Audio.root:Destroy()
		end
	end)
	if _G.RobloxEQ then
		_G.RobloxEQ = nil
	end
end

closeBtn.MouseButton1Click:Connect(destroyAll)

--------------------------------------------------------------------------------
-- console api
--------------------------------------------------------------------------------

local API = {}

function API.bridge(on)
	STATE.bridge = on ~= false
	apply()
	syncUI()
	updateStatus()
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

function API.status()
	return {
		mobile = isMobile,
		graph = Audio.ok,
		error = Audio.err,
		micCreated = Audio.micCreated,
		wires = #Audio.wires,
		state = STATE,
	}
end

API.destroy = destroyAll

_G.RobloxEQ = API
print("[RobloxEQ] loaded - monitor " .. (Audio.ok and "running" or ("FAILED: " .. tostring(Audio.err))))
