import { runPowerShellSafe } from './powershell.js';

export function openUrlInChrome(url: string): void {
  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = `https://${cleanUrl}`;
  }
  const base64Url = Buffer.from(cleanUrl, 'utf8').toString('base64');
  const psScript = `
$u = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Url}'))
Start-Process "chrome.exe" -ArgumentList $u
`;
  runPowerShellSafe(psScript);
}

export function typeTextViaClipboard(textToType: string, pressEnter: boolean, pressTab = false): void {
  const base64Text = Buffer.from(textToType, 'utf8').toString('base64');
  const enterKey = pressEnter ? "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');" : '';
  const tabKey = pressTab ? "[System.Windows.Forms.SendKeys]::SendWait('{TAB}');" : '';
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$bytes = [System.Convert]::FromBase64String('${base64Text}')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 180
${enterKey}
${tabKey}
`;
  runPowerShellSafe(psScript);
}

export function sendKeyShortcutReliable(shortcut: string): boolean {
  const s = shortcut.toLowerCase().trim();
  let sendKeysStr = '';
  if (s === 'ctrl+enter' || s === 'ctrl+return') sendKeysStr = '^{ENTER}';
  else if (s === 'ctrl+w') sendKeysStr = '^w';
  else if (s === 'ctrl+t') sendKeysStr = '^t';
  else if (s === 'ctrl+l') sendKeysStr = '^l';
  else if (s === 'ctrl+tab') sendKeysStr = '^{TAB}';
  else if (s === 'enter' || s === 'return') sendKeysStr = '{ENTER}';
  else if (s === 'tab') sendKeysStr = '{TAB}';
  else if (s === 'escape' || s === 'esc') sendKeysStr = '{ESC}';

  if (sendKeysStr) {
    runPowerShellSafe(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKeysStr}')
`);
    return true;
  }
  return false;
}
