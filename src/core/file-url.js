import { fileURLToPath, pathToFileURL } from 'node:url';

/** Convert local paths and file URLs without losing Windows drive or UNC roots. */
export function encodeFileUri(filePath, platform = process.platform) {
  return pathToFileURL(String(filePath), { windows: platform === 'win32' }).href;
}

export function decodeFileUri(uri, platform = process.platform) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';

  const legacyDrive = platform === 'win32' && /^file:\/\/([a-z]):(?:\/(.*))?$/i.exec(uri);
  if (legacyDrive) return `${legacyDrive[1].toUpperCase()}:\\${decodePath(legacyDrive[2] || '').replace(/\//g, '\\')}`;

  let url;
  try {
    url = new URL(uri);
  } catch {
    return '';
  }
  if (url.protocol !== 'file:') return '';

  try {
    return fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    // Older workspace records may percent-encode the drive colon or use UNC on POSIX.
  }

  const pathname = decodePath(url.pathname);
  const hostname = url.hostname && url.hostname.toLowerCase() !== 'localhost' ? url.hostname : '';
  if (platform === 'win32') {
    if (hostname) return `\\\\${hostname}${pathname.replace(/\//g, '\\')}`;
    return pathname.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
  }
  return hostname ? `//${hostname}${pathname}` : pathname;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
