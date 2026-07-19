const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 37800000 → "36.0 MB" (binary steps, compact display). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  let v = Math.abs(bytes);
  let u = 0;
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  // parseFloat drops trailing zeros so axis ticks read "64 GB", not "64.0 GB".
  return `${sign}${parseFloat(v.toFixed(digits))} ${BYTE_UNITS[u]}`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const shortDateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(epochMs: number): string {
  return dateFmt.format(epochMs);
}

export function formatShortDate(epochMs: number): string {
  return shortDateFmt.format(epochMs);
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}
