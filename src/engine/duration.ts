/** Time and quantity formatting/parsing with upstream-identical semantics. */

/** upstream: k8s.io/apimachinery/pkg/util/duration.HumanDuration */
export function humanDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < -1) return '<invalid>';
  if (seconds < 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    const s = seconds % 60;
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`;
  }
  if (minutes < 60 * 3) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) {
    const m = minutes % 60;
    return m === 0 ? `${hours}h` : `${hours}h${m}m`;
  }
  if (hours < 48) return `${hours}h`;
  if (hours < 24 * 8) {
    const h = hours % 24;
    return h === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d${h}h`;
  }
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24)}d`;
  if (hours < 24 * 365 * 8) {
    const dy = Math.floor(hours / 24) % 365;
    const y = Math.floor(hours / 24 / 365);
    return dy === 0 ? `${y}y` : `${y}y${dy}d`;
  }
  return `${Math.floor(hours / 24 / 365)}y`;
}

/** Parse Go-style durations used by kubectl flags: 30s, 5m, 1h30m, 250ms. Returns ms. */
export function parseGoDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched += m[0];
    const n = parseFloat(m[1] as string);
    const unit = m[2];
    total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n * 3600000;
  }
  if (matched !== s || s === '') return null;
  return total;
}

/** Parse a Kubernetes resource.Quantity into a base number (cores for cpu, bytes for memory). */
export function parseQuantity(q: string | number): number {
  if (typeof q === 'number') return q;
  const s = q.trim();
  const m = /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|m|k|M|G|T|P|E|)$/.exec(s);
  if (!m) throw new Error(`quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
  const n = parseFloat(m[1] as string);
  const mult: Record<string, number> = {
    '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  };
  return n * (mult[m[2] as string] as number);
}

/** CPU in millicores (parse "500m" -> 500, "1" -> 1000, "0.5" -> 500). */
export function parseCpuMillis(q: string | number): number {
  return Math.round(parseQuantity(q) * 1000);
}
/** Memory in bytes. */
export function parseMemoryBytes(q: string | number): number {
  return Math.round(parseQuantity(q));
}
export function formatCpuMillis(m: number): string {
  return m % 1000 === 0 ? `${m / 1000}` : `${m}m`;
}
export function formatMemory(bytes: number): string {
  if (bytes % (1024 ** 3) === 0) return `${bytes / 1024 ** 3}Gi`;
  if (bytes % (1024 ** 2) === 0) return `${bytes / 1024 ** 2}Mi`;
  if (bytes % 1024 === 0) return `${bytes / 1024}Ki`;
  return `${bytes}`;
}
