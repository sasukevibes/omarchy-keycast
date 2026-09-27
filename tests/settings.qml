import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
  id: root
  property var service: null
  property var widget: null

  PanelWindow {
    id: barWindow
    anchors { left: true; right: true; bottom: true }
    implicitHeight: 26
    color: "#202020"
    WlrLayershell.layer: WlrLayer.Top
    Item { id: host; anchors.fill: parent }
  }

  QtObject {
    id: bar
    property bool vertical: false
    property int barSize: 26
    property string position: "bottom"
    property string fontFamily: "monospace"
    property color foreground: "white"
    property color barForeground: "white"
    property color urgent: "red"
    property bool foregroundAnimationEnabled: false
    property var activePopout: null
    function showTooltip(target, text) {}
    function hideTooltip(target) {}
    function registerClickTarget(target) {}
    function unregisterClickTarget(target) {}
    function requestPopout(owner) { activePopout = owner }
    function releasePopout(owner) { activePopout = null }
  }

  function load(name, props) {
    var component = Qt.createComponent("file://" + Quickshell.env("KEYCAST_TEST_PLUGIN") + "/" + name)
    if (component.status !== Component.Ready) throw new Error(component.errorString())
    var item = component.createObject(host, props || {})
    if (!item) throw new Error(component.errorString())
    return item
  }

  Component.onCompleted: {
    service = load("Service.qml")
    widget = load("BarWidget.qml", { bar: bar })
    widget.width = Qt.binding(function() { return root.widget.implicitWidth })
    widget.height = Qt.binding(function() { return root.widget.implicitHeight })
    widget.x = 400
  }

  IpcHandler {
    target: "test"
    function state(): string {
      return JSON.stringify({
        ready: !!root.widget && root.widget.ready,
        size: root.widget ? root.widget.sizeName : null,
        scale: root.service ? root.service.scale : null,
        active: root.service ? root.service.active : null,
        demo: root.service ? root.service.demoActive : null,
        rows: root.service ? root.service.rows.count : null,
        ripples: root.service ? root.service.ripples.count : null,
        enabled: root.widget ? root.widget.castEnabled : null,
        clicks: root.widget ? root.widget.showClicks : null,
        helper: root.service ? root.service.helperStatus : null,
      })
    }
    function size(value: string): void { root.widget.chooseSize(value) }
    function enable(value: bool): void { root.widget.setEnabled(value) }
    function clicks(value: bool): void { root.widget.setClicks(value) }
    function click(): void { root.service.feed({ type: "click", button: "left", mods: [] }) }
    function lateHello(): void { root.service.onHelperLine('{"type":"hello"}') }
    function open(): void { root.widget.open() }
    function close(): void { root.widget.close() }
  }
}
