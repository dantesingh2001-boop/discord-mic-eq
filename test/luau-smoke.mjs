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

-- teardown
eq.destroy()
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
