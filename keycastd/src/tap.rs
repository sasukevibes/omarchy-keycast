//! Touchpad tap detection.
//!
//! libinput turns taps into clicks inside the compositor, so the raw evdev
//! stream from a touchpad only carries touches. This mirrors libinput's rule
//! closely enough for an overlay: a touch that lifts within `TAP_MS` and
//! barely moves is a tap, with the finger count choosing the button.

const TAP_MS: u64 = 180;
/// Movement allowed during a tap, as a fraction of the pad's width.
const MOVE_FRACTION: f64 = 0.03;

#[derive(Debug, Default)]
pub struct TapDetector {
    move_limit: i32,
    touching: bool,
    started_ms: u64,
    origin: (Option<i32>, Option<i32>),
    moved: bool,
    clicked: bool,
    fingers: u8,
}

impl TapDetector {
    /// `width` is the ABS_X range (max - min) of the touchpad.
    pub fn new(width: i32) -> TapDetector {
        TapDetector { move_limit: ((width as f64) * MOVE_FRACTION).max(1.0) as i32, ..Default::default() }
    }

    pub fn touch(&mut self, down: bool, at_ms: u64) -> Option<&'static str> {
        if down {
            *self = TapDetector { move_limit: self.move_limit, touching: true, started_ms: at_ms, fingers: self.fingers.max(1), ..Default::default() };
            return None;
        }
        if !self.touching {
            return None;
        }
        self.touching = false;
        let fingers = std::mem::take(&mut self.fingers);
        let quick = at_ms.saturating_sub(self.started_ms) <= TAP_MS;
        if !quick || self.moved || self.clicked {
            return None;
        }
        match fingers {
            0 | 1 => Some("left"),
            2 => Some("right"),
            3 => Some("middle"),
            _ => None,
        }
    }

    /// BTN_TOOL_FINGER (1), DOUBLETAP (2), TRIPLETAP (3), QUADTAP (4).
    pub fn fingers(&mut self, count: u8) {
        self.fingers = self.fingers.max(count);
    }

    pub fn position(&mut self, axis_x: bool, value: i32) {
        if !self.touching {
            return;
        }
        let origin = if axis_x { &mut self.origin.0 } else { &mut self.origin.1 };
        match origin {
            None => *origin = Some(value),
            Some(start) if (value - *start).abs() > self.move_limit => self.moved = true,
            Some(_) => {}
        }
    }

    /// A physical button press during the touch means this was a click, not a tap.
    /// Returns the button a clickpad press should be shown as: two fingers
    /// resting on the pad make it a right click, as libinput's clickfinger does.
    pub fn physical_click(&mut self) -> &'static str {
        self.clicked = true;
        if self.fingers == 2 { "right" } else if self.fingers == 3 { "middle" } else { "left" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad() -> TapDetector {
        TapDetector::new(1000)
    }

    #[test]
    fn quick_still_touch_is_left_tap() {
        let mut t = pad();
        t.touch(true, 0);
        t.fingers(1);
        t.position(true, 500);
        t.position(false, 300);
        t.position(true, 505);
        assert_eq!(t.touch(false, 90), Some("left"));
    }

    #[test]
    fn two_finger_tap_is_right() {
        let mut t = pad();
        t.touch(true, 0);
        t.fingers(1);
        t.fingers(2);
        assert_eq!(t.touch(false, 120), Some("right"));
    }

    #[test]
    fn three_finger_tap_is_middle() {
        let mut t = pad();
        t.touch(true, 0);
        t.fingers(3);
        assert_eq!(t.touch(false, 120), Some("middle"));
    }

    #[test]
    fn slow_touch_is_not_a_tap() {
        let mut t = pad();
        t.touch(true, 0);
        assert_eq!(t.touch(false, 400), None);
    }

    #[test]
    fn moving_touch_is_not_a_tap() {
        let mut t = pad();
        t.touch(true, 0);
        t.position(true, 100);
        t.position(true, 200);
        assert_eq!(t.touch(false, 100), None);
    }

    #[test]
    fn physical_click_suppresses_tap_and_uses_finger_count() {
        let mut t = pad();
        t.touch(true, 0);
        t.fingers(2);
        assert_eq!(t.physical_click(), "right");
        assert_eq!(t.touch(false, 100), None);
    }

    #[test]
    fn finger_count_resets_between_touches() {
        let mut t = pad();
        t.touch(true, 0);
        t.fingers(2);
        t.touch(false, 100);
        t.touch(true, 1000);
        t.fingers(1);
        assert_eq!(t.touch(false, 1100), Some("left"));
    }

    #[test]
    fn release_without_touch_is_ignored() {
        let mut t = pad();
        assert_eq!(t.touch(false, 10), None);
    }
}
