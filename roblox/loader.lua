--!nocheck
--[[
	RobloxEQ loader - one line to paste:

		loadstring(game:HttpGet("https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/loader.lua"))()

	Fetches RobloxEQ.lua from the repo, falls back to the jsDelivr mirror if raw
	GitHub is blocked, and says so plainly when it cannot download.

	Works on desktop and mobile executors. On mobile the panel still builds and
	the level meter still reads your mic, but nothing can EQ your voice for other
	players - see roblox/README.md.
]]

local PRIMARY = "https://raw.githubusercontent.com/dantesingh2001-boop/discord-mic-eq/main/roblox/RobloxEQ.lua"
local MIRROR = "https://cdn.jsdelivr.net/gh/dantesingh2001-boop/discord-mic-eq@main/roblox/RobloxEQ.lua"

local function fetch(url)
	local ok, body = pcall(function()
		return game:HttpGet(url, true)
	end)
	if ok and type(body) == "string" and #body > 2000 and string.find(body, "RobloxEQ", 1, true) then
		return body
	end
	return nil
end

local source, used = fetch(PRIMARY), PRIMARY
if not source then
	source, used = fetch(MIRROR), MIRROR
end

if not source then
	warn("[RobloxEQ] download failed. Check the repo URL in a browser, or copy RobloxEQ.lua locally.")
	return
end

local chunk, err = loadstring(source, "RobloxEQ")
if not chunk then
	warn("[RobloxEQ] downloaded file did not compile: " .. tostring(err))
	return
end

local ok, runErr = pcall(chunk)
if not ok then
	warn("[RobloxEQ] script error: " .. tostring(runErr))
	return
end

print("[RobloxEQ] loaded from " .. used)
