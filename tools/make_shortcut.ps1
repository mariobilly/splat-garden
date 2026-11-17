# Creates the "Splat Garden" desktop shortcut (pythonw + launch.pyw, custom icon).
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { $pyw = Join-Path (Split-Path -Parent (Get-Command python).Source) 'pythonw.exe' }
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $desk 'Splat Garden.lnk'))
$lnk.TargetPath = $pyw
$lnk.Arguments = '"' + (Join-Path $app 'launch.pyw') + '"'
$lnk.WorkingDirectory = $app
$lnk.IconLocation = (Join-Path $app 'icon.ico') + ',0'
$lnk.Description = 'Splat Garden - turn photos and videos into Gaussian-splat scans'
$lnk.WindowStyle = 1
$lnk.Save()
Write-Output "Shortcut created: $(Join-Path $desk 'Splat Garden.lnk')"
