//! Turns raw evdev key and button events into protocol events, using one
//! xkbcommon state shared by every keyboard so labels follow the user's layout.

use std::collections::HashMap;

use xkbcommon::xkb;

use crate::protocol::{Event, Mods};

/// evdev keycodes are offset by 8 in the XKB keycode space.
const EVDEV_OFFSET: u32 = 8;

const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;
const BTN_SIDE: u16 = 0x113;
const BTN_EXTRA: u16 = 0x114;

const KEY_RELEASE: i32 = 0;
const KEY_PRESS: i32 = 1;
const KEY_REPEAT: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Modifier {
    Super,
    Ctrl,
    Alt,
    Shift,
}

impl Modifier {
    const ORDER: [Modifier; 4] = [Modifier::Super, Modifier::Ctrl, Modifier::Alt, Modifier::Shift];

    fn label(self) -> &'static str {
        match self {
            Modifier::Super => "SUPER",
            Modifier::Ctrl => "CTRL",
            Modifier::Alt => "ALT",
            Modifier::Shift => "SHIFT",
        }
    }

    /// AltGr (ISO_Level3_Shift) is deliberately not a modifier here: on most
    /// non-US layouts it is how people type characters, not shortcuts.
    fn from_keysym_name(name: &str) -> Option<Modifier> {
        match name {
            "Super_L" | "Super_R" | "Hyper_L" | "Hyper_R" => Some(Modifier::Super),
            "Control_L" | "Control_R" => Some(Modifier::Ctrl),
            "Alt_L" | "Alt_R" | "Meta_L" | "Meta_R" => Some(Modifier::Alt),
            "Shift_L" | "Shift_R" => Some(Modifier::Shift),
            _ => None,
        }
    }
}

pub struct KeymapNames {
    pub rules: String,
    pub model: String,
    pub layout: String,
    pub variant: String,
    pub options: String,
}

impl Default for KeymapNames {
    fn default() -> Self {
        KeymapNames {
            rules: "evdev".into(),
            model: String::new(),
            layout: "us".into(),
            variant: String::new(),
            options: String::new(),
        }
    }
}

pub struct Translator {
    keymap: xkb::Keymap,
    state: xkb::State,
    /// Physical modifier keys currently down, by evdev code, so holding both
    /// shifts and releasing one keeps SHIFT held.
    held: HashMap<u16, Modifier>,
    /// A modifier pressed while nothing else was down; cleared by any other
    /// key or click. If it is still set on release, the tap is reported.
    solo: Option<u16>,
}

impl Translator {
    pub fn new(names: &KeymapNames) -> Result<Translator, String> {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let options = (!names.options.is_empty()).then(|| names.options.clone());
        let keymap = xkb::Keymap::new_from_names(
            &context,
            &names.rules,
            &names.model,
            &names.layout,
            &names.variant,
            options,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .ok_or_else(|| format!("could not compile xkb keymap for layout '{}'", names.layout))?;
        let state = xkb::State::new(&keymap);
        Ok(Translator { keymap, state, held: HashMap::new(), solo: None })
    }

    fn mods(&self) -> Mods {
        Modifier::ORDER
            .iter()
            .filter(|m| self.held.values().any(|h| h == *m))
            .map(|m| m.label())
            .collect()
    }

    fn has_shortcut_mod(&self) -> bool {
        self.held.values().any(|m| *m != Modifier::Shift)
    }

    fn base_sym_name(&self, keycode: xkb::Keycode) -> String {
        let layout = self.state.key_get_layout(keycode);
        let sym = self
            .keymap
            .key_get_syms_by_level(keycode, layout, 0)
            .first()
            .copied()
            .unwrap_or_else(|| self.state.key_get_one_sym(keycode));
        xkb::keysym_get_name(sym)
    }

    /// Feed one EV_KEY event for a keyboard key. Returns the event to emit, if any.
    pub fn key(&mut self, code: u16, value: i32) -> Option<Event> {
        let keycode = xkb::Keycode::new(code as u32 + EVDEV_OFFSET);
        let sym = self.base_sym_name(keycode);
        let modifier = Modifier::from_keysym_name(&sym);

        match value {
            KEY_PRESS => {
                if let Some(m) = modifier {
                    self.solo = self.held.is_empty().then_some(code);
                    self.held.insert(code, m);
                    self.state.update_key(keycode, xkb::KeyDirection::Down);
                    return None;
                }
                self.solo = None;
                // Text must be read before the press updates the state.
                let text = self.text_for(keycode);
                self.state.update_key(keycode, xkb::KeyDirection::Down);
                Some(Event::Key { code, sym, text, mods: self.mods(), repeat: false })
            }
            KEY_REPEAT => {
                if modifier.is_some() {
                    return None;
                }
                let text = self.text_for(keycode);
                Some(Event::Key { code, sym, text, mods: self.mods(), repeat: true })
            }
            KEY_RELEASE => {
                self.state.update_key(keycode, xkb::KeyDirection::Up);
                let released = self.held.remove(&code)?;
                if self.solo.take() == Some(code) {
                    return Some(Event::Mod { sym, mods: vec![released.label()] });
                }
                None
            }
            _ => None,
        }
    }

    fn text_for(&self, keycode: xkb::Keycode) -> String {
        if self.has_shortcut_mod() {
            return String::new();
        }
        let text = self.state.key_get_utf8(keycode);
        if text.chars().any(|c| c.is_control()) { String::new() } else { text }
    }

    /// Feed a mouse button press. `tap` marks touchpad-synthesized clicks.
    pub fn click(&mut self, button: &'static str, tap: bool) -> Event {
        self.solo = None;
        Event::Click { button, mods: self.mods(), tap }
    }

    /// Map an EV_KEY button code to its protocol name, for presses only.
    pub fn button_name(code: u16) -> Option<&'static str> {
        match code {
            BTN_LEFT => Some("left"),
            BTN_RIGHT => Some("right"),
            BTN_MIDDLE => Some("middle"),
            BTN_SIDE => Some("back"),
            BTN_EXTRA => Some("forward"),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // evdev codes from linux/input-event-codes.h
    const KEY_A: u16 = 30;
    const KEY_C: u16 = 46;
    const KEY_1: u16 = 2;
    const KEY_ENTER: u16 = 28;
    const KEY_SPACE: u16 = 57;
    const KEY_LEFTSHIFT: u16 = 42;
    const KEY_RIGHTSHIFT: u16 = 54;
    const KEY_LEFTCTRL: u16 = 29;
    const KEY_LEFTMETA: u16 = 125;
    const KEY_RIGHTALT: u16 = 100;
    const KEY_Q: u16 = 16;

    fn us() -> Translator {
        Translator::new(&KeymapNames::default()).unwrap()
    }

    fn tap(t: &mut Translator, code: u16) -> Option<Event> {
        let out = t.key(code, KEY_PRESS);
        t.key(code, KEY_RELEASE);
        out
    }

    fn key(code: u16, sym: &str, text: &str, mods: &[&'static str], repeat: bool) -> Option<Event> {
        Some(Event::Key { code, sym: sym.into(), text: text.into(), mods: mods.to_vec(), repeat })
    }

    #[test]
    fn plain_letter_types_text() {
        let mut t = us();
        assert_eq!(tap(&mut t, KEY_A), key(KEY_A, "a", "a", &[], false));
    }

    #[test]
    fn shift_is_text_not_shortcut() {
        let mut t = us();
        t.key(KEY_LEFTSHIFT, KEY_PRESS);
        assert_eq!(tap(&mut t, KEY_A), key(KEY_A, "a", "A", &["SHIFT"], false));
        assert_eq!(tap(&mut t, KEY_1), key(KEY_1, "1", "!", &["SHIFT"], false));
        assert_eq!(t.key(KEY_LEFTSHIFT, KEY_RELEASE), None);
    }

    #[test]
    fn ctrl_combo_has_no_text_and_ordered_mods() {
        let mut t = us();
        t.key(KEY_LEFTSHIFT, KEY_PRESS);
        t.key(KEY_LEFTCTRL, KEY_PRESS);
        assert_eq!(tap(&mut t, KEY_C), key(KEY_C, "c", "", &["CTRL", "SHIFT"], false));
    }

    #[test]
    fn super_enter() {
        let mut t = us();
        t.key(KEY_LEFTMETA, KEY_PRESS);
        assert_eq!(tap(&mut t, KEY_ENTER), key(KEY_ENTER, "Return", "", &["SUPER"], false));
        // Not a solo tap: a key was pressed while SUPER was held.
        assert_eq!(t.key(KEY_LEFTMETA, KEY_RELEASE), None);
    }

    #[test]
    fn control_characters_are_not_text() {
        let mut t = us();
        assert_eq!(tap(&mut t, KEY_ENTER), key(KEY_ENTER, "Return", "", &[], false));
        assert_eq!(tap(&mut t, KEY_SPACE), key(KEY_SPACE, "space", " ", &[], false));
    }

    #[test]
    fn solo_modifier_tap_is_reported() {
        let mut t = us();
        assert_eq!(t.key(KEY_LEFTMETA, KEY_PRESS), None);
        assert_eq!(
            t.key(KEY_LEFTMETA, KEY_RELEASE),
            Some(Event::Mod { sym: "Super_L".into(), mods: vec!["SUPER"] })
        );
    }

    #[test]
    fn click_cancels_solo_modifier() {
        let mut t = us();
        t.key(KEY_LEFTMETA, KEY_PRESS);
        assert_eq!(
            t.click("left", false),
            Event::Click { button: "left", mods: vec!["SUPER"], tap: false }
        );
        assert_eq!(t.key(KEY_LEFTMETA, KEY_RELEASE), None);
    }

    #[test]
    fn both_shifts_keep_shift_held_until_last_release() {
        let mut t = us();
        t.key(KEY_LEFTSHIFT, KEY_PRESS);
        t.key(KEY_RIGHTSHIFT, KEY_PRESS);
        t.key(KEY_LEFTSHIFT, KEY_RELEASE);
        assert_eq!(tap(&mut t, KEY_A), key(KEY_A, "a", "A", &["SHIFT"], false));
    }

    #[test]
    fn repeat_is_flagged_and_does_not_double_press() {
        let mut t = us();
        t.key(KEY_A, KEY_PRESS);
        assert_eq!(t.key(KEY_A, KEY_REPEAT), key(KEY_A, "a", "a", &[], true));
        t.key(KEY_A, KEY_RELEASE);
    }

    #[test]
    fn layout_is_respected() {
        let mut t = Translator::new(&KeymapNames { layout: "fr".into(), ..Default::default() }).unwrap();
        // AZERTY: the key in QWERTY's Q position types 'a'.
        assert_eq!(tap(&mut t, KEY_Q), key(KEY_Q, "a", "a", &[], false));
    }

    #[test]
    fn altgr_types_rather_than_acting_as_alt() {
        let mut t = Translator::new(&KeymapNames { layout: "de".into(), ..Default::default() }).unwrap();
        t.key(KEY_RIGHTALT, KEY_PRESS);
        // German AltGr+Q is '@'.
        assert_eq!(tap(&mut t, KEY_Q), key(KEY_Q, "q", "@", &[], false));
    }

    #[test]
    fn bad_layout_is_an_error() {
        assert!(Translator::new(&KeymapNames { layout: "no-such-layout".into(), ..Default::default() }).is_err());
    }
}
