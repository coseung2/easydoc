param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EasyDocWindowProbe {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
}
'@
function Get-AppProcesses {
  @(Get-Process -Name 'easydoc-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable })
}
$instances = @(Get-AppProcesses)
if ($instances.Count -gt 1) { throw 'Close duplicate old instances before running this check.' }
if ($instances.Count -eq 0) {
  $started = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  Write-Output "Started app PID=$($started.Id); left running after checks."
}
$deadline = (Get-Date).AddSeconds(30)
do {
  $instances = @(Get-AppProcesses)
  if ($instances.Count -eq 1 -and $instances[0].MainWindowHandle -ne 0 -and $instances[0].MainWindowTitle -eq 'EasyDoc') { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($instances.Count -ne 1 -or $instances[0].MainWindowHandle -eq 0 -or $instances[0].MainWindowTitle -ne 'EasyDoc') { throw 'Primary app window was not ready.' }
$primaryId = $instances[0].Id
$handle = $instances[0].MainWindowHandle
foreach ($mode in @('visible', 'minimized', 'hidden')) {
  if ($mode -eq 'minimized') { [void][EasyDocWindowProbe]::ShowWindow($handle, 6) }
  # Use the app's real close-to-tray handler, not an external visibility override.
  if ($mode -eq 'hidden') { [void][EasyDocWindowProbe]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 700
  $duplicate = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  if (-not $duplicate.WaitForExit(15000)) { throw "Duplicate did not exit: PID=$($duplicate.Id)" }
  $restoreDeadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 250
    $restored = [EasyDocWindowProbe]::IsWindowVisible($handle) -and -not [EasyDocWindowProbe]::IsIconic($handle)
  } while (-not $restored -and (Get-Date) -lt $restoreDeadline)
  $instances = @(Get-AppProcesses)
  $visible = [EasyDocWindowProbe]::IsWindowVisible($handle)
  $minimized = [EasyDocWindowProbe]::IsIconic($handle)
  $focused = [EasyDocWindowProbe]::GetForegroundWindow() -eq $handle
  if ($instances.Count -ne 1 -or $instances[0].Id -ne $primaryId -or -not $visible -or $minimized) {
    throw "Failed $mode restore: count=$($instances.Count), visible=$visible, minimized=$minimized"
  }
  [pscustomobject]@{Case=$mode;PrimaryPID=$primaryId;DuplicatePID=$duplicate.Id;DuplicateExitCode=$duplicate.ExitCode;Count=$instances.Count;Visible=$visible;Minimized=$minimized;Foreground=$focused} | ConvertTo-Json -Compress
}
