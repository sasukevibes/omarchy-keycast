import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons

// One click-through layer surface per screen. Keys are drawn at the bottom
// (or top) centre of the recorded area; ripples wherever the pointer clicked.
PanelWindow {
  id: win

  required property var modelData
  property var service: null

  screen: modelData
  visible: !!service && service.active
  color: "transparent"
  anchors { top: true; bottom: true; left: true; right: true }
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "keycast"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
  // Visual only: an empty input region so it never takes a click.
  mask: Region {}

  readonly property var area: service ? service.areaOn(modelData) : null
  readonly property real s: service ? service.scale : 1
  readonly property int margin: area ? Math.round(Math.min(Style.space(64) * s, area.h * 0.08)) : 0

  Column {
    id: stack
    visible: !!win.area
    spacing: Math.round(Style.space(8) * win.s)
    x: win.area ? Math.round(win.area.x + (win.area.w - width) / 2) : 0
    y: !win.area ? 0
      : win.service.position === "top" ? win.area.y + win.margin
      : win.area.y + win.area.h - win.margin - height

    move: Transition { NumberAnimation { properties: "y"; duration: 140; easing.type: Easing.OutCubic } }

    Repeater {
      model: win.service ? win.service.rows : null
      delegate: KeyRow {
        anchors.horizontalCenter: parent ? parent.horizontalCenter : undefined
        service: win.service
      }
    }
  }

  Repeater {
    model: win.service ? win.service.ripples : null
    delegate: Ripple {
      required property real px
      required property real py
      required property string button
      cx: px - win.modelData.x
      cy: py - win.modelData.y
      visible: cx >= 0 && cy >= 0 && cx < win.width && cy < win.height
      s: win.s
      secondary: button !== "left"
    }
  }
}
