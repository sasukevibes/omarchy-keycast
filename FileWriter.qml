import QtQuick
import Quickshell.Io

// Writes text to `path`, creating its directory. Writes that arrive while one
// is running are coalesced, so only the latest text lands.
Process {
  id: writer

  property string path: ""
  property string pending: ""
  property bool hasPending: false

  function write(text) {
    pending = text
    hasPending = true
    if (!running) flush()
  }

  function flush() {
    command = ["bash", "-c", 'mkdir -p "$(dirname "$1")" && printf "%s\n" "$2" > "$1"', "keycast", path, pending]
    hasPending = false
    running = true
  }

  onExited: if (hasPending) flush()
}
