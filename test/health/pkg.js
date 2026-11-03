const { execFile } = require('child_process');
const ps = "Get-AppxPackage -Name 'Claude*' | Where-Object { $_.PackageFamilyName -like 'Claude_*' } | Select-Object -First 1 | ForEach-Object { \"$($_.Version)`t$($_.Status)\" }";
execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
  const [version, status] = String(stdout || '').trim().split('\t');
  console.log(err ? err.message : '', JSON.stringify({ version, status }));
});
