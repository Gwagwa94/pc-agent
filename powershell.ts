import { execSync } from 'child_process';
import { addLog } from './logger.js';
import { state } from './state.js';

export function runPowerShellSafe(psScript: string): string {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return execSync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { encoding: 'utf8', timeout: 20000 }
  ).trim();
}

export function getForegroundWindowTitle(): string {
  try {
    return runPowerShellSafe(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [Win32Fg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][Win32Fg]::GetWindowText($h, $sb, 512)
Write-Output $sb.ToString()
`);
  } catch {
    return '';
  }
}

export function initScreenResolution(): void {
  try {
    const out = runPowerShellSafe(
      `Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output "$($b.Width)x$($b.Height)"`
    );
    const parts = out.split('x').map((n) => parseInt(n.trim(), 10));
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      state.screenDimensions = { width: parts[0]!, height: parts[1]! };
      addLog(`🖥️ Résolution d'écran détectée : ${state.screenDimensions.width}x${state.screenDimensions.height}`);
    }
  } catch {
    addLog(`🖥️ Résolution par défaut utilisée : ${state.screenDimensions.width}x${state.screenDimensions.height}`);
  }
}

export function focusWindow(windowHandle: number | string): boolean {
  try {
    const handleNum = typeof windowHandle === 'number' ? windowHandle : parseInt(String(windowHandle), 10);
    if (!handleNum || isNaN(handleNum)) return false;
    runPowerShellSafe(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Switch {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$h = [IntPtr]${handleNum}
if ([Win32Switch]::IsIconic($h)) {
  [void][Win32Switch]::ShowWindow($h, 9)
} else {
  [void][Win32Switch]::ShowWindow($h, 5)
}
[void][Win32Switch]::SetForegroundWindow($h)
`);
    addLog(`🪟 [Win32] Fenêtre (handle ${handleNum}) activée au premier plan`);
    return true;
  } catch (err) {
    addLog(`⚠️ Échec de l'activation de la fenêtre handle ${windowHandle}: ${err}`);
    return false;
  }
}
