// Minimal Cookie header parsing — port of getExistingCookies without the `cookie` dep.

export function readCookie(header: string | null, name: string): string {
  if (header === null || header.length == 0) return "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i].trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() == name) return pair.slice(eq + 1).trim();
  }
  return "";
}
