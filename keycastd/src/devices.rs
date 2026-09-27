//! Finds the input devices worth listening to and classifies them.

use std::path::PathBuf;

use evdev::{AbsoluteAxisCode, Device, KeyCode, PropType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Roles {
    pub keyboard: bool,
    pub pointer: bool,
    /// ABS_X range for touchpads that tap detection should watch.
    pub touchpad_width: Option<i32>,
}

pub struct Found {
    pub path: PathBuf,
    pub name: String,
    pub roles: Roles,
    pub device: Device,
}

pub fn classify(device: &Device) -> Roles {
    let keys = device.supported_keys();
    let has = |k: KeyCode| keys.is_some_and(|set| set.contains(k));
    let props = device.properties();

    // Power buttons, lid switches, and media remotes expose a handful of keys;
    // a real keyboard has letters and Enter.
    let keyboard = has(KeyCode::KEY_A) && has(KeyCode::KEY_Z) && has(KeyCode::KEY_ENTER);

    // Touchscreens and tablets map directly to the screen; clicks there are
    // already visible, and BTN_TOUCH on them is not a click.
    let direct = props.contains(PropType::DIRECT);
    let pointer = !direct && has(KeyCode::BTN_LEFT);

    let is_touchpad = pointer
        && has(KeyCode::BTN_TOOL_FINGER)
        && device.supported_absolute_axes().is_some_and(|a| a.contains(AbsoluteAxisCode::ABS_X));
    let touchpad_width = if is_touchpad {
        device
            .get_absinfo()
            .ok()
            .and_then(|mut infos| infos.find(|(axis, _)| *axis == AbsoluteAxisCode::ABS_X))
            .map(|(_, info)| (info.maximum() - info.minimum()).max(1))
    } else {
        None
    };

    Roles { keyboard, pointer, touchpad_width }
}

/// Open every readable device that is a keyboard or a pointer.
/// Devices we can't open (permissions) are skipped silently.
pub fn discover(want_pointer: bool) -> Vec<Found> {
    let mut found: Vec<Found> = evdev::enumerate()
        .filter_map(|(path, device)| {
            let mut roles = classify(&device);
            if !want_pointer {
                roles.pointer = false;
                roles.touchpad_width = None;
            }
            if !roles.keyboard && !roles.pointer {
                return None;
            }
            let name = device.name().unwrap_or("unknown").to_string();
            Some(Found { path, name, roles, device })
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}
