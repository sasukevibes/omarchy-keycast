import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar button and settings panel for keycast. It works on any bar, including
// replacement bars that can't reach the service directly: it reads the
// state file the service publishes and changes settings over IPC.
Panel {
  id: root
  moduleName: "sasukevibes.keycast"
  ipcTarget: "sasukevibes.keycast"

  property var state: ({})
  readonly property bool ready: state.enabled !== undefined
  readonly property bool castEnabled: state.enabled !== false
  readonly property bool showClicks: state.showClicks !== false
  readonly property string sizeName: state.size === undefined ? "medium" : state.size
  readonly property bool live: !!state.recording && state.helper === "live"
  readonly property var sizes: ["small", "medium", "large"]

  readonly property string statusText: {
    if (!ready) return "Starting…"
    if (!castEnabled) return "Off. Recordings won't show keys."
    if (state.helper === "missing") return "Helper not installed. Run install.sh."
    if (state.helper === "failed") return "Couldn't read keys. See `omarchy-shell keycast status`."
    if (live) return "Showing keys in this recording."
    if (state.recording) return "Starting…"
    return "Ready. Keys show when you start a recording."
  }

  FileView {
    id: stateFile
    path: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/keycast/state.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      // A read that races a write can see half a file; keep what we had.
      try { root.state = JSON.parse(text()) || {} } catch (e) {}
    }
  }

  // The file may not exist yet when the bar loads, and a watch can't be set
  // on a missing file, so keep trying until the first read succeeds.
  Timer {
    interval: 1000
    repeat: true
    running: !root.ready
    onTriggered: stateFile.reload()
  }

  function send(args) {
    Quickshell.execDetached(["omarchy-shell", "keycast"].concat(args))
  }

  function setEnabled(on) { send([on ? "enable" : "disable"]) }
  function setClicks(on) { send(["setClicks", on ? "on" : "off"]) }
  function chooseSize(name) { send(["setSize", name]) }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // nf-md-keyboard / nf-md-keyboard_off
    text: root.castEnabled ? "󰌌" : "󰌐"
    active: root.live
    dimmed: !root.castEnabled
    tooltipText: root.opened ? "" : (root.castEnabled ? "keycast: on" : "keycast: off") + " · right-click to toggle"
    onPressed: function(b) {
      if (b === Qt.RightButton) root.setEnabled(!root.castEnabled)
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Column {
          width: parent.width
          spacing: Style.space(4)

          Text {
            text: "keycast"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            width: parent.width
            text: root.statusText
            color: Util.alpha(root.bar.foreground, 0.7)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        Toggle {
          width: parent.width
          label: "Show keystrokes"
          description: "Draw keys on screen while recording."
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          checked: root.castEnabled
          onClicked: root.setEnabled(!root.castEnabled)
        }

        Toggle {
          width: parent.width
          label: "Show mouse clicks"
          description: "Click caps and a ring at the pointer."
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          checked: root.showClicks
          onClicked: root.setClicks(!root.showClicks)
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Column {
          width: parent.width
          spacing: Style.space(10)

          PanelSectionHeader {
            text: "SIZE"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Row {
            id: sizeRow
            width: parent.width
            spacing: Style.space(6)
            readonly property real cellWidth: (width - spacing * (root.sizes.length - 1)) / root.sizes.length

            Repeater {
              model: root.sizes
              Button {
                required property string modelData
                width: sizeRow.cellWidth
                text: modelData.charAt(0).toUpperCase()
                Accessible.name: modelData.charAt(0).toUpperCase() + modelData.slice(1)
                fontSize: Style.font.bodySmall
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
                bordered: true
                active: root.sizeName === modelData
                onClicked: root.chooseSize(modelData)
              }
            }
          }
        }
      }
    }
  }
}
