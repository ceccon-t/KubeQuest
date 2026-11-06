/** App version shown under the KUBEQUEST title. Source of truth is always package.json:
 *  - packaged binary / browser bundle: the version baked in at build time (`__KQ_VERSION__`, esbuild define);
 *  - development: the current contents of package.json, read live by the Electron main process
 *    (`app:version` IPC) or served by `scripts/serve.mjs` as `version.json`. */

export const BUILD_VERSION: string = typeof __KQ_VERSION__ === 'string' ? __KQ_VERSION__ : '0.0.0-dev';

export interface VersionSource {
  /** Desktop bridge (`window.kubequest.version`), when running under Electron. */
  bridge?: () => Promise<string>;
  /** `fetch`, when running in a browser; the dev server answers `version.json` from the live package.json. */
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

function parseVersion(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'object' && v !== null && 'version' in v) return parseVersion((v as { version: unknown }).version);
  return null;
}

export async function resolveVersion(src: VersionSource = defaultSource()): Promise<string> {
  if (src.bridge) {
    try { const v = parseVersion(await src.bridge()); if (v) return v; } catch { /* bridge unavailable: fall through */ }
  } else if (src.fetch) {
    try { const r = await src.fetch('version.json'); if (r.ok) { const v = parseVersion(await r.json()); if (v) return v; } } catch { /* static host: fall through */ }
  }
  return BUILD_VERSION;
}

function defaultSource(): VersionSource {
  const g = globalThis as { kubequest?: { version?: () => Promise<string> }; fetch?: typeof fetch; location?: { protocol: string } };
  if (g.kubequest?.version) return { bridge: g.kubequest.version };
  // Only an http(s) origin can have a dev server behind it; file:// would just log a failed request.
  if (g.fetch && g.location && /^https?:$/.test(g.location.protocol)) { const f = g.fetch; return { fetch: (url) => f(url) }; }
  return {};
}
