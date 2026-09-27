# Security

keycast includes `keycastd`, a helper that polkit lets the active session run
as root without a password. It opens input devices, drops to the calling user
immediately, and exits unless that user's `gpu-screen-recorder` is running.
Bugs in that path matter, so please report them privately.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/sasukevibes/omarchy-keycast/security/advisories/new).
Please don't open a public issue. You'll get a response within a few days.

In scope, for example:

- a way to make `keycastd` read input while no recording is running
- a way to keep root, or to reach it through `keycastd`'s arguments or environment
- typed text that should have been masked appearing in the overlay
