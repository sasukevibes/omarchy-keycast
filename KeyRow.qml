import QtQuick
import qs.Commons

// One line of the overlay: a combo of key caps, a line of typed text, or a
// click, with an optional repeat counter and Hyprland bind description.
Item {
  id: row

  required property int rid
  required property string kind
  required property string caps
  required property string text
  required property string desc
  required property int count
  required property bool masked
  required property double updated
  property var service: null

  readonly property real s: service ? service.scale : 1
  readonly property int fontPx: Math.round(Style.fontPx(1.75) * s)
  readonly property int smallPx: Math.round(fontPx * 0.72)
  readonly property var capList: caps ? caps.split("\u001f") : []
  readonly property bool fresh: service ? service.now - updated < service.fadeMs : true

  implicitWidth: content.implicitWidth
  implicitHeight: content.implicitHeight
  width: implicitWidth
  height: implicitHeight

  opacity: fresh ? 1 : 0
  Behavior on opacity { NumberAnimation { duration: row.service ? row.service.fadeOutMs : 250 } }

  // Pop in when created, and nudge again whenever the row updates.
  scale: 1
  onUpdatedChanged: bump.restart()
  Component.onCompleted: enter.start()
  NumberAnimation { id: enter; target: row; property: "scale"; from: 0.85; to: 1; duration: 140; easing.type: Easing.OutBack }
  SequentialAnimation {
    id: bump
    NumberAnimation { target: row; property: "scale"; to: 1.04; duration: 50 }
    NumberAnimation { target: row; property: "scale"; to: 1; duration: 90; easing.type: Easing.OutQuad }
  }

  Row {
    id: content
    spacing: Math.round(Style.space(6) * row.s)

    // Typed text: one wide cap holding the running line.
    Keycap {
      visible: row.kind === "text"
      label: row.text
      s: row.s
      fontPx: row.fontPx
      bold: false
      muted: row.masked
    }

    Repeater {
      model: row.kind === "text" ? [] : row.capList
      delegate: Row {
        required property string modelData
        required property int index
        spacing: Math.round(Style.space(6) * row.s)

        Text {
          visible: index > 0
          anchors.verticalCenter: parent.verticalCenter
          text: "+"
          color: Color.foreground
          style: Text.Outline
          styleColor: Util.alpha(Color.background, 0.8)
          font.family: Style.font.family
          font.pixelSize: row.smallPx
          font.bold: true
        }

        Keycap {
          label: modelData
          s: row.s
          fontPx: row.fontPx
        }
      }
    }

    Keycap {
      visible: row.count > 1
      anchors.verticalCenter: parent.verticalCenter
      label: "×" + row.count
      s: row.s
      fontPx: row.smallPx
      accent: true
      flat: true
    }

    Keycap {
      visible: row.desc !== ""
      anchors.verticalCenter: parent.verticalCenter
      label: row.desc
      s: row.s
      fontPx: row.smallPx
      accent: true
      flat: true
      bold: false
    }
  }
}
