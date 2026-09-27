import QtQuick
import qs.Commons

// A key cap in the current Omarchy theme's colours: a face sitting on a
// darker lip so it reads as a physical key on any background.
Item {
  id: cap

  property string label: ""
  property real s: 1
  property int fontPx: 20
  property bool bold: true
  property bool muted: false
  property bool accent: false
  // Flat caps (counters, bind labels) have no lip.
  property bool flat: false

  readonly property int lip: flat ? 0 : Math.max(2, Math.round(3 * s))
  readonly property int padX: Math.round(fontPx * 0.6)
  readonly property int padY: Math.round(fontPx * 0.32)
  readonly property int radius: Math.max(Style.cornerRadius, Math.round(fontPx * 0.35))
  readonly property color faceColor: Util.alpha(Color.popups.background, 0.94)
  readonly property color edgeColor: accent ? Color.accent : Color.popups.border
  readonly property color textColor: accent ? Color.accent : (muted ? Color.muted : Color.popups.text)

  implicitWidth: face.width
  implicitHeight: face.height + lip
  width: implicitWidth
  height: implicitHeight

  Rectangle {
    visible: !cap.flat
    y: cap.lip
    width: face.width
    height: face.height
    radius: cap.radius
    color: Qt.darker(cap.edgeColor, 1.8)
  }

  Rectangle {
    id: face
    width: Math.max(height, labelText.implicitWidth + cap.padX * 2)
    height: labelText.implicitHeight + cap.padY * 2
    radius: cap.radius
    color: cap.faceColor
    border.color: Util.alpha(cap.edgeColor, cap.flat ? 0.6 : 0.9)
    border.width: Math.max(1, Math.round(1.5 * cap.s))

    Text {
      id: labelText
      anchors.centerIn: parent
      text: cap.label
      color: cap.textColor
      font.family: Style.font.family
      font.pixelSize: cap.fontPx
      font.bold: cap.bold
      textFormat: Text.PlainText
    }
  }
}
