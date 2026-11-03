// Read-only: the same query main.js cliSessionRunning makes, against the real process list.
const { execFile } = require('child_process');
for (const id of process.argv.slice(2)) {
  const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + "Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%.exe'\" | Where-Object { $_.CommandLine -like '*" + id + "*' } | ForEach-Object { $_.CommandLine }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
    console.log(id, err ? 'ERR ' + err.message : new RegExp(`--resume[= ]"?${id}\\b`, 'i').test(String(stdout || '')));
  });
}
