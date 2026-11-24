# Generates every app icon from logo.png (repo root), with Windows' built-in System.Drawing.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1
#
# Small sizes (16-64 px, tray, taskbar) use a crop on the robot's head: the full logo's text is
# unreadable there. Large sizes (128-256 px, installer, Explorer) use the full logo.
#   src-tauri/icons/icon.ico          app + installer icon (16..256)
#   src-tauri/icons/icon.png          256 px bundle icon (full logo)
#   src-tauri/icons/tray.png          32 px tray icon (head)
#   src-tauri/icons/tray-alert.png    32 px tray icon during a captcha (head, red)
#   src-tauri/windows/sidebar.bmp     NSIS welcome/finish page image (164x314)
#   src/renderer/assets/logo.png      256 px logo for the UI and the README

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $root 'logo.png'))
$full = New-Object System.Drawing.Rectangle 0, 0, $src.Width, $src.Height
# robot head + hat, in logo.png's 1254x1254 coordinates (scaled for other sizes)
$k = $src.Width / 1254
$head = New-Object System.Drawing.Rectangle ([int](135 * $k)), ([int](165 * $k)), ([int](510 * $k)), ([int](510 * $k))

function New-Icon([System.Drawing.Rectangle]$from, [int]$size, [bool]$rounded, [bool]$red = $false) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  if ($rounded) {
    $w = [single]$size; $d = [single]($size * 0.4)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($w - $d, 0, $d, $d, 270, 90)
    $p.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $p.AddArc(0, $w - $d, $d, $d, 90, 90); $p.CloseFigure()
    $g.SetClip($p)
  } else {
    # the logo's circle on a transparent background: clip to the disc
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse([single]0, [single]0, [single]$size, [single]$size)
    $g.SetClip($p)
  }
  $attrs = $null
  if ($red) {
    # luminance mapped onto red: the captcha icon stands out in the tray
    $m = New-Object System.Drawing.Imaging.ColorMatrix
    $m.Matrix00 = 0.75; $m.Matrix10 = 0.75; $m.Matrix20 = 0.75
    $m.Matrix01 = 0.12; $m.Matrix11 = 0.12; $m.Matrix21 = 0.12
    $m.Matrix02 = 0.12; $m.Matrix12 = 0.12; $m.Matrix22 = 0.12
    $m.Matrix33 = 1; $m.Matrix44 = 1
    $m.Matrix40 = 0.08
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetColorMatrix($m)
  }
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), $from.X, $from.Y, $from.Width, $from.Height, 'Pixel', $attrs)
  $g.Dispose()
  $bmp
}

function Get-PngBytes($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  , $ms.ToArray() # the comma keeps the byte[] whole (PowerShell would unroll it)
}

function Save-Png($bmp, $rel) {
  $path = Join-Path $root $rel
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  [System.IO.File]::WriteAllBytes($path, (Get-PngBytes $bmp))
  $bmp.Dispose()
}

# ICO container with PNG-compressed entries (Windows Vista+)
function Save-Ico($entries, $rel) {
  $ms = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $ms
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) {
    $dim = [byte]$(if ($e.Size -ge 256) { 0 } else { $e.Size })
    $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$e.Data.Length); $w.Write([uint32]$offset)
    $offset += $e.Data.Length
  }
  foreach ($e in $entries) { $w.Write([byte[]]$e.Data) }
  $w.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path $root $rel), $ms.ToArray())
}

$entries = foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
  $b = if ($s -le 64) { New-Icon $head $s $true } else { New-Icon $full $s $true }
  [pscustomobject]@{ Size = $s; Data = [byte[]](Get-PngBytes $b) }
  $b.Dispose()
}
Save-Ico $entries 'src-tauri/icons/icon.ico'
Save-Png (New-Icon $full 256 $true) 'src-tauri/icons/icon.png'
Save-Png (New-Icon $head 32 $true) 'src-tauri/icons/tray.png'
Save-Png (New-Icon $head 32 $true $true) 'src-tauri/icons/tray-alert.png'
Save-Png (New-Icon $full 256 $true) 'src/renderer/assets/logo.png'

# NSIS sidebar: 164x314, 24-bit BMP, logo centred on the logo's own background colour
$side = New-Object System.Drawing.Bitmap 164, 314, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($side)
$g.Clear($src.GetPixel(4, 4))
$g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 4, 79, 156, 156), $full, 'Pixel')
$g.Dispose()
$side.Save((Join-Path $root 'src-tauri/windows/sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$side.Dispose()

$src.Dispose()
'icons written'
