import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "lib/Model.js" as Model

// keycast service: watches for Omarchy's screen recorder, runs keycastd while
// it records, and feeds the overlay. See docs/DESIGN.md.
Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string configPath: home + "/.config/keycast/config.json"

  // ---- settings (~/.config/keycast/config.json, all optional) ----
  property var config: ({})
  // Master switch from the bar widget: off means no helper and no overlay,
  // so a recording can be made without keys on screen.
  readonly property bool castEnabled: config.enabled !== false
  readonly property string sizeName: Model.sizeName(config)
  readonly property real scale: Model.scaleFor(config)
  readonly property int fadeMs: Math.round(positive(config.fadeMs, Model.DEFAULTS.fadeMs))
  readonly property bool showText: config.showText !== false
  readonly property bool showClicks: config.showClicks !== false
  // Only show keys pressed while SUPER is held; typing stays off screen.
  readonly property bool superOnly: config.superOnly === true
  onSuperOnlyChanged: if (root.superOnly) root.clear()
  readonly property bool showBindLabels: config.showBindLabels !== false
  readonly property string position: config.position === "top" ? "top" : "bottom"

  // ---- recording ----
  property bool recording: false
  // "monitor:<name>", "region:<x>,<y>,<w>,<h>" (global logical px), or "focused".
  property string target: "focused"
  property bool demoActive: false
  readonly property bool active: recording || demoActive
  property bool helperStartedThisRecording: false
  property string helperStatus: "idle"
  property string lastError: ""

  // ---- privacy ----
  property bool paused: false
  property bool locked: false
  property string activeClass: ""
  property string activeTitle: ""
  property var openLayers: ({})
  property int sensitiveLayerCount: 0
  readonly property bool sensitiveWindow: Model.isSensitiveWindow(activeClass, activeTitle)
  readonly property bool suppressText: paused || locked || sensitiveWindow || sensitiveLayerCount > 0
  onSuppressTextChanged: if (suppressText) scrub()

  // ---- display ----
  property var castState: Model.create()
  property var binds: []
  property double now: Date.now()
  readonly property alias rows: rowsModel
  readonly property alias ripples: ripplesModel
  readonly property int fadeOutMs: 250

  ListModel { id: rowsModel }
  ListModel { id: ripplesModel }

  function positive(value, fallback) {
    var n = Number(value)
    return isFinite(n) && n > 0 ? n : fallback
  }

  function notify(headline, body) {
    Quickshell.execDetached(["omarchy-notification-send", "-g", "󰌌", "-t", "8000", headline, body || ""])
  }

  // ---- config ----
  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      // A read that races a write can see half a file; keep what we had.
      try { root.config = JSON.parse(text()) || {} } catch (e) {}
    }
    onLoadFailed: root.config = {}
  }

  // Settings changed from the bar widget or IPC. Updates take effect at once
  // and are saved so they survive a restart.
  function setSetting(key, value) {
    var next = Object.assign({}, root.config)
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
    root.config = next
    configWriter.write(JSON.stringify(next, null, 2))
  }

  FileWriter {
    id: configWriter
    path: root.configPath
  }

  // A small state file for the bar widget. Replacement bars don't give
  // widgets access to this service, so the widget reads this file and
  // changes settings through `omarchy-shell keycast …` instead.
  readonly property string statePath: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/keycast/state.json"
  readonly property string publicState: JSON.stringify({
    enabled: root.castEnabled,
    showClicks: root.showClicks,
    superOnly: root.superOnly,
    size: root.sizeName,
    recording: root.recording,
    helper: root.helperStatus,
  })
  onPublicStateChanged: stateWriter.write(root.publicState)
  Component.onCompleted: stateWriter.write(root.publicState)

  FileWriter {
    id: stateWriter
    path: root.statePath
  }

  onCastEnabledChanged: {
    if (!root.castEnabled) {
      helperProc.running = false
      root.helperStatus = "off"
      root.clear()
    } else if (root.recording) {
      root.helperStartedThisRecording = false
      contextProc.running = true
    } else {
      root.helperStatus = "idle"
    }
  }

  // ---- recording detection ----
  Timer {
    interval: 700
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!recorderProc.running) recorderProc.running = true
  }

  Process {
    id: recorderProc
    command: ["pgrep", "-a", "-f", "^gpu-screen-recorder"]
    stdout: StdioCollector { id: recorderOut }
    onExited: function(exitCode) {
      var line = exitCode === 0 ? recorderOut.text.split("\n")[0] : ""
      root.setRecording(line !== "", line)
    }
  }

  function setRecording(isRecording, line) {
    if (isRecording) root.target = Model.recorderTarget(line)
    if (isRecording === root.recording) return
    root.recording = isRecording
    if (isRecording) {
      root.helperStartedThisRecording = false
      root.lastError = ""
      // watchChanges cannot see a file created after load, so re-read the
      // config each time; it lands long before the hyprctl context does.
      configFile.reload()
      contextProc.running = true
    } else {
      helperProc.running = false
      root.helperStatus = "idle"
      root.locked = false
      if (!root.demoActive) root.clear()
    }
  }

  // ---- context + helper ----
  Process {
    id: contextProc
    command: [root.pluginDir + "/scripts/keycast-context"]
    stdout: StdioCollector { id: contextOut }
    onExited: {
      var ctx = {}
      try { ctx = JSON.parse(contextOut.text) } catch (e) {}
      root.binds = Model.parseBinds(ctx.binds || [])
      root.activeClass = ctx.windowClass || ""
      root.activeTitle = ctx.windowTitle || ""
      if (root.recording) root.startHelper(ctx)
    }
  }

  function helperCommand(ctx) {
    var args = ["--layout", ctx.layout || "us", "--variant", ctx.variant || "",
                "--options", ctx.options || "", "--model", ctx.model || ""]
    if (ctx.taps) args.push("--taps")
    // Development override: run an unprivileged command instead of pkexec.
    if (Array.isArray(root.config.helperCommand) && root.config.helperCommand.length)
      return root.config.helperCommand.concat(args)
    if (!ctx.helper) return null
    return ["pkexec", ctx.helper].concat(args)
  }

  function startHelper(ctx) {
    if (!root.castEnabled || root.helperStartedThisRecording || helperProc.running) return
    root.helperStartedThisRecording = true
    var command = helperCommand(ctx)
    if (!command) {
      root.helperStatus = "missing"
      root.notify("keycast helper not installed", "Run install.sh from the keycast plugin folder to show keystrokes in recordings.")
      return
    }
    root.helperStatus = "starting"
    helperProc.command = command
    helperProc.running = true
  }

  Process {
    id: helperProc
    stdout: SplitParser {
      onRead: function(line) { root.onHelperLine(line) }
    }
    stderr: SplitParser {
      onRead: function(line) { if (line) root.lastError = line }
    }
    onExited: function(exitCode) {
      var wasLive = root.helperStatus === "live"
      // Stopping it ourselves when the recording ends is not a failure.
      root.helperStatus = exitCode === 0 || !root.recording ? "idle" : "failed"
      if (exitCode !== 0 && root.recording && !wasLive) {
        var why = exitCode === 126 || exitCode === 127
          ? "Permission was denied. Re-run install.sh to install the polkit rule."
          : (root.lastError || "keycastd exited with status " + exitCode)
        root.notify("keycast could not read keys", why)
      }
    }
  }

  function onHelperLine(line) {
    var ev
    try { ev = JSON.parse(line) } catch (e) { return }
    if (ev.type === "hello") { root.helperStatus = "live"; return }
    if (ev.type === "error") { root.lastError = ev.message || ""; return }
    if (ev.type === "bye") return
    if (root.recording && root.castEnabled) feed(ev)
  }

  // ---- model ----
  function isTyping(ev) {
    if (ev.type !== "key" || !ev.text) return false
    for (var i = 0; i < (ev.mods || []).length; i++) if (ev.mods[i] !== "SHIFT") return false
    return true
  }

  function feed(ev) {
    if (root.superOnly && !Model.heldSuper(ev)) return
    if (!root.showText && isTyping(ev)) return
    if (!root.showClicks && ev.type === "click") return
    var t = Date.now()
    var ctx = { binds: root.showBindLabels ? root.binds : [], suppressText: root.suppressText }
    root.castState = Model.apply(root.castState, ev, ctx, t, { fadeMs: root.fadeMs })
    root.now = t
    syncRows()
    if (ev.type === "click") cursorProc.request(ev.button)
  }

  function scrub() {
    root.castState = Model.scrubText(root.castState)
    syncRows()
  }

  function clear() {
    root.castState = Model.create()
    rowsModel.clear()
    ripplesModel.clear()
  }

  function syncRows() {
    var rows = root.castState.rows
    var ids = {}
    for (var i = 0; i < rows.length; i++) ids[rows[i].id] = true
    for (var j = rowsModel.count - 1; j >= 0; j--) if (!ids[rowsModel.get(j).rid]) rowsModel.remove(j)
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k]
      var item = {
        rid: r.id, kind: r.kind, caps: r.caps.join("\u001f"), text: r.text,
        desc: r.desc || "", count: r.count, masked: !!r.masked, updated: r.updated,
      }
      var at = -1
      for (var m = 0; m < rowsModel.count; m++) if (rowsModel.get(m).rid === r.id) { at = m; break }
      if (at < 0) rowsModel.insert(k, item)
      else {
        if (at !== k) rowsModel.move(at, k, 1)
        rowsModel.set(k, item)
      }
    }
  }

  Timer {
    interval: 100
    repeat: true
    running: rowsModel.count > 0 || ripplesModel.count > 0
    onTriggered: {
      var t = Date.now()
      root.now = t
      var next = Model.expire(root.castState, t, { fadeMs: root.fadeMs + root.fadeOutMs })
      if (next !== root.castState) {
        root.castState = next
        root.syncRows()
      }
      for (var i = ripplesModel.count - 1; i >= 0; i--)
        if (t - ripplesModel.get(i).born > 600) ripplesModel.remove(i)
      if (root.demoActive && !demoTimer.running && rowsModel.count === 0) root.demoActive = false
    }
  }

  // Click ripples need the pointer position, which evdev does not have.
  Process {
    id: cursorProc
    property string button: "left"
    function request(b) {
      if (running) return
      button = b
      running = true
    }
    command: ["hyprctl", "cursorpos", "-j"]
    stdout: StdioCollector { id: cursorOut }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      try {
        var p = JSON.parse(cursorOut.text)
        ripplesModel.append({ px: p.x, py: p.y, born: Date.now(), button: cursorProc.button })
      } catch (e) {}
    }
  }

  // ---- privacy signals ----
  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!root.active) return
      var name = event.name
      var data = String(event.data || "")
      if (name === "activewindow") {
        var comma = data.indexOf(",")
        root.activeClass = comma < 0 ? data : data.slice(0, comma)
        root.activeTitle = comma < 0 ? "" : data.slice(comma + 1)
      } else if (name === "openlayer" || name === "closelayer") {
        if (!Model.isSensitiveLayer(data)) return
        var layers = Object.assign({}, root.openLayers)
        layers[data] = Math.max(0, (layers[data] || 0) + (name === "openlayer" ? 1 : -1))
        if (!layers[data]) delete layers[data]
        root.openLayers = layers
        root.sensitiveLayerCount = Object.keys(layers).length
      }
    }
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.recording
    triggeredOnStart: true
    onTriggered: if (!lockProc.running) lockProc.running = true
  }

  Process {
    id: lockProc
    command: ["omarchy-shell", "-q", "lock", "isLocked"]
    stdout: StdioCollector { id: lockOut }
    onExited: root.locked = lockOut.text.trim() === "true"
  }

  // ---- overlay, one per screen ----
  Variants {
    model: Quickshell.screens
    delegate: Overlay {
      service: root
    }
  }

  // Where the keys go on a given screen, in that screen's coordinates, or
  // null when this screen is not the one being recorded.
  function areaOn(screen) {
    if (!screen) return null
    var focused = Hyprland.focusedMonitor
    return Model.areaOn(root.target, { name: screen.name, x: screen.x, y: screen.y, width: screen.width, height: screen.height },
                        focused ? focused.name : "")
  }

  // ---- demo: shows the overlay without recording or the helper ----
  property var demoScript: []
  property int demoIndex: 0

  function key(sym, text, mods, code) {
    return { type: "key", sym: sym, text: text || "", mods: mods || [], code: code || 0, repeat: false }
  }

  function typed(str, gap) {
    var out = []
    Array.from(str).forEach(function(ch) {
      var lower = ch.toLowerCase()
      out.push([gap || 70, key(ch === " " ? "space" : lower, ch, ch !== lower ? ["SHIFT"] : [])])
    })
    return out
  }

  // A short sample on the focused monitor so a size change can be seen.
  function startPreview() {
    if (root.recording) return
    root.clear()
    root.target = "focused"
    root.demoScript = [[0, key("Return", "", ["SUPER"], 28)]].concat(typed("keycast"))
    root.demoIndex = 0
    root.demoActive = true
    demoTimer.interval = 0
    demoTimer.restart()
  }

  function startDemo() {
    var s = []
    s.push([300, key("Return", "", ["SUPER"], 28)])
    s = s.concat(typed("git commit -m \"ship it\""))
    s.push([300, key("Return", "", [], 28)])
    s.push([900, key("c", "", ["CTRL", "SHIFT"], 46)])
    s.push([700, { type: "click", button: "left", mods: ["SUPER"], tap: false }])
    s.push([900, key("1", "", ["SUPER", "SHIFT"], 2)])
    s = s.concat(typed("sudo pacman -Syu"))
    s.push([200, key("Return", "", [], 28)])
    s = s.concat(typed("hunter2", 90))
    s.push([200, key("Return", "", [], 28)])
    s.push([900, key("Down", "", [], 108)])
    s.push([120, key("Down", "", [], 108)])
    s.push([120, key("Down", "", [], 108)])
    root.clear()
    root.target = "focused"
    root.binds = []
    demoContextProc.running = true
    root.demoScript = s
    root.demoIndex = 0
    root.demoActive = true
    demoTimer.interval = s[0][0]
    demoTimer.restart()
  }

  Process {
    id: demoContextProc
    command: ["hyprctl", "binds", "-j"]
    stdout: StdioCollector { id: demoBindsOut }
    onExited: root.binds = Model.parseBinds(demoBindsOut.text)
  }

  Timer {
    id: demoTimer
    repeat: false
    onTriggered: {
      var step = root.demoScript[root.demoIndex]
      if (!step) return
      root.feed(step[1])
      root.demoIndex += 1
      var next = root.demoScript[root.demoIndex]
      if (next) {
        interval = next[0]
        restart()
      }
    }
  }

  // ---- IPC: omarchy-shell keycast <method> ----
  IpcHandler {
    target: "keycast"

    function pause(): string { root.paused = true; return "paused" }
    function resume(): string { root.paused = false; return "live" }
    function togglePause(): string {
      root.paused = !root.paused
      root.notify(root.paused ? "keycast paused" : "keycast resumed", root.paused ? "Typed text is hidden until you resume." : "")
      return root.paused ? "paused" : "live"
    }
    function demo(): string { root.startDemo(); return "ok" }
    function preview(): string { root.startPreview(); return "ok" }
    function toggle(): string {
      root.setSetting("enabled", !root.castEnabled)
      root.notify(root.castEnabled ? "keycast on" : "keycast off",
                  root.castEnabled ? "Keys will show in recordings." : "Recordings won't show keys until you turn it back on.")
      return root.castEnabled ? "on" : "off"
    }
    function enable(): string { root.setSetting("enabled", true); return "on" }
    function setClicks(value: string): string {
      root.setSetting("showClicks", value === "on" || value === "true")
      return root.showClicks ? "on" : "off"
    }
    function disable(): string { root.setSetting("enabled", false); return "off" }
    function toggleClicks(): string {
      root.setSetting("showClicks", !root.showClicks)
      return root.showClicks ? "on" : "off"
    }
    function setSuperOnly(value: string): string {
      root.setSetting("superOnly", value === "on" || value === "true")
      return root.superOnly ? "on" : "off"
    }
    function toggleSuperOnly(): string {
      root.setSetting("superOnly", !root.superOnly)
      root.notify(root.superOnly ? "keycast: SUPER only" : "keycast: all keys",
                  root.superOnly ? "Only keys pressed while holding SUPER will show." : "All keys will show.")
      return root.superOnly ? "on" : "off"
    }
    function setSize(size: string): string {
      if (!Model.SIZES.hasOwnProperty(size)) return "unknown size: use small, medium, or large"
      root.setSetting("size", size)
      root.startPreview()
      return size
    }
    function status(): string {
      return JSON.stringify({
        recording: root.recording,
        target: root.target,
        helper: root.helperStatus,
        lastError: root.lastError,
        paused: root.paused,
        locked: root.locked,
        sensitiveWindow: root.sensitiveWindow,
        sensitiveLayers: root.sensitiveLayerCount,
        textHidden: root.suppressText,
        enabled: root.castEnabled,
        size: root.sizeName,
        showClicks: root.showClicks,
        superOnly: root.superOnly,
        binds: root.binds.length,
      })
    }
    function ping(): string { return "ok" }
    function version(): string { return "0.3.0" }
  }
}
