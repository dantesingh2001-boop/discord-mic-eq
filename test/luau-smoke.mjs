// Runs roblox/RobloxEQ.lua against stubbed Roblox APIs (test/stubs.lua) and
// checks the audio graph + gain math.  node test/luau-smoke.mjs
import fs from 'node:fs';
import { lua, lauxlib, lualib, to_luastring } from 'fengari';

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function run(name, src) {
	const status = lauxlib.luaL_loadstring(L, to_luastring(src));
	if (status !== 0) {
		throw new Error(`${name}: load failed: ${lua.lua_tojsstring(L, -1)}`);
	}
	const res = lua.lua_pcall(L, 0, 0, 0);
	if (res !== 0) {
		throw new Error(`${name}: runtime error: ${lua.lua_tojsstring(L, -1)}`);
	}
}

const stubs = fs.readFileSync(new URL('./stubs.lua', import.meta.url), 'utf8');
const target = fs.readFileSync(new URL('../roblox/RobloxEQ.lua', import.meta.url), 'utf8');

run('stubs.lua', stubs);
run('RobloxEQ.lua', target);

const asserts = `
local eq = _G.RobloxEQ
local results = {}

local function check(label, ok, detail)
	results[#results + 1] = (ok and "PASS  " or "FAIL  ") .. label .. (detail and ("  [" .. tostring(detail) .. "]") or "")
end

local function alive(class)
	local list = {}
	for _, inst in ipairs(ALL) do
		if inst.ClassName == class and inst.Destroyed == nil then
			list[#list + 1] = inst
		end
	end
	return list
end

local status = eq.status()
check("audio graph built", status.graph == true, status.error)
check("3 x AudioEqualizer", #alive("AudioEqualizer") == 3, #alive("AudioEqualizer"))
check("4 x AudioFader", #alive("AudioFader") == 4, #alive("AudioFader"))
check("1 x AudioLimiter", #alive("AudioLimiter") == 1)
check("1 x AudioDistortion", #alive("AudioDistortion") == 1)
check("1 x AudioDeviceOutput", #alive("AudioDeviceOutput") == 1)
check("1 x AudioAnalyzer (level tap)", #alive("AudioAnalyzer") == 1)

local wires = alive("Wire")
check("chain wired (11 wires = tap + 10 links, soft clip off)", #wires == 11, #wires)
check("chain starts at the mic", wires[1] and wires[1].SourceInstance.ClassName == "AudioDeviceInput",
	tostring(wires[1] and wires[1].SourceInstance.ClassName))
local micFeeds = 0
for _, w in ipairs(wires) do
	if w.SourceInstance and w.SourceInstance.ClassName == "AudioDeviceInput" then
		micFeeds = micFeeds + 1
	end
end
check("mic feeds both the tap and the chain (2)", micFeeds == 2, micFeeds)

-- crossover wiring: three series shelves at the documented points
local eqs = alive("AudioEqualizer")
check("crossover 1 = 200/400 (engine floor)", eqs[1].MidRange.Min == 200 and eqs[1].MidRange.Max == 400)
check("crossover 2 = 900/2600", eqs[2].MidRange.Min == 900 and eqs[2].MidRange.Max == 2600)
check("crossover 3 = 5500/11000", eqs[3].MidRange.Min == 5500 and eqs[3].MidRange.Max == 11000)

-- presets land on the filter instances, not just in a table
for _, name in ipairs({ "Loud + Clear", "Broadcast", "Deep Radio", "Clarity Max", "Warm Bass Voice", "Loudest Natty" }) do
	local ok, err = pcall(function() eq.preset(name) end)
	check("preset " .. name, ok, err)
end

eq.preset("Warm Bass Voice")
eqs = alive("AudioEqualizer")
check("preset -> EQ1.LowGain = sub (8)", eqs[1].LowGain == 8, eqs[1].LowGain)
check("preset -> EQ1.MidGain = bass (7)", eqs[1].MidGain == 7, eqs[1].MidGain)
check("preset -> EQ1.HighGain = lowmid (4)", eqs[1].HighGain == 4, eqs[1].HighGain)

-- soft clip inserts a real node into the chain
eq.preset("Loudest Natty")
check("soft clip adds a node", #alive("Wire") == 12, #alive("Wire"))
check("distortion level = preset 0.35", math.abs(alive("AudioDistortion")[1].Level - 0.35) < 1e-6,
	alive("AudioDistortion")[1].Level)

local function faderDb()
	local total = 0
	for _, f in ipairs(alive("AudioFader")) do
		if f.Volume and f.Volume > 0 then
			total = total + 20 * math.log(f.Volume, 10)
		end
	end
	return total
end

eq.preset("Loud + Clear")
eq.set("bass", 0)
eq.preamp(20)
eq.boost("off")
check("preamp +20 dB reaches the faders", math.abs(faderDb() - 20) < 0.05, faderDb())

eq.boost("1k")
check("1k boost = +60 dB total on preamp 0", math.abs(faderDb() - 80) < 0.05, faderDb())

eq.preamp(0)
check("1k boost alone = +60 dB across chained faders", math.abs(faderDb() - 60) < 0.05, faderDb())

eq.boost("10k")
check("10k boost = +80 dB (4 faders x +20)", math.abs(faderDb() - 80) < 0.05, faderDb())

-- clamping matches the engine ranges, not just our slider
eq.set("air", 99)
eqs = alive("AudioEqualizer")
check("band gain clamped to +10 dB", eqs[3].HighGain == 10 and eq.status().state.bands.air == 10, eqs[3].HighGain)
eq.set("sub", -999)
check("band gain clamped to -24 dB (slider floor)", alive("AudioEqualizer")[1].LowGain == -24,
	alive("AudioEqualizer")[1].LowGain)

-- toggles
eq.toggle("muteMic")
check("mute writes AudioDeviceInput.Muted", TEST_PLAYER:FindFirstChildOfClass("AudioDeviceInput").Muted == true)
eq.toggle("muteMic")

eq.toggle("monitor")
check("monitor off unwires output", #alive("Wire") == 10, #alive("Wire"))
eq.toggle("monitor")
check("monitor on rewires output", #alive("Wire") == 11, #alive("Wire"))

eq.toggle("limiter")
check("limiter bypass drops a node", #alive("Wire") == 10, #alive("Wire"))
eq.toggle("limiter")

-- bridge: the executor HTTP path must be found and must carry the curve
local postsBefore = #POSTS
eq.toggle("bridge")
eq.preamp(9)
local posts = POSTS
check("bridge posts when enabled", #posts >= 1, #posts)
local last = posts[#posts]
check("bridge posts to the loopback URL", last and last.Url and last.Url:find("7311") == nil and last.Url:find("127.0.0.1") ~= nil, last and last.Url)
check("bridge sends POST", last and last.Method == "POST", last and last.Method)
check("bridge body carries the preamp", last and last.Body and last.Body:find("preamp", 1, true) ~= nil, last and last.Body and #last.Body)
eq.toggle("bridge")
local afterOff = #POSTS
eq.preamp(3)
check("bridge stays quiet when off", #POSTS == afterOff, #POSTS - afterOff)

-- level tap drives the meter path without errors
local analyzer = alive("AudioAnalyzer")[1]
analyzer.RmsLevel = 0.25
check("analyzer exposes RmsLevel", analyzer.RmsLevel == 0.25)
local spawnErrors = 0
for _, line in ipairs(OUT) do
	if string.find(line, "spawn error", 1, true) then
		spawnErrors = spawnErrors + 1
	end
end
check("no errors in the update loops", spawnErrors == 0, spawnErrors)

-- transmit gain: AudioDeviceInput.Volume 0..3 is the only stream gain a script has
local device = TEST_PLAYER:FindFirstChildOfClass("AudioDeviceInput")
eq.transmit(9.54)
check("transmit +9.5 dB reaches AudioDeviceInput.Volume 3", math.abs(device.Volume - 3) < 0.01, device.Volume)
check("status reports the applied device volume", math.abs(eq.status().transmitVol - 3) < 0.01,
	eq.status().transmitVol)
eq.transmit(-999)
check("transmit floor clamps to -24 dB", math.abs(device.Volume - 0.0631) < 0.002, device.Volume)
eq.transmit(0)
check("transmit 0 dB = unity device volume", math.abs(device.Volume - 1) < 1e-6, device.Volume)

-- the chain gain readout must be what the faders accepted, not what we asked for
eq.preset("Loudest Natty")
local reported = eq.status().gainDb
local measured = faderDb()
check("status gainDb matches the faders", math.abs(reported - measured) < 0.05, reported .. " vs " .. measured)

-- a device that appears after start-up is adopted instead of monitored forever as dead air
check("engine mic adopted at build", eq.status().micCreated == false)
local late = Instance.new("AudioDeviceInput")
late.Volume = 0.5
late.Parent = TEST_PLAYER
device:Destroy()
eq.refresh()
local adopted = false
for _, w in ipairs(alive("Wire")) do
	if w.SourceInstance == late then
		adopted = true
	end
end
check("late engine mic adopted on refresh", adopted, eq.status().wires)
check("wires still complete after the swap", #alive("Wire") == 12, #alive("Wire"))

-- panel geometry is derived, so rows cannot be clipped by a fixed total
local mainFrame, statusFrame
for _, inst in ipairs(ALL) do
	if inst.ClassName == "Frame" and inst.Name == "Main" and inst.Destroyed == nil then
		mainFrame = inst
	end
	if inst.ClassName == "Frame" and inst.LayoutOrder == 8 and inst.Destroyed == nil then
		statusFrame = inst
	end
end
check("panel height derived from the rows", mainFrame and mainFrame.Size.Y.Offset == 540,
	mainFrame and mainFrame.Size.Y.Offset)
check("status box tall enough for its lines", statusFrame and statusFrame.Size.Y.Offset >= 88,
	statusFrame and statusFrame.Size.Y.Offset)

eq.transmit(6)
local beforeTeardown = late.Volume

-- receive side: EQ other players' incoming voice (the only direction a client
-- graph really changes networked voice, and it is platform independent)
local wiresBeforeRx = #alive("Wire")
eq.toggle("rx")
check("rx builds a second 3-band chain", #alive("AudioEqualizer") == 6, #alive("AudioEqualizer"))
check("rx adds its own output and limiter", #alive("AudioDeviceOutput") == 2 and #alive("AudioLimiter") == 2)
check("rx fans every other mic in (1 source + 6 links)", #alive("Wire") == wiresBeforeRx + 7,
	#alive("Wire") - wiresBeforeRx)

local friendDev = TEST_FRIEND:FindFirstChildOfClass("AudioDeviceInput")
local fed = false
for _, w in ipairs(alive("Wire")) do
	if w.SourceInstance == friendDev then
		fed = true
	end
end
check("the friend's mic feeds the rx equalizer", fed)
check("rx reports how many players it is processing", eq.status().rxSources == 1, eq.status().rxSources)

eq.set("air", 4)
local airOnRx = false
for _, inst in ipairs(alive("AudioEqualizer")) do
	if inst.Name == "RX_EQ3" and inst.HighGain == 4 then
		airOnRx = true
	end
end
check("the same band curve reaches the rx chain", airOnRx)

eq.rxGain(20)
local rxDb = 0
for _, f in ipairs(alive("AudioFader")) do
	if tostring(f.Name):find("RX") and f.Volume > 0 then
		rxDb = rxDb + 20 * math.log(f.Volume, 10)
	end
end
check("rx gain spreads across its own faders", math.abs(rxDb - 20) < 0.05, rxDb)

eq.toggle("rx")
check("rx off unwires the receive chain", #alive("Wire") == wiresBeforeRx, #alive("Wire"))
check("rx off keeps the transmit chain intact", #alive("AudioDeviceOutput") == 2)

-- panel geometry, measured on the instances the script actually built:
-- every row must stack inside the body, and every row child must fit its width
local PANEL_W, TITLE_H, BODY_TOP, ROW_PAD = 384, 30, 36, 6
local bodyFrame
for _, inst in ipairs(ALL) do
	if inst.ClassName == "Frame" and inst.Destroyed == nil and inst.Size and inst.Size.Y
		and inst.Size.X.Offset == -20 and inst.Size.Y.Offset == -40 then
		bodyFrame = bodyFrame or inst
	end
end
check("body container found", bodyFrame ~= nil)
local bodyH = 540 * bodyFrame.Size.Y.Scale + bodyFrame.Size.Y.Offset
local rows = {}
for _, inst in ipairs(ALL) do
	if inst.Destroyed == nil and inst.LayoutOrder and inst.Size and inst.Size.Y.Scale == 0
		and inst.Parent == bodyFrame then
		rows[#rows + 1] = inst
	end
end
table.sort(rows, function(a, b) return a.LayoutOrder < b.LayoutOrder end)
local stack = 0
for _, row in ipairs(rows) do
	stack = stack + row.Size.Y.Offset
end
stack = stack + ROW_PAD * (#rows - 1)
check("all 9 rows stacked inside the body", #rows == 9 and stack <= bodyH, stack .. " of " .. bodyH)

local overflow = {}
for _, row in ipairs(rows) do
	local rowW = row.Size.X.Scale * PANEL_W + row.Size.X.Offset
	for _, child in ipairs(row.Children or {}) do
		if child.Size and child.Size.X and child.Position and child.Position.X then
			local cw = child.Size.X.Scale * rowW + child.Size.X.Offset
			local cx = child.Position.X.Scale * rowW + child.Position.X.Offset
			if cx + cw > rowW + 0.01 then
				overflow[#overflow + 1] = tostring(row.LayoutOrder) .. ":" .. tostring(child.ClassName)
			end
		end
	end
end
check("no row child overflows the panel width", #overflow == 0, table.concat(overflow, ","))

-- chips must not overlap each other either: v1.1 laid them out as
-- index*(width+4), which overlapped CLIP GUARD/MONITOR by 6 px
local overlaps = {}
for _, row in ipairs(rows) do
	local rowW = row.Size.X.Scale * PANEL_W + row.Size.X.Offset
	local placed = {}
	for _, child in ipairs(row.Children or {}) do
		if child.Size and child.Size.X and child.Size.X.Scale == 0 and child.Size.Y
			and child.Size.Y.Offset == 22 and child.Position and child.Position.X then
			placed[#placed + 1] = {
				x = child.Position.X.Offset,
				w = child.Size.X.Offset,
				name = tostring(child.Text or child.ClassName),
			}
		end
	end
	table.sort(placed, function(a, b) return a.x < b.x end)
	for i = 2, #placed do
		if placed[i].x < placed[i - 1].x + placed[i - 1].w - 0.01 then
			overlaps[#overlaps + 1] = placed[i - 1].name .. "/" .. placed[i].name
		end
	end
	if placed[#placed] and placed[#placed].x + placed[#placed].w > rowW + 0.01 then
		overlaps[#overlaps + 1] = "row" .. tostring(row.LayoutOrder) .. ":off-end"
	end
end
check("no two chips overlap", #overlaps == 0, table.concat(overlaps, ","))

-- teardown
eq.destroy()
check("destroy restores the device volume the script changed", math.abs(late.Volume - 0.5) < 1e-6,
	beforeTeardown .. " -> " .. tostring(late.Volume))
local leftover = {}
for _, inst in ipairs(ALL) do
	if inst.ClassName == "Wire" and inst.Destroyed == nil then
		leftover[#leftover + 1] = inst
	end
end
check("destroy removes every wire", #leftover == 0, #leftover)

_G.RESULT = table.concat(results, "\\n")
`;

run('asserts', asserts);

lua.lua_getglobal(L, to_luastring('RESULT'));
const out = lua.lua_tojsstring(L, -1);
console.log(out);
const fails = out.split('\n').filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.split('\n').length} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
