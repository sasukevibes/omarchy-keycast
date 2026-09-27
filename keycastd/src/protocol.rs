//! The line-delimited JSON protocol keycastd writes to stdout. See docs/DESIGN.md.

use serde::Serialize;

pub const PROTOCOL_VERSION: u32 = 1;

/// Held modifiers, in the fixed display order SUPER, CTRL, ALT, SHIFT.
pub type Mods = Vec<&'static str>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Hello {
        v: u32,
        version: &'static str,
        keyboards: usize,
        pointers: usize,
        touchpads: usize,
        gated: bool,
    },
    Key {
        /// evdev keycode (Hyprland's `code:` binds use this + 8).
        code: u16,
        /// xkb keysym name at shift level 0, e.g. "Return", "c", "1".
        sym: String,
        /// Printable text the key produced, or "" when it typed nothing
        /// printable or a non-shift modifier was held.
        text: String,
        mods: Mods,
        repeat: bool,
    },
    /// A modifier pressed and released without any other key or click.
    Mod { sym: String, mods: Mods },
    Click {
        button: &'static str,
        mods: Mods,
        /// Synthesized from a touchpad tap rather than a physical button.
        tap: bool,
    },
    Bye { reason: String },
    Error { message: String },
}

impl Event {
    pub fn to_line(&self) -> String {
        // Serializing these plain structs cannot fail.
        serde_json::to_string(self).expect("event serializes")
    }
}
