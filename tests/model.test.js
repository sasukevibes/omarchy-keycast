"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../lib/Model.js")

const key = (sym, text, mods, extra) => Object.assign({ type: "key", code: 0, sym, text: text || "", mods: mods || [], repeat: false }, extra)

function run(events, ctx, start) {
  let state = Model.create()
  let t = start || 1000
  for (const ev of events) {
    t += 50
    state = Model.apply(state, ev, ctx || {}, t)
  }
  return state
}

function type(str) {
  return Array.from(str).map(ch => key(ch === " " ? "space" : ch.toLowerCase(), ch, ch !== ch.toLowerCase() ? ["SHIFT"] : []))
}

const view = state => state.rows.map(r => r.kind === "text" ? r.text : r.caps.join("+") + (r.count > 1 ? " ×" + r.count : "") + (r.desc ? " → " + r.desc : ""))

test("typed characters group into one text row", () => {
  assert.deepEqual(view(run(type("git commit"))), ["git commit"])
})

test("shift-typed characters are text, not combos", () => {
  assert.deepEqual(view(run(type("Hi!"))), ["Hi!"])
})

test("backspace edits the open text row", () => {
  assert.deepEqual(view(run([...type("lsx"), key("BackSpace")])), ["ls"])
})

test("backspace with no open text is a key cap", () => {
  assert.deepEqual(view(run([key("BackSpace")])), ["Backspace"])
})

test("enter closes the line with a return marker", () => {
  const state = run([...type("ls"), key("Return"), ...type("pwd")])
  assert.deepEqual(view(state), ["ls ⏎", "pwd"])
})

test("idle gap starts a new text row", () => {
  let state = run(type("ab"))
  state = Model.apply(state, key("c", "c"), {}, 10000)
  assert.deepEqual(view(state), ["ab", "c"])
})

test("combos show ordered caps with friendly labels", () => {
  assert.deepEqual(view(run([key("Return", "", ["SUPER", "SHIFT"])])), ["SUPER+SHIFT+Enter"])
  assert.deepEqual(view(run([key("c", "", ["CTRL"])])), ["CTRL+C"])
})

test("a combo closes the text row", () => {
  assert.deepEqual(view(run([...type("hi"), key("s", "", ["CTRL"]), ...type("x")])), ["hi", "CTRL+S", "x"])
})

test("repeated combos collapse into a counter", () => {
  assert.deepEqual(view(run([key("Down"), key("Down"), key("Down")])), ["↓ ×3"])
})

const held = (ev, n) => Array.from({ length: n }, () => Object.assign({}, ev, { repeat: true }))

test("a held text key shows once", () => {
  assert.deepEqual(view(run([...type("as"), ...held(key("s", "s"), 20), ...type("d")])), ["asd"])
})

test("a held special key or combo shows once", () => {
  assert.deepEqual(view(run([key("Down"), ...held(key("Down"), 20)])), ["↓"])
  assert.deepEqual(view(run([key("x", "", ["CTRL"]), ...held(key("x", "", ["CTRL"]), 20)])), ["CTRL+X"])
})

test("a held key stays on screen while it repeats", () => {
  let state = Model.apply(Model.create(), key("s", "s"), {}, 1000)
  for (let t = 1030; t <= 5000; t += 30) state = Model.apply(state, key("s", "s", [], { repeat: true }), {}, t)
  assert.deepEqual(view(Model.expire(state, 5100)), ["s"])
  assert.deepEqual(view(Model.expire(state, 5000 + Model.DEFAULTS.fadeMs)), [])
})

test("rows are capped and oldest drop first", () => {
  const state = run([key("a", "", ["CTRL"]), key("b", "", ["CTRL"]), key("c", "", ["CTRL"]), key("d", "", ["CTRL"])])
  assert.deepEqual(view(state), ["CTRL+B", "CTRL+C", "CTRL+D"])
})

test("rows expire after the fade time", () => {
  let state = run([key("a", "", ["CTRL"])])
  state = Model.expire(state, 1050 + Model.DEFAULTS.fadeMs - 1)
  assert.equal(state.rows.length, 1)
  state = Model.expire(state, 1050 + Model.DEFAULTS.fadeMs)
  assert.equal(state.rows.length, 0)
})

test("long text keeps the tail", () => {
  const state = run(type("a".repeat(50)))
  const text = state.rows[0].text
  assert.equal(Array.from(text).length, Model.DEFAULTS.maxTextChars)
  assert.ok(text.startsWith("…"))
})

test("solo SUPER tap shows, solo SHIFT does not", () => {
  assert.deepEqual(view(run([{ type: "mod", sym: "Super_L", mods: ["SUPER"] }])), ["SUPER"])
  assert.deepEqual(view(run([{ type: "mod", sym: "Shift_L", mods: ["SHIFT"] }])), [])
})

test("clicks show with modifiers and collapse", () => {
  const click = { type: "click", button: "left", mods: [], tap: false }
  assert.deepEqual(view(run([click, click])), ["Click ×2"])
  assert.deepEqual(view(run([{ type: "click", button: "right", mods: ["SUPER"], tap: true }])), ["SUPER+Right Click"])
})

// ---- privacy ----

test("suppressed text shows a fixed mask that does not reveal length", () => {
  const state = run(type("hunter2"), { suppressText: true })
  assert.deepEqual(view(state), [Model.MASK_TEXT])
  assert.equal(state.rows[0].raw, "")
})

test("combos still show while text is suppressed", () => {
  assert.deepEqual(view(run([key("v", "", ["CTRL"])], { suppressText: true })), ["CTRL+V"])
})

test("line after a sudo command is masked until enter", () => {
  const state = run([...type("sudo pacman -Syu"), key("Return"), ...type("hunter2"), key("Return"), ...type("ls")])
  assert.deepEqual(view(state), ["sudo pacman -Syu ⏎", Model.MASK_TEXT, "ls"])
  assert.ok(!JSON.stringify(state).includes("hunter2"))
})

test("mask arms after ssh and doas too, but not after ls", () => {
  for (const cmd of ["ssh box", "doas true", "git pull && sudo make install", "yay -S foo"]) {
    const state = run([...type(cmd), key("Return"), ...type("secret")])
    assert.equal(state.rows[state.rows.length - 1].text, Model.MASK_TEXT, cmd)
  }
  const state = run([...type("ls -la"), key("Return"), ...type("pwd")])
  assert.equal(state.rows[state.rows.length - 1].text, "pwd")
})

test("mask expires after the timeout", () => {
  let state = run([...type("sudo ls"), key("Return")])
  state = Model.apply(state, key("x", "x"), {}, 1000 + Model.DEFAULTS.maskTimeoutMs + 5000)
  assert.equal(state.rows[state.rows.length - 1].text, "x")
})

test("masked text cannot be backspaced into view and switching mask starts a new row", () => {
  let state = run(type("ab"))
  state = Model.apply(state, key("c", "c"), { suppressText: true }, 1200)
  assert.deepEqual(view(state), ["ab", Model.MASK_TEXT])
})

test("scrubText removes typed text but keeps combos", () => {
  const state = Model.scrubText(run([key("l", "", ["SUPER"]), ...type("pass")]))
  assert.deepEqual(view(state), ["SUPER+L"])
})

test("sensitive windows and layers", () => {
  assert.ok(Model.isSensitiveWindow("org.gnupg.pinentry-qt", ""))
  assert.ok(Model.isSensitiveWindow("1Password", "1Password"))
  assert.ok(Model.isSensitiveWindow("chromium", "Sign in - Google Accounts"))
  assert.ok(Model.isSensitiveWindow("Alacritty", "[sudo] password for user"))
  assert.ok(!Model.isSensitiveWindow("Alacritty", "nvim README.md"))
  assert.ok(!Model.isSensitiveWindow("chromium", "Pinterest"))
  assert.ok(Model.isSensitiveLayer("omarchy-polkit"))
  assert.ok(!Model.isSensitiveLayer("omarchy-osd"))
})

// ---- Hyprland bind labels ----

const binds = Model.parseBinds(JSON.stringify([
  { modmask: 64, key: "RETURN", keycode: 0, has_description: true, description: "Terminal", submap: "" },
  { modmask: 65, key: "", keycode: 10, has_description: true, description: "Move to workspace 1", submap: "" },
  { modmask: 64, key: "mouse:272", keycode: 0, mouse: true, has_description: true, description: "Move window", submap: "" },
  { modmask: 64, key: "q", keycode: 0, has_description: false, description: "", submap: "" },
  { modmask: 64, key: "r", keycode: 0, has_description: true, description: "In a submap", submap: "resize" },
  { modmask: 64, key: "Super_L", keycode: 0, release: true, has_description: true, description: "Launcher", submap: "" },
]))

test("parseBinds keeps described global binds only", () => {
  assert.equal(binds.length, 4)
  assert.deepEqual(Model.parseBinds("not json"), [])
})

test("combo picks up the bind description, case-insensitively", () => {
  assert.deepEqual(view(run([key("Return", "", ["SUPER"])], { binds })), ["SUPER+Enter → Terminal"])
})

test("code: binds match on keycode + 8", () => {
  assert.deepEqual(view(run([key("1", "", ["SUPER", "SHIFT"], { code: 2 })], { binds })), ["SUPER+SHIFT+1 → Move to workspace 1"])
})

test("mouse binds label clicks", () => {
  assert.deepEqual(view(run([{ type: "click", button: "left", mods: ["SUPER"] }], { binds })), ["SUPER+Click → Move window"])
})

test("solo modifier taps match release binds", () => {
  assert.deepEqual(view(run([{ type: "mod", sym: "Super_L", mods: ["SUPER"] }], { binds })), ["SUPER → Launcher"])
})

test("heldSuper keeps only events made while SUPER is down", () => {
  assert.equal(Model.heldSuper(key("Return", "", ["SUPER"])), true)
  assert.equal(Model.heldSuper(key("1", "", ["SUPER", "SHIFT"])), true)
  assert.equal(Model.heldSuper({ type: "click", button: "left", mods: ["SUPER"] }), true)
  assert.equal(Model.heldSuper({ type: "mod", sym: "Super_L", mods: ["SUPER"] }), true)
  assert.equal(Model.heldSuper(key("a", "a")), false)
  assert.equal(Model.heldSuper(key("c", "", ["CTRL"])), false)
  assert.equal(Model.heldSuper({ type: "click", button: "left", mods: [] }), false)
  assert.equal(Model.heldSuper({ type: "mod", sym: "Control_L", mods: ["CTRL"] }), false)
})

test("key labels", () => {
  assert.equal(Model.keyLabel("a"), "A")
  assert.equal(Model.keyLabel("Escape"), "Esc")
  assert.equal(Model.keyLabel("F5"), "F5")
  assert.equal(Model.keyLabel("slash"), "/")
  assert.equal(Model.keyLabel("KP_1"), "Num 1")
  assert.equal(Model.keyLabel("XF86Calculator"), "Calculator")
})

// ---- recording target ----

test("recorderTarget reads gpu-screen-recorder's -w", () => {
  assert.equal(Model.recorderTarget("123 gpu-screen-recorder -w eDP-2 -s 0x0 -k auto -f 60"), "monitor:eDP-2")
  assert.equal(Model.recorderTarget("123 gpu-screen-recorder -w 800x600+100+-20 -k auto"), "region:100,-20,800,600")
  assert.equal(Model.recorderTarget("123 gpu-screen-recorder -w portal -s 0x0"), "focused")
  assert.equal(Model.recorderTarget(""), "focused")
})

test("areaOn places keys in the recorded monitor or region", () => {
  const left = { name: "DP-1", x: 0, y: 0, width: 1920, height: 1080 }
  const right = { name: "eDP-2", x: 1920, y: 0, width: 1600, height: 1000 }
  assert.deepEqual(Model.areaOn("monitor:eDP-2", right, "DP-1"), { x: 0, y: 0, w: 1600, h: 1000 })
  assert.equal(Model.areaOn("monitor:eDP-2", left, "DP-1"), null)
  assert.deepEqual(Model.areaOn("region:2020,100,400,300", right, ""), { x: 100, y: 100, w: 400, h: 300 })
  assert.equal(Model.areaOn("region:2020,100,400,300", left, ""), null)
  assert.deepEqual(Model.areaOn("focused", left, "DP-1"), { x: 0, y: 0, w: 1920, h: 1080 })
  assert.equal(Model.areaOn("focused", right, "DP-1"), null)
})

// ---- settings ----

test("size presets map to overlay scale", () => {
  assert.equal(Model.scaleFor({}), 1)
  assert.equal(Model.scaleFor({ size: "small" }), 0.75)
  assert.equal(Model.scaleFor({ size: "large" }), 1.35)
  assert.equal(Model.scaleFor({ scale: 1.2 }), 1.2)
  assert.equal(Model.scaleFor({ size: "large", scale: 0.5 }), 1.35)
  assert.equal(Model.scaleFor({ size: "huge", scale: -1 }), 1)
})

test("sizeName reports the preset to highlight", () => {
  assert.equal(Model.sizeName({}), "medium")
  assert.equal(Model.sizeName({ size: "small" }), "small")
  assert.equal(Model.sizeName({ scale: 1.35 }), "large")
  assert.equal(Model.sizeName({ scale: 1.2 }), "")
})
