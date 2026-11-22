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

-- raw.githubusercontent.com caches hard: after a push it kept serving the
-- previous RobloxEQ.lua for minutes, so a re-run of this loader looked like
-- "the update did nothing". A unique query string is a new cache key, which
-- makes the origin fetch every time.
local function cacheBuster()
	local ok, t = pcall(function()
		return os.time()
	end)
	if ok and type(t) == "number" then
		return "?v=" .. tostring(t)
	end
	return "?v=" .. tostring(os.clock())
end

local function fetch(url)
	local ok, body = pcall(function()
		return game:HttpGet(url .. cacheBuster(), true)
	end)
	if ok and type(body) == "string" and #body > 2000 and string.find(body, "RobloxEQ", 1, true) then
		return body, url
	end
	return nil
end

local source, used = fetch(PRIMARY)
if not source then
	source, used = fetch(MIRROR)
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
