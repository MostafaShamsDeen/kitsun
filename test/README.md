# Tests

Mocked suites: each `run-*.js` loads main.js with Electron, win32 and child_process mocked (temp LOCALAPPDATA / APPDATA / USERPROFILE) and nothing real runs. Run one with `node test/<suite>/run-<suite>.js`. `unit.js` files test a lib module on its own; `real.js` files read the real accounts read-only.

- panes: run-panes.js
- health: run-health.js
- needs: run-attention.js
- search: run-search.js
- chrome: run-chrome.js
- handoff: run-main.js
