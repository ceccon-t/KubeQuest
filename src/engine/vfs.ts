/** In-memory virtual filesystem for the mission's "workstation" (manifests the player edits). */

export class Vfs {
  private files = new Map<string, string>();
  cwd = '/home/oncall';

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.write(k, v);
  }

  resolve(path: string): string {
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = '/home/oncall' + p.slice(1);
    if (!p.startsWith('/')) p = `${this.cwd}/${p}`;
    const parts: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  /** Path as shown to the player (relative to cwd when possible). */
  display(path: string): string {
    const abs = this.resolve(path);
    if (abs.startsWith(this.cwd + '/')) return abs.slice(this.cwd.length + 1);
    if (abs.startsWith('/home/oncall/')) return '~/' + abs.slice('/home/oncall/'.length);
    return abs;
  }

  read(path: string): string | undefined {
    return this.files.get(this.resolve(path));
  }
  exists(path: string): boolean {
    return this.files.has(this.resolve(path)) || this.isDir(path);
  }
  isDir(path: string): boolean {
    const abs = this.resolve(path);
    if (abs === '/' || abs === this.cwd || abs === '/home/oncall' || abs === '/home') return true;
    const prefix = abs.endsWith('/') ? abs : abs + '/';
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  write(path: string, content: string): void {
    this.files.set(this.resolve(path), content);
  }
  append(path: string, content: string): void {
    this.files.set(this.resolve(path), (this.read(path) ?? '') + content);
  }
  remove(path: string): boolean {
    return this.files.delete(this.resolve(path));
  }
  /** List entries in a directory (names only, dirs with trailing slash). */
  list(path = '.'): string[] {
    const abs = this.resolve(path);
    const prefix = abs === '/' ? '/' : abs + '/';
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf('/');
      names.add(i < 0 ? rest : rest.slice(0, i) + '/');
    }
    return [...names].sort();
  }
  /** Files matching a glob like `*.yaml` or `manifests/*.yml` relative to cwd. */
  glob(pattern: string): string[] {
    const abs = this.resolve(pattern);
    const re = new RegExp('^' + abs.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    return [...this.files.keys()].filter((k) => re.test(k)).sort();
  }
  all(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}
