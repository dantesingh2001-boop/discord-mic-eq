--!nocheck
--[[
	RobloxEQ diagnose - paste this when the panel does not appear or does nothing.

		loadstring(game:HttpGet("https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/diagnose.lua"))()

	Prints one report. Nothing is changed, no instances are left behind.
]]

local lines = {}
local function add(s)
	table.insert(lines, tostring(s))
end

local Players = game:GetService("Players")
local lp = Players.LocalPlayer
local ok0, err0 = pcall(function()
	game:GetService("HttpService")
end)
add("== executor ==")
add("HttpService reachable: " .. tostring(ok0))

local function probe(name)
	local direct
	local okd, vd = pcall(function()
		return _G[name]
	end)
	if okd and vd ~= nil then
		direct = type(vd)
	end
	local fn
	local okf, vf = pcall(function()
		return loadstring("return " .. name)()
	end)
	local viaLs = (okf and vf ~= nil) and type(vf) or "nil"
	add(string.format("%-14s _G=%s  loadstring=%s", name, tostring(direct or "nil"), viaLs))
	return (okf and vf) or vd
end

add("loadstring: " .. tostring(type(loadstring)))
add("gethui: " .. tostring(type(gethui)))
add("getgenv: " .. tostring(type(getgenv)))
add("writefile: " .. tostring(type(writefile)))
local httpFn = nil
local httpName = nil
for _, name in ipairs({ "request", "http_request", "http", "syn", "fluxus", "krnl", "delta" }) do
	local v = probe(name)
	if type(v) == "function" and not httpFn then
		httpFn, httpName = v, name
	elseif type(v) == "table" and type(v.request) == "function" and not httpFn then
		httpFn, httpName = function(o) return v.request(o) end, name .. ".request"
	end
end
add("http for bridge: " .. tostring(httpName))

add("")
add("== download ==")
local url = "https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/RobloxEQ.lua"
local okG, body = pcall(function()
	return game:HttpGet(url, true)
end)
if okG and type(body) == "string" then
	add("game:HttpGet OK, " .. #body .. " bytes, has RobloxEQ: " .. tostring(string.find(body, "RobloxEQ", 1, true) ~= nil))
else
	add("game:HttpGet FAILED: " .. tostring(body))
end

add("")
add("== audio api ==")
local classOk = {}
for _, class in ipairs({ "AudioDeviceInput", "AudioDeviceOutput", "AudioEqualizer", "AudioFader", "AudioLimiter", "AudioDistortion", "AudioCompressor", "AudioAnalyzer", "Wire" }) do
	local ok, inst = pcall(Instance.new, class)
	classOk[class] = ok
	if ok then
		pcall(function()
			inst:Destroy()
		end)
	end
end
add("classes creatable: " .. tostring(classOk.AudioDeviceInput) .. " / eq " .. tostring(classOk.AudioEqualizer) .. " / fader " .. tostring(classOk.AudioFader) .. " / limiter " .. tostring(classOk.AudioLimiter))

local eqOk = pcall(function()
	local eq = Instance.new("AudioEqualizer")
	eq.MidRange = NumberRange.new(200, 400)
	eq.LowGain = 3
	local r = eq.MidRange
	local low = r.Min
	eq:Destroy()
	return low
end)
add("crossover floor accepted: " .. tostring(eqOk))

local vcs = game:GetService("VoiceChatService")
local okApi, api = pcall(function()
	return vcs.UseAudioApi
end)
add("UseAudioApi readable: " .. tostring(okApi) .. " value=" .. (okApi and tostring(api) or "blocked from client scripts"))

add("")
add("== microphone ==")
local mic = lp:FindFirstChildOfClass("AudioDeviceInput")
add("mic under LocalPlayer: " .. tostring(mic))
local vcsMic = nil
pcall(function()
	vcsMic = game:GetService("VoiceChatService"):FindFirstChildOfClass("AudioDeviceInput")
end)
add("mic under VoiceChatService: " .. tostring(vcsMic))
mic = mic or vcsMic
if mic then
	local a = nil
	pcall(function()
		a = mic.Active
	end)
	local m = nil
	pcall(function()
		m = mic.Muted
	end)
	add("mic Active=" .. tostring(a) .. " Muted=" .. tostring(m))
	local v = nil
	pcall(function()
		v = mic.Volume
	end)
	add("mic Volume=" .. tostring(v) .. " (0..3 - the only stream gain a script has)")
end

add("")
add("== screen ==")
local cam = workspace.CurrentCamera
add("viewport: " .. tostring(cam and cam.ViewportSize))
add("touch only (mobile): " .. tostring(game:GetService("UserInputService").TouchEnabled and not game:GetService("UserInputService").KeyboardEnabled))

add("")
add("== verdict ==")
if not classOk.AudioEqualizer then
	add("X this Roblox build has no Audio API classes - the graph cannot be built at all")
elseif not mic and not okApi then
	add("! no mic node and UseAudioApi unreadable: the experience has not enabled microphones")
end
if mic and mic.Active == false then
	add("! mic is inactive, so the monitor will be silent (needs microphone-enabled experience + voice)")
end
if not httpFn then
	add("! no executor HTTP function: the BRIDGE toggle cannot reach the daemon (monitor + panel still work)")
end
if game:GetService("UserInputService").TouchEnabled and not game:GetService("UserInputService").KeyboardEnabled then
	add("i mobile: panel + monitor only, no transmit EQ path exists on mobile")
end

for _, line in ipairs(lines) do
	print("[diag] " .. line)
end
return table.concat(lines, "\n")
