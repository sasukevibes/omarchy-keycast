import QtQuick
import qs.Commons

// Expanding ring drawn where a click happened.
Item {
  id: ripple

  property real cx: 0
  property real cy: 0
  property real s: 1
  property bool secondary: false
  property real progress: 0

  readonly property real maxRadius: Style.space(26) * s

  x: cx
  y: cy

  Rectangle {
    readonly property real r: ripple.maxRadius * (0.25 + 0.75 * ripple.progress)
    x: -r
    y: -r
    width: r * 2
    height: r * 2
    radius: r
    color: Util.alpha(ripple.secondary ? Color.urgent : Color.accent, 0.18 * (1 - ripple.progress))
    border.color: ripple.secondary ? Color.urgent : Color.accent
    border.width: Math.max(2, Math.round(3 * ripple.s))
    opacity: 1 - ripple.progress
  }

  NumberAnimation on progress { from: 0; to: 1; duration: 450; easing.type: Easing.OutCubic }
}
