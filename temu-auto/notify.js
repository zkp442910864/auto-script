'use strict';

const { execFile } = require('node:child_process');

function notificationCommand(platform, title, message) {
  if (platform === 'darwin') {
    const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
    return { file: 'osascript', args: ['-e', `display notification ${quote(message)} with title ${quote(title)} sound name "Glass"`] };
  }
  if (platform === 'win32') {
    const xml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
    const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(message)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>`;
    const encodedXml = Buffer.from(toast, 'utf8').toString('base64');
    const script = `$ErrorActionPreference='Stop'; [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; $doc=New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedXml}'))); $toast=[Windows.UI.Notifications.ToastNotification]::new($doc); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast);`;
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  return null;
}

async function notify(title, message, { platform = process.platform, execute = execFile } = {}) {
  const command = notificationCommand(platform, title, message);
  if (!command) { process.stdout.write('\x07'); return false; }
  return new Promise((resolve) => execute(command.file, command.args, { windowsHide: true, timeout: 10000 }, (error) => {
    if (error) { console.warn(`桌面通知未送达：${error.message}。请检查系统通知权限；控制台仍显示等待提示。`); process.stdout.write('\x07'); }
    resolve(!error);
  }));
}

module.exports = { notify, notificationCommand };
