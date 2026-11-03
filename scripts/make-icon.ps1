# Draws build/icon.png (256px): two overlapping account circles on a dark rounded tile.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\build\icon.png'
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56; $s = 248; $o = 4
$path.AddArc($o, $o, $r, $r, 180, 90); $path.AddArc($o + $s - $r, $o, $r, $r, 270, 90)
$path.AddArc($o + $s - $r, $o + $s - $r, $r, $r, 0, 90); $path.AddArc($o, $o + $s - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 35, 34, 32))), $path)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 119, 87))), 38, 70, 116, 116)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(215, 91, 141, 239))), 102, 70, 116, 116)
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
