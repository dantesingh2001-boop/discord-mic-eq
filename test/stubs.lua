-- Minimal Roblox API stubs so RobloxEQ.lua can be executed (and its audio graph
-- inspected) outside Roblox. Lua 5.3 via fengari, so Luau helpers are added.

local OUT = {}
_G.OUT = OUT
local realprint = print
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[#parts + 1] = tostring((select(i, ...)))
	end
	OUT[#OUT + 1] = table.concat(parts, " ")
end
warn = print

math.clamp = function(v, lo, hi)
	if v < lo then
		return lo
	elseif v > hi then
		return hi
	end
	return v
end
math.log10 = function(x)
	return math.log(x, 10)
end
table.find = function(t, v)
	for i = 1, #t do
		if t[i] == v then
			return i
		end
	end
	return nil
end

-- datatypes -------------------------------------------------------------------
UDim2 = {
	new = function(xs, xo, ys, yo)
		return { X = { Scale = xs or 0, Offset = xo or 0 }, Y = { Scale = ys or 0, Offset = yo or 0 } }
	end,
	fromOffset = function(x, y)
		return UDim2.new(0, x, 0, y)
	end,
	fromScale = function(x, y)
		return UDim2.new(x, 0, y, 0)
	end,
}
UDim = {
	new = function(s, o)
		return { Scale = s or 0, Offset = o or 0 }
	end,
}
Vector2 = {
	new = function(x, y)
		return { X = x or 0, Y = y or 0 }
	end,
}
Color3 = {
	fromRGB = function(r, g, b)
		return { R = (r or 0) / 255, G = (g or 0) / 255, B = (b or 0) / 255 }
	end,
}
NumberRange = {
	new = function(a, b)
		return { Min = a, Max = b }
	end,
}

Enum = setmetatable({}, {
	__index = function(t, group)
		local g = setmetatable({}, {
			__index = function(_, item)
				return group .. "." .. item
			end,
		})
		rawset(t, group, g)
		return g
	end,
})

-- instances -------------------------------------------------------------------
local ALL = {}
_G.ALL = ALL

function signal()
	local s = { handlers = {} }
	function s:Connect(fn)
		table.insert(self.handlers, fn)
		return { Disconnect = function() end }
	end
	function s:Fire(...)
		for _, fn in ipairs(self.handlers) do
			fn(...)
		end
	end
	return s
end

local SIGNALS = {
	InputBegan = true, InputChanged = true, InputEnded = true,
	MouseButton1Click = true, Changed = true, Destroying = true,
	Activated = true, Animated = true,
}

Instance = {}
function Instance.new(class)
	local props = { ClassName = class, Name = class, Children = {} }
	local inst = {}

	local function childrenOf(parent)
		return props[parent] and props[parent].Children
	end

	setmetatable(inst, {
		__index = function(_, k)
			if props[k] ~= nil then
				return props[k]
			end
			if k == "ClassName" then
				return class
			end
			if k == "IsA" then
				return function(self, c)
					return class == c
				end
			end
			if k == "GetChildren" then
				return function(self)
					local out = {}
					for i, ch in ipairs(props.Children) do
						out[i] = ch
					end
					return out
				end
			end
			if k == "FindFirstChildOfClass" then
				return function(self, c)
					for _, ch in ipairs(props.Children) do
						if ch.ClassName == c then
							return ch
						end
					end
					return nil
				end
			end
			if k == "FindFirstChild" then
				return function(self, n)
					for _, ch in ipairs(props.Children) do
						if ch.Name == n then
							return ch
						end
					end
					return nil
				end
			end
			if k == "WaitForChild" then
				return function(self, n)
					for _, ch in ipairs(props.Children) do
						if ch.Name == n then
							return ch
						end
					end
					return nil
				end
			end
			if k == "Destroy" then
				return function(self)
					props.Destroyed = true
					local p = props.Parent
					if p and type(p) == "table" and p.Children then
						for i, ch in ipairs(p.Children) do
							if ch == inst then
								table.remove(p.Children, i)
								break
							end
						end
					end
				end
			end
			if k == "GetAttribute" then
				return function()
					return nil
				end
			end
			if k == "SetAttribute" then
				return function() end
			end
			if k == "AbsolutePosition" then
				return { X = 100, Y = 100 }
			end
			if k == "AbsoluteSize" then
				return { X = 18, Y = 108 }
			end
			if SIGNALS[k] then
				props[k] = signal()
				return props[k]
			end
			return nil
		end,
		__newindex = function(_, k, v)
			if k == "Parent" then
				local old = props.Parent
				if old and type(old) == "table" and old.Children then
					for i, ch in ipairs(old.Children) do
						if ch == inst then
							table.remove(old.Children, i)
							break
						end
					end
				end
				props.Parent = v
				if v and type(v) == "table" and type(v.Children) == "table" then
					table.insert(v.Children, inst)
				end
				return
			end
			props[k] = v
		end,
	})

	props.Name = class
	table.insert(ALL, inst)
	return inst
end

-- environment -----------------------------------------------------------------
local player = Instance.new("Player")
player.Name = "Tester"
player.DisplayName = "Tester"

local mic = Instance.new("AudioDeviceInput")
mic.Active = true
mic.Muted = false
mic.Parent = player


-- real (small) JSON encoder so the bridge test can inspect what was sent
local function jsonEncode(v)
	local t = type(v)
	local Q = string.char(34)
	local BS = string.char(92)
	if t == "string" then
		return Q .. select(1, v:gsub(Q, BS .. Q)) .. Q
	elseif t == "number" then
		return tostring(v)
	elseif t == "boolean" then
		return tostring(v)
	elseif t == "table" then
		local parts = {}
		for k, val in pairs(v) do
			parts[#parts + 1] = Q .. tostring(k) .. Q .. ":" .. jsonEncode(val)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return "null"
end

POSTS = {}
request = function(options)
	table.insert(POSTS, options)
	return { StatusCode = 200, StatusMessage = "OK", Body = "{}" }
end

-- another player, so the receive-side (RX) chain has a real device to adopt
local otherPlayers = {}
local friend = Instance.new("Player")
friend.Name = "Friend"
local friendMic = Instance.new("AudioDeviceInput")
friendMic.Muted = false
friendMic.Parent = friend
otherPlayers[1] = friend
_G.TEST_FRIEND = friend

local services = {
	Players = {
		LocalPlayer = player,
		PlayerAdded = signal(),
		GetPlayers = function()
			local list = { player }
			for i, p in ipairs(otherPlayers) do
				list[#list + 1] = p
			end
			return list
		end,
	},
	UserInputService = {
		InputBegan = signal(), InputChanged = signal(), InputEnded = signal(),
		GetMouseLocation = function()
			return { X = 0, Y = 0 }
		end,
	},
	HttpService = {
		JSONEncode = function(_, t)
			return jsonEncode(t)
		end,
		JSONDecode = function(_, s)
			return {}
		end,
	},
	VoiceChatService = { UseAudioApi = "Enabled" },
	CoreGui = Instance.new("CoreGui"),
	TweenService = { Create = function()
		return { Play = function() end }
	end },
	RunService = { Heartbeat = signal() },
}

game = {
	GetService = function(_, name)
		local s = services[name]
		if not s then
			s = {}
			services[name] = s
		end
		return s
	end,
}

workspace = Instance.new("Workspace")

task = {}
function task.wait()
	coroutine.yield()
end
function task.spawn(fn)
	local co = coroutine.create(fn)
	local ok, err = coroutine.resume(co)
	if not ok then
		print("spawn error: " .. tostring(err))
	end
	return co
end
function task.delay(_, fn)
	task.spawn(fn)
end

_G.TEST_PLAYER = player
