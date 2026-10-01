// Display model for keycast: turns keycastd protocol events into the rows the
// overlay draws. Pure functions, no Qt, time passed in explicitly, so it runs
// under `node --test` as well as in QML.

var DEFAULTS = {
  maxRows: 3,
  fadeMs: 1500,
  textIdleMs: 1200,
  maxTextChars: 36,
  maskTimeoutMs: 30000,
}

var MASK_TEXT = "••••••"

var MOD_BITS = { SHIFT: 1, CTRL: 4, ALT: 8, SUPER: 64 }
var MOUSE_CODES = { left: 272, right: 273, middle: 274, back: 275, forward: 276 }
var CLICK_LABELS = { left: "Click", right: "Right Click", middle: "Middle Click", back: "Back", forward: "Forward" }

var KEY_LABELS = {
  Return: "Enter", KP_Enter: "Enter", space: "Space", BackSpace: "Backspace",
  Escape: "Esc", Tab: "Tab", ISO_Left_Tab: "Tab", Delete: "Del", Insert: "Ins",
  Left: "←", Right: "→", Up: "↑", Down: "↓",
  Prior: "PgUp", Next: "PgDn", Home: "Home", End: "End",
  Print: "Print", Pause: "Pause", Menu: "Menu",
  Caps_Lock: "Caps", Num_Lock: "NumLk", Scroll_Lock: "ScrLk", Multi_key: "Compose",
  Super_L: "SUPER", Super_R: "SUPER", Control_L: "CTRL", Control_R: "CTRL",
  Alt_L: "ALT", Alt_R: "ALT", Shift_L: "SHIFT", Shift_R: "SHIFT",
  minus: "-", equal: "=", comma: ",", period: ".", slash: "/", backslash: "\\",
  semicolon: ";", apostrophe: "'", grave: "`", bracketleft: "[", bracketright: "]",
  XF86AudioRaiseVolume: "Vol +", XF86AudioLowerVolume: "Vol −", XF86AudioMute: "Mute",
  XF86AudioMicMute: "Mic Mute", XF86AudioPlay: "Play", XF86AudioPause: "Pause",
  XF86AudioNext: "Next", XF86AudioPrev: "Prev",
  XF86MonBrightnessUp: "Bright +", XF86MonBrightnessDown: "Bright −",
}

// Commands that commonly ask for a password on the next line.
var SENSITIVE_COMMAND = /(^|[\s;&|(])(sudo|su|doas|pkexec|run0|passwd|ssh|scp|sftp|ssh-add|ssh-keygen|gpg|cryptsetup|kinit|login|yay|paru|mysql\s.*-p|bw\s+unlock|op\s+signin)(\s|$)/

var SENSITIVE_CLASS = /pinentry|1password|bitwarden|keepass|seahorse|polkit|gcr-prompter|kwallet|lxqt-openssh-askpass|ssh-askpass/i
var SENSITIVE_TITLE = /password|passphrase|passcode|\bsudo\b|\bpin\b|sign[ -]?in|log[ -]?in|2fa|two-factor|one-time code|unlock|authenticat/i

// Layer-shell namespaces that take keyboard focus for secrets.
var SENSITIVE_LAYERS = /polkit|lock|pinentry|askpass/i

function keyLabel(sym) {
  if (KEY_LABELS.hasOwnProperty(sym)) return KEY_LABELS[sym]
  if (/^[a-z]$/.test(sym)) return sym.toUpperCase()
  if (/^KP_/.test(sym)) return "Num " + keyLabel(sym.slice(3))
  if (/^XF86/.test(sym)) return sym.slice(4).replace(/([a-z])([A-Z])/g, "$1 $2")
  return sym
}

function isSensitiveWindow(cls, title) {
  return SENSITIVE_CLASS.test(String(cls || "")) || SENSITIVE_TITLE.test(String(title || ""))
}

function isSensitiveLayer(namespace) {
  return SENSITIVE_LAYERS.test(String(namespace || ""))
}

function isSensitiveCommand(line) {
  return SENSITIVE_COMMAND.test(String(line || "").trim())
}

// `hyprctl binds -j` → compact list the matcher can scan quickly. Only global
// binds with a description are useful as labels.
function parseBinds(json) {
  var raw
  try { raw = typeof json === "string" ? JSON.parse(json) : json } catch (e) { return [] }
  if (!Array.isArray(raw)) return []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i]
    if (!b || !b.has_description || !b.description || b.submap) continue
    out.push({
      mask: b.modmask | 0,
      key: String(b.key || "").toLowerCase(),
      keycode: b.keycode | 0,
      mouse: !!b.mouse,
      desc: String(b.description),
    })
  }
  return out
}

function modMask(mods) {
  var mask = 0
  for (var i = 0; i < (mods || []).length; i++) mask |= MOD_BITS[mods[i]] || 0
  return mask
}

function findBind(binds, mods, sym, code) {
  if (!binds || !binds.length) return ""
  var mask = modMask(mods)
  var key = String(sym || "").toLowerCase()
  var xkbCode = code + 8
  for (var i = 0; i < binds.length; i++) {
    var b = binds[i]
    if (b.mask !== mask || b.mouse) continue
    if (b.keycode ? b.keycode === xkbCode : b.key === key) return b.desc
  }
  return ""
}

function findMouseBind(binds, mods, button) {
  if (!binds || !binds.length) return ""
  var mask = modMask(mods)
  var key = "mouse:" + MOUSE_CODES[button]
  for (var i = 0; i < binds.length; i++) {
    var b = binds[i]
    if (b.mask === mask && b.key === key) return b.desc
  }
  return ""
}

function create() {
  return { rows: [], nextId: 1, textRowId: 0, lastTextAt: 0, maskLine: false, maskSince: 0 }
}

function clone(state) {
  return {
    rows: state.rows.map(function(r) { return Object.assign({}, r) }),
    nextId: state.nextId,
    textRowId: state.textRowId,
    lastTextAt: state.lastTextAt,
    maskLine: state.maskLine,
    maskSince: state.maskSince,
  }
}

function findRow(state, id) {
  for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) return state.rows[i]
  return null
}

function pushRow(state, row, opts) {
  row.id = state.nextId++
  state.rows.push(row)
  while (state.rows.length > opts.maxRows) state.rows.shift()
  return row
}

function openTextRow(state, now, opts) {
  var row = state.textRowId ? findRow(state, state.textRowId) : null
  if (row && !row.closed && now - state.lastTextAt <= opts.textIdleMs) return row
  return null
}

function closeText(state) {
  var row = state.textRowId ? findRow(state, state.textRowId) : null
  if (row) row.closed = true
  state.textRowId = 0
  return row
}

function trimText(text, max) {
  var chars = Array.from(text)
  return chars.length > max ? "…" + chars.slice(chars.length - max + 1).join("") : text
}

function addText(state, text, masked, now, opts) {
  var row = openTextRow(state, now, opts)
  if (row && row.masked !== masked) {
    closeText(state)
    row = null
  }
  if (!row) {
    row = pushRow(state, { kind: "text", caps: [], text: "", raw: "", desc: "", count: 1, masked: masked, closed: false, updated: now }, opts)
    state.textRowId = row.id
  }
  if (masked) {
    row.text = MASK_TEXT
  } else {
    row.raw += text
    row.text = trimText(row.raw, opts.maxTextChars)
  }
  row.updated = now
  state.lastTextAt = now
}

function addCaps(state, kind, caps, desc, now, opts) {
  var last = state.rows[state.rows.length - 1]
  if (last && last.kind === kind && last.caps.join("\u0000") === caps.join("\u0000") && now - last.updated <= opts.fadeMs) {
    last.count += 1
    last.updated = now
    if (desc) last.desc = desc
    return
  }
  pushRow(state, { kind: kind, caps: caps, text: "", raw: "", desc: desc, count: 1, masked: false, closed: false, updated: now }, opts)
}

function isShortcut(mods) {
  for (var i = 0; i < (mods || []).length; i++) if (mods[i] !== "SHIFT") return true
  return false
}

// ctx: { binds: parseBinds(...), suppressText: bool }
function apply(prev, ev, ctx, now, options) {
  var opts = Object.assign({}, DEFAULTS, options || {})
  var state = clone(prev)
  ctx = ctx || {}
  if (state.maskLine && now - state.maskSince > opts.maskTimeoutMs) state.maskLine = false
  if (!ev || !ev.type) return state

  if (ev.type === "key") {
    var mods = ev.mods || []
    var masked = !!ctx.suppressText || state.maskLine
    var textRow = openTextRow(state, now, opts)

    // A held key shows once: auto-repeat only keeps its row on screen.
    if (ev.repeat) {
      var held = textRow || state.rows[state.rows.length - 1]
      if (held) held.updated = now
      if (textRow) state.lastTextAt = now
      return state
    }

    if (!isShortcut(mods) && ev.text) {
      addText(state, ev.text, masked, now, opts)
      return state
    }

    if (!mods.length && (ev.sym === "Return" || ev.sym === "KP_Enter")) {
      if (textRow) {
        if (!textRow.masked) textRow.text = trimText(textRow.raw + " ⏎", opts.maxTextChars)
        textRow.updated = now
        var line = textRow.masked ? "" : textRow.raw
        closeText(state)
        if (state.maskLine) state.maskLine = false
        else if (!masked && isSensitiveCommand(line)) {
          state.maskLine = true
          state.maskSince = now
        }
        return state
      }
      if (state.maskLine) state.maskLine = false
    }

    if (!mods.length && ev.sym === "BackSpace" && textRow) {
      if (!textRow.masked) {
        var chars = Array.from(textRow.raw)
        chars.pop()
        textRow.raw = chars.join("")
        textRow.text = trimText(textRow.raw, opts.maxTextChars)
      }
      textRow.updated = now
      state.lastTextAt = now
      return state
    }

    if (!mods.length && ev.sym === "Tab" && textRow && !textRow.masked) {
      textRow.raw += "⇥"
      textRow.text = trimText(textRow.raw, opts.maxTextChars)
      textRow.updated = now
      state.lastTextAt = now
      return state
    }

    closeText(state)
    var caps = mods.slice()
    caps.push(keyLabel(ev.sym))
    addCaps(state, "combo", caps, findBind(ctx.binds, mods, ev.sym, ev.code | 0), now, opts)
    return state
  }

  if (ev.type === "mod") {
    // A lone SHIFT tap carries no meaning on screen.
    if (!ev.mods || !ev.mods.length || ev.mods[0] === "SHIFT") return state
    closeText(state)
    addCaps(state, "combo", [ev.mods[0]], findBind(ctx.binds, [ev.mods[0]], ev.sym, -8), now, opts)
    return state
  }

  if (ev.type === "click") {
    closeText(state)
    var clickCaps = (ev.mods || []).slice()
    clickCaps.push(CLICK_LABELS[ev.button] || ev.button)
    addCaps(state, "click", clickCaps, findMouseBind(ctx.binds, ev.mods || [], ev.button), now, opts)
    return state
  }

  return state
}

// Super-only mode: keep just what happens while SUPER is held, i.e. SUPER
// combos, SUPER + click, and a lone SUPER tap. Everything else stays off
// screen, so ordinary typing never shows in the recording.
function heldSuper(ev) {
  if (!ev || !ev.mods) return false
  return ev.mods.indexOf("SUPER") >= 0
}

// Wipe any typed text on screen, e.g. when the screen locks or a secret
// prompt appears. Combos stay.
function scrubText(prev) {
  var state = clone(prev)
  state.rows = state.rows.filter(function(r) { return r.kind !== "text" })
  state.textRowId = 0
  return state
}

function expire(prev, now, options) {
  var opts = Object.assign({}, DEFAULTS, options || {})
  var keep = prev.rows.filter(function(r) { return now - r.updated < opts.fadeMs })
  if (keep.length === prev.rows.length) return prev
  var state = clone(prev)
  state.rows = keep.map(function(r) { return Object.assign({}, r) })
  if (state.textRowId && !findRow(state, state.textRowId)) state.textRowId = 0
  return state
}

// Overlay size presets offered in the settings panel.
var SIZES = { small: 0.75, medium: 1, large: 1.35 }

// Overlay scale from the user's config: a named `size` wins, then a numeric
// `scale` (the original setting), then medium.
function scaleFor(config) {
  config = config || {}
  if (SIZES.hasOwnProperty(config.size)) return SIZES[config.size]
  var n = Number(config.scale)
  return isFinite(n) && n > 0 ? n : SIZES.medium
}

// The named size the panel should highlight, or "" for a custom scale.
function sizeName(config) {
  config = config || {}
  if (SIZES.hasOwnProperty(config.size)) return config.size
  if (config.scale === undefined || config.scale === null) return "medium"
  for (var name in SIZES) if (SIZES[name] === Number(config.scale)) return name
  return ""
}

// gpu-screen-recorder's -w argument says what is being recorded, so keys can
// land inside the captured area even for region recordings. Takes a
// `pgrep -a` line and returns "monitor:<name>", "region:<x>,<y>,<w>,<h>"
// (global logical px), or "focused".
function recorderTarget(line) {
  var args = String(line || "").trim().split(/\s+/)
  var w = ""
  for (var i = 0; i < args.length - 1; i++) if (args[i] === "-w") { w = args[i + 1]; break }
  var m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(w)
  if (m) return "region:" + m[3] + "," + m[4] + "," + m[1] + "," + m[2]
  if (!w || w === "portal" || w === "screen" || w === "focused") return "focused"
  return "monitor:" + w
}

// The recorded area on `screen` ({name, x, y, width, height}) in that
// screen's coordinates, or null when the recording is elsewhere.
function areaOn(target, screen, focusedName) {
  var full = { x: 0, y: 0, w: screen.width, h: screen.height }
  target = String(target || "")
  if (target.indexOf("monitor:") === 0) return screen.name === target.slice(8) ? full : null
  if (target.indexOf("region:") === 0) {
    var r = target.slice(7).split(",").map(Number)
    var cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2
    var inside = cx >= screen.x && cx < screen.x + screen.width && cy >= screen.y && cy < screen.y + screen.height
    return inside ? { x: r[0] - screen.x, y: r[1] - screen.y, w: r[2], h: r[3] } : null
  }
  return screen.name === focusedName ? full : null
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULTS: DEFAULTS,
    MASK_TEXT: MASK_TEXT,
    keyLabel: keyLabel,
    isSensitiveWindow: isSensitiveWindow,
    isSensitiveLayer: isSensitiveLayer,
    isSensitiveCommand: isSensitiveCommand,
    parseBinds: parseBinds,
    modMask: modMask,
    findBind: findBind,
    findMouseBind: findMouseBind,
    create: create,
    apply: apply,
    scrubText: scrubText,
    heldSuper: heldSuper,
    expire: expire,
    SIZES: SIZES,
    scaleFor: scaleFor,
    sizeName: sizeName,
    recorderTarget: recorderTarget,
    areaOn: areaOn,
  }
}
