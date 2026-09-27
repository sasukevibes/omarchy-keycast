// Exercise the real QML widget, IPC, service and config files on a private
// headless Wayland display. External commands use fakes; no input devices or
// desktop IPC. Sway is only the test compositor, not a runtime dependency.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const { once } = require("node:events")
const { setTimeout: delay } = require("node:timers/promises")

const plugin = path.resolve(__dirname, "..")
const shell = path.join(process.env.OMARCHY_PATH || "/usr/share/omarchy", "shell")
const available = spawnSync("quickshell", ["--version"]).status === 0
  && spawnSync("sway", ["--version"]).status === 0 && fs.existsSync(path.join(shell, "Ui"))

test("settings widget updates the service, stops overlays and persists choices", {
  skip: available ? false : "requires Quickshell, Sway and the Omarchy shell UI",
  timeout: 30000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "keycast-settings-"))
  let child
  let display
  let log = ""
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, ".config"),
    XDG_CACHE_HOME: path.join(directory, ".cache"),
    XDG_STATE_HOME: path.join(directory, ".state"),
    XDG_RUNTIME_DIR: directory,
    QT_QPA_PLATFORM: "wayland",
    QT_QUICK_BACKEND: "software",
    QT_QPA_PLATFORMTHEME: "basic",
    KEYCAST_TEST_PLUGIN: plugin,
    KEYCAST_TEST_DIR: directory,
    PATH: path.join(directory, "bin") + ":" + process.env.PATH,
  }
  for (const key of Object.keys(env))
    if (/^(WAYLAND_DISPLAY|DISPLAY|HYPRLAND.*|SWAYSOCK|DBUS_SESSION_BUS_ADDRESS|QS_.*|QML.*IMPORT_PATH)$/.test(key)) delete env[key]

  function script(name, contents) {
    fs.writeFileSync(path.join(directory, "bin", name), "#!/bin/bash\n" + contents + "\n", { mode: 0o755 })
  }
  function ipc(target, method, ...args) {
    const result = spawnSync("quickshell", ["ipc", "-p", directory, "--any-display", "call", target, method, ...args.map(String)], {
      env, encoding: "utf8", timeout: 3000,
    })
    if (result.status !== 0) throw new Error(result.stdout + result.stderr)
    return result.stdout.trim()
  }
  function state() { return JSON.parse(ipc("test", "state")) }
  async function until(check) {
    const deadline = Date.now() + 5000
    let failure
    while (Date.now() < deadline) {
      try { if (check()) return } catch (error) { failure = error }
      await delay(30)
    }
    assert.fail("Timed out: " + (failure || check.toString()) + "\n" + log)
  }
  async function start() {
    child = spawn("quickshell", ["-p", directory, "--no-color"], { env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", data => { log += data })
    child.stderr.on("data", data => { log += data })
    await until(() => state().ready)
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
  }

  try {
    const displayConfig = path.join(directory, "sway.conf")
    fs.writeFileSync(displayConfig, "xwayland disable\nswaybg_command /bin/true\noutput * mode 1280x800\n")
    display = spawn("sway", ["--config", displayConfig], {
      env: { ...env, WLR_BACKENDS: "headless", WLR_RENDERER: "pixman", WLR_HEADLESS_OUTPUTS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    })
    display.stderr.on("data", data => { log += data })
    await until(() => fs.readdirSync(directory).some(name => /^wayland-\d+$/.test(name)))
    env.WAYLAND_DISPLAY = fs.readdirSync(directory).find(name => /^wayland-\d+$/.test(name))
    fs.mkdirSync(path.join(directory, "bin"))
    for (const name of ["Ui", "Commons"]) fs.symlinkSync(path.join(shell, name), path.join(directory, name))
    fs.copyFileSync(path.join(__dirname, "settings.qml"), path.join(directory, "shell.qml"))
    script("pgrep", 'test -f "$KEYCAST_TEST_DIR/recording" || exit 1\necho "123 gpu-screen-recorder -w test"')
    script("hyprctl", 'if [[ $1 == cursorpos ]]; then sleep 0.3; echo \'{"x":100,"y":100}\'; elif [[ $1 == binds ]]; then echo "[]"; else echo "{}"; fi')
    script("omarchy-shell", 'if [[ $1 == -q ]]; then echo false; else exec quickshell ipc -p "$KEYCAST_TEST_DIR" --any-display call "$@"; fi')
    script("omarchy-notification-send", "exit 0")
    script("pkexec", "exit 99")

    const configPath = path.join(directory, ".config/keycast/config.json")
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ scale: 1.2, showBindLabels: false, helperCommand: [path.join(plugin, "tests/fake-keycastd")] }))
    const config = () => JSON.parse(fs.readFileSync(configPath, "utf8"))
    await start()
    assert.equal(state().size, "", "custom scales must not highlight Medium")

    for (const [size, scale] of [["small", 0.75], ["medium", 1], ["large", 1.35]]) {
      ipc("test", "size", size)
      await until(() => state().size === size && state().scale === scale && config().size === size)
    }
    ipc("test", "open")
    await delay(200)
    if (process.env.KEYCAST_TEST_SCREENSHOT) {
      const capture = spawnSync("grim", [process.env.KEYCAST_TEST_SCREENSHOT], { env, encoding: "utf8" })
      assert.equal(capture.status, 0, capture.stderr)
    }
    ipc("test", "close")
    await until(() => state().rows > 0)
    ipc("test", "enable", false)
    await until(() => state().enabled === false && config().enabled === false)
    await delay(500)
    assert.equal(state().active, false)
    assert.equal(state().demo, false)
    assert.equal(state().rows, 0, "queued demo keys must not reappear after disabling")
    ipc("test", "size", "small")
    await until(() => config().size === "small")
    ipc("keycast", "demo")
    ipc("test", "lateHello")
    assert.equal(state().demo, false, "disabled demos must not start")
    assert.equal(state().helper, "off", "late helper output must not restore live status")

    ipc("test", "enable", true)
    await until(() => state().enabled)
    ipc("keycast", "preview")
    await until(() => state().rows > 0)
    ipc("test", "click")
    ipc("test", "clicks", false)
    await until(() => state().clicks === false && config().showClicks === false)
    await delay(400)
    assert.equal(state().ripples, 0, "pending pointer lookups must not show disabled clicks")

    fs.writeFileSync(path.join(directory, "recording"), "")
    await until(() => state().helper === "live")
    assert.equal(state().demo, false, "starting a recording cancels the preview")
    ipc("keycast", "demo")
    assert.equal(state().demo, false, "demo must not inject sample keys into recordings")
    ipc("test", "enable", false)
    await until(() => state().helper === "off" && state().enabled === false && config().enabled === false)
    await delay(300)
    assert.equal(state().rows, 0)
    ipc("test", "enable", true)
    await until(() => state().helper === "live" && config().enabled === true)
    ipc("test", "clicks", true)
    await until(() => state().clicks && config().showClicks === true)
    fs.unlinkSync(path.join(directory, "recording"))
    await until(() => state().helper === "idle")

    assert.equal(config().showBindLabels, false, "widget must preserve unrelated settings")
    await stop()
    await start()
    await until(() => state().size === "small" && state().enabled && state().clicks)
    assert.equal(state().scale, 0.75)
    assert.doesNotMatch(log, /TypeError|ReferenceError|Binding loop|Error loading configuration|Could not create attached|Unable to assign/)
  } finally {
    await stop()
    if (display && display.exitCode === null && display.signalCode === null) {
      const exited = once(display, "exit")
      display.kill()
      await exited
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
