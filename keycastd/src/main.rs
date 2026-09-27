//! keycastd: reads keyboards and pointers and prints keycast protocol events
//! as JSON lines on stdout. Started by the keycast Omarchy plugin through
//! pkexec while a screen recording runs. See docs/DESIGN.md.

mod devices;
mod privilege;
mod protocol;
mod tap;
mod translate;

use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use evdev::{AbsoluteAxisCode, EventSummary, InputEvent, KeyCode};

use protocol::{Event, PROTOCOL_VERSION};
use tap::TapDetector;
use translate::{KeymapNames, Translator};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const GATE_INTERVAL: Duration = Duration::from_millis(500);

const USAGE: &str = "\
keycastd - print keystrokes and clicks as JSON lines for the keycast overlay

Usage: keycastd [options]

  --layout <l>          xkb layout (default: us)
  --variant <v>         xkb variant
  --options <o>         xkb options, comma separated
  --model <m>           xkb model
  --taps                report touchpad taps as clicks (match tap-to-click)
  --no-pointer          do not report clicks
  --require-recording   exit unless gpu-screen-recorder runs (always on under pkexec)
  --list-devices        print the devices keycastd would read, then exit
  --version, --help
";

struct Options {
    keymap: KeymapNames,
    taps: bool,
    pointer: bool,
    require_recording: bool,
    list_devices: bool,
}

fn parse_args() -> Result<Options, String> {
    let mut opts = Options {
        keymap: KeymapNames::default(),
        taps: false,
        pointer: true,
        require_recording: false,
        list_devices: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--layout" => opts.keymap.layout = value("--layout")?,
            "--variant" => opts.keymap.variant = value("--variant")?,
            "--options" => opts.keymap.options = value("--options")?,
            "--model" => opts.keymap.model = value("--model")?,
            "--taps" => opts.taps = true,
            "--no-pointer" => opts.pointer = false,
            "--require-recording" => opts.require_recording = true,
            "--list-devices" => opts.list_devices = true,
            "--version" => {
                println!("keycastd {VERSION}");
                std::process::exit(0);
            }
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    // Hyprland reports multiple layouts as "us,de"; xkb takes the same form.
    if opts.keymap.layout.is_empty() {
        opts.keymap.layout = "us".into();
    }
    Ok(opts)
}

/// Writes events to stdout; a closed pipe means the plugin is gone.
fn emit(event: &Event) {
    let mut out = io::stdout().lock();
    if writeln!(out, "{}", event.to_line()).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn fail(message: String) -> ExitCode {
    emit(&Event::Error { message: message.clone() });
    eprintln!("keycastd: {message}");
    ExitCode::FAILURE
}

fn millis(event: &InputEvent) -> u64 {
    event.timestamp().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct DeviceState {
    keyboard: bool,
    pointer: bool,
    tap: Option<TapDetector>,
}

fn main() -> ExitCode {
    let mut opts = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprint!("keycastd: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    // Under pkexec: refuse to start without a recording, open devices as
    // root, then become the invoking user for everything else.
    let privileged = privilege::running_as_root();
    if privileged {
        opts.require_recording = true;
    }
    let owner = if privileged {
        match privilege::pkexec_uid() {
            Some(uid) if uid != 0 => uid,
            _ => return fail("refusing to run as root outside pkexec".into()),
        }
    } else {
        privilege::current_uid()
    };
    if opts.require_recording && !opts.list_devices && !privilege::recording_active(owner) {
        return fail("no screen recording is running".into());
    }

    let found = devices::discover(opts.pointer);

    if privileged {
        if let Err(e) = privilege::drop_to(owner) {
            return fail(format!("could not drop privileges: {e}"));
        }
        privilege::die_with_parent();
    }

    if opts.list_devices {
        for d in &found {
            let r = d.roles;
            println!(
                "{}\t{}\tkeyboard={} pointer={} touchpad={}",
                d.path.display(),
                d.name,
                r.keyboard,
                r.pointer,
                r.touchpad_width.is_some()
            );
        }
        return ExitCode::SUCCESS;
    }

    if found.is_empty() {
        return fail(if privileged {
            "no keyboards or pointers found".into()
        } else {
            "no readable input devices; run through pkexec or join the input group".into()
        });
    }

    let mut translator = match Translator::new(&opts.keymap) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };

    let count = |f: fn(&devices::Roles) -> bool| found.iter().filter(|d| f(&d.roles)).count();
    emit(&Event::Hello {
        v: PROTOCOL_VERSION,
        version: VERSION,
        keyboards: count(|r| r.keyboard),
        pointers: count(|r| r.pointer),
        touchpads: if opts.taps { count(|r| r.touchpad_width.is_some()) } else { 0 },
        gated: opts.require_recording,
    });

    let (tx, rx) = mpsc::channel::<(usize, Vec<InputEvent>)>();
    let mut states = Vec::new();
    for (index, mut d) in found.into_iter().enumerate() {
        states.push(DeviceState {
            keyboard: d.roles.keyboard,
            pointer: d.roles.pointer,
            tap: d.roles.touchpad_width.filter(|_| opts.taps).map(TapDetector::new),
        });
        let tx = tx.clone();
        thread::spawn(move || {
            // A device error (usually unplugged) just ends this reader.
            while let Ok(batch) = d.device.fetch_events() {
                if tx.send((index, batch.collect())).is_err() {
                    return;
                }
            }
        });
    }
    drop(tx);

    let mut last_gate = Instant::now();
    loop {
        match rx.recv_timeout(GATE_INTERVAL) {
            Ok((index, events)) => {
                for event in events {
                    if let Some(out) = handle(&mut translator, &mut states[index], &event) {
                        emit(&out);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                emit(&Event::Bye { reason: "devices-gone".into() });
                return ExitCode::SUCCESS;
            }
        }
        if opts.require_recording && last_gate.elapsed() >= GATE_INTERVAL {
            last_gate = Instant::now();
            if !privilege::recording_active(owner) {
                emit(&Event::Bye { reason: "recording-stopped".into() });
                return ExitCode::SUCCESS;
            }
        }
    }
}

fn handle(translator: &mut Translator, dev: &mut DeviceState, event: &InputEvent) -> Option<Event> {
    match event.destructure() {
        EventSummary::Key(_, code, value) => {
            if let Some(button) = Translator::button_name(code.code()) {
                if !dev.pointer || value != 1 {
                    return None;
                }
                let button = match (&mut dev.tap, code) {
                    (Some(tap), KeyCode::BTN_LEFT) => tap.physical_click(),
                    _ => button,
                };
                return Some(translator.click(button, false));
            }
            if let Some(tap) = &mut dev.tap {
                let fingers = match code {
                    KeyCode::BTN_TOOL_FINGER => Some(1),
                    KeyCode::BTN_TOOL_DOUBLETAP => Some(2),
                    KeyCode::BTN_TOOL_TRIPLETAP => Some(3),
                    KeyCode::BTN_TOOL_QUADTAP => Some(4),
                    _ => None,
                };
                if let Some(n) = fingers {
                    if value == 1 {
                        tap.fingers(n);
                    }
                    return None;
                }
                if code == KeyCode::BTN_TOUCH {
                    let button = tap.touch(value == 1, millis(event))?;
                    return Some(translator.click(button, true));
                }
            }
            // Mice only report buttons, and BTN_* codes were handled above.
            if dev.keyboard && !(0x100..0x160).contains(&code.code()) {
                return translator.key(code.code(), value);
            }
            None
        }
        EventSummary::AbsoluteAxis(_, axis, value) => {
            let tap = dev.tap.as_mut()?;
            match axis {
                AbsoluteAxisCode::ABS_X => tap.position(true, value),
                AbsoluteAxisCode::ABS_Y => tap.position(false, value),
                _ => {}
            }
            None
        }
        _ => None,
    }
}
