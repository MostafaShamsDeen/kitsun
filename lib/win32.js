// Minimal Win32 bindings used to dock real Claude app windows inside the Kitsun window.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32', flags: 'uint32', hwndActive: 'intptr_t', hwndFocus: 'intptr_t', hwndCapture: 'intptr_t',
  hwndMenuOwner: 'intptr_t', hwndMoveSize: 'intptr_t', hwndCaret: 'intptr_t', rcCaret: RECT,
});

const api = {
  EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
  GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
  IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
  IsHungAppWindow: user32.func('bool __stdcall IsHungAppWindow(intptr_t hwnd)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
  SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
  GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
  SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)'),
  GetParent: user32.func('intptr_t __stdcall GetParent(intptr_t hwnd)'),
  SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
  ShowWindowAsync: user32.func('bool __stdcall ShowWindowAsync(intptr_t hwnd, int cmd)'),
  SetFocus: user32.func('intptr_t __stdcall SetFocus(intptr_t hwnd)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ int32_t *rect)'),
  IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
  IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
  IsChild: user32.func('bool __stdcall IsChild(intptr_t parent, intptr_t hwnd)'),
  ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ int32_t *point)'),
  GetGUIThreadInfo: user32.func('bool __stdcall GetGUIThreadInfo(uint32_t thread, _Inout_ GUITHREADINFO *info)'),
  GetDpiForWindow: user32.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)'),
  PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
};

const GUITHREADINFO_SIZE = koffi.sizeof('GUITHREADINFO');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GW_OWNER = 4;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_MINIMIZE = 0x20000000;
const WS_MAXIMIZE = 0x01000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_SHOWMAXIMIZED = 3;
const SW_SHOWNOACTIVATE = 4;
const SW_SHOW = 5;
const WM_ENDSESSION = 0x0016;
const ENDSESSION_CLOSEAPP = 0x1;

// Window styles are 32-bit flags; koffi hands them back as (possibly negative) numbers.
const u32 = (n) => Number(BigInt.asUintN(32, BigInt(n)));
const i32 = (n) => Number(BigInt.asIntN(32, BigInt(n)));

// Signed, to match the intptr_t handles koffi returns.
function hwndFromBuffer(buf) {
  return Number(buf.length >= 8 ? buf.readBigInt64LE(0) : buf.readInt32LE(0));
}

function readWideString(fn, hwnd) {
  const buf = new Uint16Array(256);
  const n = fn(hwnd, buf, buf.length);
  return String.fromCharCode(...buf.slice(0, Math.max(0, n)));
}

function windowPid(hwnd) {
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

function topLevelWindows() {
  const list = [];
  const cb = koffi.register((hwnd) => { list.push(Number(hwnd)); return true; }, koffi.pointer(EnumWindowsProc));
  try { api.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return list;
}

function windowRect(hwnd) {
  const r = new Int32Array(4);
  api.GetWindowRect(hwnd, r);
  return { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] };
}

// Screen position (physical pixels) of a window's client-area top-left corner.
function clientOrigin(hwnd) {
  const pt = new Int32Array(2);
  api.ClientToScreen(hwnd, pt);
  return { x: pt[0], y: pt[1] };
}

// The window that currently has keyboard focus anywhere on the desktop (0 if none).
function focusedWindow() {
  const info = { cbSize: GUITHREADINFO_SIZE };
  return api.GetGUIThreadInfo(0, info) ? Number(info.hwndFocus) : 0;
}

// The Claude app's main window for a process: a resizable, un-owned Chromium window titled "Claude".
// Hidden windows count too, because Claude hides itself to the tray instead of closing. The filters
// skip Claude's always-on-top quick-entry box and any owned popups (settings, about…).
function findAppWindow(pid) {
  let best = null;
  for (const hwnd of topLevelWindows()) {
    if (windowPid(hwnd) !== pid) continue;
    if (readWideString(api.GetClassNameW, hwnd) !== 'Chrome_WidgetWin_1') continue;
    if (!/^Claude/.test(readWideString(api.GetWindowTextW, hwnd))) continue;
    const style = u32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
    const exStyle = u32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    if (exStyle & (WS_EX_TOPMOST | WS_EX_TOOLWINDOW)) continue;
    if (!(style & WS_THICKFRAME)) continue;
    if (Number(api.GetWindow(hwnd, GW_OWNER)) !== 0) continue;
    const { width, height } = windowRect(hwnd);
    const score = width * height + (api.IsWindowVisible(hwnd) ? 1e9 : 0);
    if (!best || score > best.score) best = { hwnd, score };
  }
  return best ? best.hwnd : null;
}

// Turns a top-level window into a borderless child of `parent`. Returns what is needed to undo it.
// The window is un-maximised / un-minimised first, so the saved style and size are its normal ones.
function dock(hwnd, parent) {
  if (api.IsHungAppWindow(hwnd)) throw new Error('That Claude window is not responding.');
  const wasMaximized = api.IsZoomed(hwnd);
  if (wasMaximized || api.IsIconic(hwnd)) api.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  const style = u32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
  const exStyle = u32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const rect = windowRect(hwnd);
  const stripped = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MINIMIZE | WS_MAXIMIZE;
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, i32(((style & ~stripped) | WS_CHILD | WS_CLIPSIBLINGS) >>> 0));
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, i32((exStyle & ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW)) >>> 0));
  api.SetParent(hwnd, parent);
  api.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  return { style, exStyle, rect, wasMaximized };
}

// Puts a docked window back as a normal top-level window. Visibility and maximised/minimised state
// are never written as raw style bits (that would leave a window marked visible that Windows never
// actually showed); ShowWindow sets them properly instead.
function undock(hwnd, saved, { show = true } = {}) {
  if (!api.IsWindow(hwnd)) return;
  api.ShowWindow(hwnd, SW_HIDE);
  api.SetParent(hwnd, 0);
  const style = (saved.style & ~(WS_VISIBLE | WS_MINIMIZE | WS_MAXIMIZE | WS_CHILD)) >>> 0;
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, i32(style));
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, i32(saved.exStyle));
  const r = saved.rect;
  api.SetWindowPos(hwnd, 0, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
  if (show) api.ShowWindow(hwnd, saved.wasMaximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
}

// Position in the parent's client area, in physical pixels. The docked window is raised to the top
// of the stack (HWND_TOP = 0): otherwise Kitsun's own page layer sits above it and takes every click.
// A window that stopped responding is skipped, so a hung Claude can't freeze Kitsun.
function place(hwnd, x, y, width, height, visible) {
  if (!api.IsWindow(hwnd) || api.IsHungAppWindow(hwnd)) return false;
  if (!visible) { api.ShowWindowAsync(hwnd, SW_HIDE); return true; }
  api.SetWindowPos(hwnd, 0, Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
    SWP_NOACTIVATE | SWP_SHOWWINDOW);
  return true;
}

module.exports = {
  api, hwndFromBuffer, windowPid, findAppWindow, dock, undock, place, windowRect, focusedWindow, clientOrigin,
  isWindow: (h) => api.IsWindow(h),
  isVisible: (h) => api.IsWindowVisible(h),
  // The window's own visible flag. Unlike IsWindowVisible it ignores the parents, so it still tells
  // whether Claude showed a docked window while Kitsun itself is hidden.
  hasVisibleStyle: (h) => (u32(api.GetWindowLongPtrW(h, GWL_STYLE)) & WS_VISIBLE) !== 0,
  isHung: (h) => api.IsHungAppWindow(h),
  isZoomedOrMinimized: (h) => api.IsZoomed(h) || api.IsIconic(h),
  restore: (h) => api.ShowWindowAsync(h, SW_SHOWNOACTIVATE),
  contains: (parent, h) => h !== 0 && (h === parent || api.IsChild(parent, h)),
  dpiScale: (h) => (api.GetDpiForWindow(h) || 96) / 96,
  focus: (h) => api.SetFocus(h),
  show: (h) => api.ShowWindowAsync(h, SW_SHOW),
  hide: (h) => api.ShowWindowAsync(h, SW_HIDE),
  // Asks a Claude window's app to quit, as Windows does before installing an update: Electron turns
  // WM_ENDSESSION into the window's 'session-end' event, and Claude quits on that (running its usual
  // quit clean-up), whereas WM_CLOSE only hides it to its tray. Posted, so a busy Claude can't block us.
  askToQuit: (h) => api.PostMessageW(h, WM_ENDSESSION, 1, ENDSESSION_CLOSEAPP),
};
