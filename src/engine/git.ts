/**
 * A small `git` for the workstation: one branch (main), one remote (origin), the commands a GitOps workflow needs.
 * Repositories are directories of the VFS listed in `ClusterSetup.gitRemotes`; pushing updates the remote that the
 * in-cluster GitOps controller reads. Output formats follow git 2.43.
 */
import type { Engine } from './engine.ts';
import type { Vfs } from './vfs.ts';
import type { OutputChunk } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import { sha256hex } from './encoding.ts';

export type Tree = Record<string, string>;
export interface Commit { sha: string; message: string; tree: Tree; at: number; author: string }
export interface Repo { dir: string; url: string; commits: Commit[]; index: Tree; pushed: number }
/** What the remote serves (read by the GitOps controller). */
export interface Remote { url: string; commits: Commit[] }

function repos(engine: Engine): Map<string, Repo> {
  let m = engine.scratch.get('git-repos') as Map<string, Repo> | undefined;
  if (!m) { m = new Map(); engine.scratch.set('git-repos', m); }
  return m;
}

export function gitRemote(engine: Engine, url: string): Remote | undefined {
  return (engine.scratch.get('git-remotes') as Map<string, Remote> | undefined)?.get(url);
}

function setRemote(engine: Engine, repo: Repo): void {
  let m = engine.scratch.get('git-remotes') as Map<string, Remote> | undefined;
  if (!m) { m = new Map(); engine.scratch.set('git-remotes', m); }
  m.set(repo.url, { url: repo.url, commits: repo.commits.slice(0, repo.pushed) });
}

function workTree(vfs: Vfs, dir: string): Tree {
  const tree: Tree = {};
  const prefix = dir.replace(/\/$/, '') + '/';
  for (const [path, content] of Object.entries(vfs.all())) if (path.startsWith(prefix)) tree[path.slice(prefix.length)] = content;
  return tree;
}

function commitSha(parent: string, message: string, tree: Tree, at: number): string {
  return sha256hex(`${parent}\n${message}\n${at}\n${JSON.stringify(Object.keys(tree).sort().map((k) => [k, tree[k]]))}`).slice(0, 40);
}

/** Create the clones the mission declares: one initial commit with whatever is in the directory, already pushed. */
export function initGitRepos(engine: Engine, vfs: Vfs): void {
  const m = repos(engine);
  for (const [url, dirRaw] of Object.entries(engine.gitRemotes)) {
    const dir = vfs.resolve(dirRaw);
    if (m.has(dir)) continue;
    const tree = workTree(vfs, dir);
    const at = engine.clock.nowMs - 6 * 3600_000;
    const first: Commit = { sha: commitSha('', 'Initial commit', tree, at), message: 'Initial commit', tree, at, author: 'ci-bot' };
    const repo: Repo = { dir, url, commits: [first], index: { ...tree }, pushed: 1 };
    m.set(dir, repo);
    setRemote(engine, repo);
  }
}

/** A commit made by someone else straight on the remote (missions: a colleague or CI pushes). */
export function remoteCommit(engine: Engine, url: string, message: string, change: (tree: Tree) => void, author = 'ci-bot'): void {
  const remote = gitRemote(engine, url);
  if (!remote) return;
  const head = remote.commits[remote.commits.length - 1] as Commit;
  const tree = { ...head.tree };
  change(tree);
  const at = engine.clock.nowMs;
  remote.commits.push({ sha: commitSha(head.sha, message, tree, at), message, tree, at, author });
}

function diffLines(a: string[], b: string[]): { op: ' ' | '-' | '+'; line: string }[] {
  // longest common subsequence (files here are small manifests)
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (dp[i] as number[])[j] = a[i] === b[j] ? ((dp[i + 1] as number[])[j + 1] as number) + 1 : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const res: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { res.push({ op: ' ', line: a[i] as string }); i++; j++; }
    else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) { res.push({ op: '-', line: a[i] as string }); i++; }
    else { res.push({ op: '+', line: b[j] as string }); j++; }
  }
  while (i < n) res.push({ op: '-', line: a[i++] as string });
  while (j < m) res.push({ op: '+', line: b[j++] as string });
  return res;
}

const lines = (s: string | undefined): string[] => { if (s === undefined || s === '') return []; const l = s.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

function unifiedDiff(path: string, before: string | undefined, after: string | undefined): string {
  const d = diffLines(lines(before), lines(after));
  const blob = (s: string | undefined): string => (s === undefined ? '0000000' : sha256hex(`blob ${s}`).slice(0, 7));
  let text = `diff --git a/${path} b/${path}\n`;
  if (before === undefined) text += 'new file mode 100644\n';
  if (after === undefined) text += 'deleted file mode 100644\n';
  text += `index ${blob(before)}..${blob(after)}${before !== undefined && after !== undefined ? ' 100644' : ''}\n--- ${before === undefined ? '/dev/null' : `a/${path}`}\n+++ ${after === undefined ? '/dev/null' : `b/${path}`}\n`;
  // hunks with three lines of context
  const changed = d.map((x, i) => (x.op === ' ' ? -1 : i)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, (changed[k] as number) - 3), end = Math.min(d.length - 1, (changed[k] as number) + 3);
    while (k + 1 < changed.length && (changed[k + 1] as number) - 3 <= end + 1) { k++; end = Math.min(d.length - 1, (changed[k] as number) + 3); }
    k++;
    const aStart = d.slice(0, start).filter((x) => x.op !== '+').length + 1, bStart = d.slice(0, start).filter((x) => x.op !== '-').length + 1;
    const part = d.slice(start, end + 1);
    const aLen = part.filter((x) => x.op !== '+').length, bLen = part.filter((x) => x.op !== '-').length;
    text += `@@ -${aLen === 0 ? aStart - 1 : aStart}${aLen === 1 ? '' : `,${aLen}`} +${bLen === 0 ? bStart - 1 : bStart}${bLen === 1 ? '' : `,${bLen}`} @@\n${part.map((x) => `${x.op}${x.line}`).join('\n')}\n`;
    start = end;
  }
  return text;
}

/** The per-file lines of `git diff --stat`, as printed by a fast-forward pull (` path | 2 +-`). */
function fileStat(before: Tree, after: Tree): string {
  const rows: [string, number, number][] = [];
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[p] === after[p]) continue;
    let ins = 0, del = 0;
    for (const x of diffLines(lines(before[p]), lines(after[p]))) { if (x.op === '+') ins++; else if (x.op === '-') del++; }
    rows.push([p, ins, del]);
  }
  const width = Math.max(0, ...rows.map((r) => r[0].length));
  const digits = Math.max(1, ...rows.map((r) => String(r[1] + r[2]).length));
  return rows.map(([p, ins, del]) => ` ${p.padEnd(width)} | ${String(ins + del).padStart(digits)} ${'+'.repeat(ins)}${'-'.repeat(del)}\n`).join('');
}

function stat(before: Tree, after: Tree): string {
  let files = 0, ins = 0, del = 0;
  const created: string[] = [], removed: string[] = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[p] === after[p]) continue;
    files++;
    if (before[p] === undefined) created.push(p);
    if (after[p] === undefined) removed.push(p);
    for (const x of diffLines(lines(before[p]), lines(after[p]))) { if (x.op === '+') ins++; else if (x.op === '-') del++; }
  }
  const parts = [`${files} file${files === 1 ? '' : 's'} changed`];
  if (ins) parts.push(`${ins} insertion${ins === 1 ? '' : 's'}(+)`);
  if (del) parts.push(`${del} deletion${del === 1 ? '' : 's'}(-)`);
  return ` ${parts.join(', ')}\n${created.sort().map((p) => ` create mode 100644 ${p}\n`).join('')}${removed.sort().map((p) => ` delete mode 100644 ${p}\n`).join('')}`;
}

function ansic(ms: number): string {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

export function runGit(engine: Engine, vfs: Vfs, args: string[]): { chunks: OutputChunk[]; code: number } {
  const sub = args[0];
  if (!sub || sub === '--help') return { chunks: [out('usage: git <command> [<args>]\n\nkubequest supports: status, add, commit, push, pull, log, diff, revert, restore, remote -v, branch\n')], code: sub ? 0 : 1 };
  if (sub === '--version' || sub === 'version') return { chunks: [out('git version 2.43.0\n')], code: 0 };
  const repo = [...repos(engine).values()].find((r) => vfs.cwd === r.dir || vfs.cwd.startsWith(r.dir + '/'));
  if (!repo) return { chunks: [err('fatal: not a git repository (or any of the parent directories): .git\n')], code: 128 };
  const head = repo.commits[repo.commits.length - 1] as Commit;
  const work = workTree(vfs, repo.dir);
  const rel = (p: string): string => { const abs = vfs.resolve(p); return abs === repo.dir ? '' : abs.slice(repo.dir.length + 1); };
  const ahead = repo.commits.length - repo.pushed;
  const remote = gitRemote(engine, repo.url);
  const behind = remote ? Math.max(0, remote.commits.length - repo.pushed) : 0;
  const all = (...trees: Tree[]): string[] => [...new Set(trees.flatMap((t) => Object.keys(t)))].sort();
  const staged = all(head.tree, repo.index).filter((p) => head.tree[p] !== repo.index[p]);
  const unstaged = all(repo.index, work).filter((p) => repo.index[p] !== undefined && repo.index[p] !== work[p]);
  const untracked = Object.keys(work).filter((p) => repo.index[p] === undefined).sort();
  const word = (before: string | undefined, after: string | undefined): string => (before === undefined ? 'new file:   ' : after === undefined ? 'deleted:    ' : 'modified:   ');
  const flags = args.slice(1).filter((x) => x.startsWith('-'));
  const paths = args.slice(1).filter((x) => !x.startsWith('-'));
  const makeCommit = (message: string, tree: Tree): Commit => { const at = engine.clock.nowMs; const c: Commit = { sha: commitSha(head.sha, message, tree, at), message, tree: { ...tree }, at, author: 'oncall' }; repo.commits.push(c); return c; };
  switch (sub) {
    case 'status': {
      let text = `On branch main\n${ahead ? `Your branch is ahead of 'origin/main' by ${ahead} commit${ahead === 1 ? '' : 's'}.\n  (use "git push" to publish your local commits)\n` : behind ? `Your branch is behind 'origin/main' by ${behind} commit${behind === 1 ? '' : 's'}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n` : "Your branch is up to date with 'origin/main'.\n"}\n`;
      if (staged.length) text += `Changes to be committed:\n  (use "git restore --staged <file>..." to unstage)\n${staged.map((p) => `\t${word(head.tree[p], repo.index[p])}${p}\n`).join('')}\n`;
      if (unstaged.length) text += `Changes not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n${unstaged.map((p) => `\t${word(repo.index[p], work[p])}${p}\n`).join('')}\n`;
      if (untracked.length) text += `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n${untracked.map((p) => `\t${p}\n`).join('')}\n`;
      if (!staged.length) text += unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")\n' : untracked.length ? 'nothing added to commit but untracked files present (use "git add" to track)\n' : 'nothing to commit, working tree clean\n';
      return { chunks: [out(text)], code: 0 };
    }
    case 'add': {
      if (!paths.length && !flags.includes('-A') && !flags.includes('--all') && !flags.includes('-u')) return { chunks: [out("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n")], code: 0 };
      const wanted = flags.includes('-A') || flags.includes('--all') ? [''] : paths.map(rel);
      for (const w of wanted) {
        const inScope = (p: string): boolean => w === '' || p === w || p.startsWith(w.replace(/\/$/, '') + '/');
        if (w !== '' && !all(work, repo.index).some(inScope)) return { chunks: [err(`fatal: pathspec '${w}' did not match any files\n`)], code: 128 };
        for (const p of all(work, repo.index)) if (inScope(p)) { if (work[p] === undefined) delete repo.index[p]; else repo.index[p] = work[p] as string; }
      }
      return { chunks: [], code: 0 };
    }
    case 'restore': {
      const stagedOnly = flags.includes('--staged');
      for (const p of paths.map(rel)) {
        if (stagedOnly) { if (head.tree[p] === undefined) delete repo.index[p]; else repo.index[p] = head.tree[p] as string; }
        else if (repo.index[p] !== undefined) vfs.write(`${repo.dir}/${p}`, repo.index[p] as string);
        else return { chunks: [err(`error: pathspec '${p}' did not match any file(s) known to git\n`)], code: 1 };
      }
      return { chunks: [], code: 0 };
    }
    case 'commit': {
      const mi = args.findIndex((x) => x === '-m' || x === '-am' || x === '-ma' || x === '--message');
      const message = mi >= 0 ? args[mi + 1] : undefined;
      if (flags.some((f) => /^-[a-z]*a/.test(f) && !f.startsWith('--')) || flags.includes('--all')) for (const p of unstaged) { if (work[p] === undefined) delete repo.index[p]; else repo.index[p] = work[p] as string; }
      const nowStaged = all(head.tree, repo.index).filter((p) => head.tree[p] !== repo.index[p]);
      if (!nowStaged.length) return runGitStatusAsFailure(engine, vfs);
      if (message === undefined) return { chunks: [err('kubequest: there is no editor for commit messages here; use git commit -m "message"\n')], code: 1 };
      const c = makeCommit(message, repo.index);
      return { chunks: [out(`[main ${c.sha.slice(0, 7)}] ${message}\n${stat(head.tree, c.tree)}`)], code: 0 };
    }
    case 'push': {
      if (!ahead) return { chunks: [err('Everything up-to-date\n')], code: 0 };
      if (behind) return { chunks: [err(`To ${repo.url}\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '${repo.url}'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.\n`)], code: 1 };
      const old = (repo.commits[repo.pushed - 1] as Commit).sha.slice(0, 7);
      repo.pushed = repo.commits.length;
      setRemote(engine, repo);
      return { chunks: [err(`To ${repo.url}\n   ${old}..${(repo.commits[repo.commits.length - 1] as Commit).sha.slice(0, 7)}  main -> main\n`)], code: 0 };
    }
    case 'pull': {
      if (!remote || !behind) return { chunks: [out('Already up to date.\n')], code: 0 };
      if (ahead) return { chunks: [err('kubequest: merging diverged histories is not simulated; push or reset your local commits first\n')], code: 1 };
      const newer = remote.commits.slice(repo.pushed);
      const tip = newer[newer.length - 1] as Commit;
      for (const p of all(head.tree, tip.tree)) { if (tip.tree[p] === undefined) vfs.remove(`${repo.dir}/${p}`); else if (work[p] === head.tree[p]) vfs.write(`${repo.dir}/${p}`, tip.tree[p] as string); }
      repo.commits.push(...newer);
      repo.pushed = repo.commits.length;
      repo.index = { ...tip.tree };
      return { chunks: [out(`From ${repo.url.replace(/\.git$/, '')}\n   ${head.sha.slice(0, 7)}..${tip.sha.slice(0, 7)}  main       -> origin/main\nUpdating ${head.sha.slice(0, 7)}..${tip.sha.slice(0, 7)}\nFast-forward\n${fileStat(head.tree, tip.tree)}${stat(head.tree, tip.tree)}`)], code: 0 };
    }
    case 'log': {
      const n = (() => { const i = args.findIndex((x) => x === '-n'); if (i >= 0) return parseInt(args[i + 1] ?? '10', 10); const m = args.find((x) => /^-\d+$/.test(x)); return m ? parseInt(m.slice(1), 10) : Infinity; })();
      const list = [...repo.commits].reverse().slice(0, n);
      if (flags.includes('--oneline')) return { chunks: [out(list.map((c) => `${c.sha.slice(0, 7)} ${c.message}\n`).join(''))], code: 0 };
      return { chunks: [out(list.map((c) => `commit ${c.sha}\nAuthor: ${c.author} <${c.author}@orbital.example>\nDate:   ${ansic(c.at)}\n\n    ${c.message}\n`).join('\n'))], code: 0 };
    }
    case 'diff': {
      const cached = flags.includes('--staged') || flags.includes('--cached');
      const [a, b] = cached ? [head.tree, repo.index] : [repo.index, work];
      const scope = paths.map(rel);
      const changed = all(a, b).filter((p) => a[p] !== b[p] && (cached || a[p] !== undefined) && (!scope.length || scope.some((s) => s === '' || p === s || p.startsWith(s + '/'))));
      return { chunks: [out(changed.map((p) => unifiedDiff(p, a[p], b[p])).join(''))], code: 0 };
    }
    case 'revert': {
      if (staged.length || unstaged.length) return { chunks: [err('error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.\nfatal: revert failed\n')], code: 128 };
      const which = paths[0] ?? 'HEAD';
      if (which !== 'HEAD' && !head.sha.startsWith(which)) return { chunks: [err('kubequest: only `git revert HEAD` is simulated\n')], code: 1 };
      const parent = repo.commits[repo.commits.length - 2];
      if (!parent) return { chunks: [err('error: commit ' + head.sha.slice(0, 7) + ' has no parent\nfatal: revert failed\n')], code: 128 };
      for (const p of all(head.tree, parent.tree)) { if (parent.tree[p] === undefined) vfs.remove(`${repo.dir}/${p}`); else vfs.write(`${repo.dir}/${p}`, parent.tree[p] as string); }
      repo.index = { ...parent.tree };
      const c = makeCommit(`Revert "${head.message}"`, parent.tree);
      return { chunks: [out(`[main ${c.sha.slice(0, 7)}] ${c.message}\n Date: ${ansic(c.at)}\n${stat(head.tree, c.tree)}`)], code: 0 };
    }
    case 'remote': return { chunks: [out(flags.includes('-v') ? `origin\t${repo.url} (fetch)\norigin\t${repo.url} (push)\n` : 'origin\n')], code: 0 };
    case 'branch': return { chunks: [out('* main\n')], code: 0 };
    case 'fetch': return { chunks: [], code: 0 };
    case 'checkout': case 'switch': case 'merge': case 'rebase': case 'reset': case 'stash': case 'tag': case 'clone': case 'init': case 'cherry-pick': case 'show':
      return { chunks: [err(`kubequest: \`git ${sub}\` is not simulated (this workstation has one branch and one remote)\n`)], code: 1 };
    default:
      return { chunks: [err(`git: '${sub}' is not a git command. See 'git --help'.\n`)], code: 1 };
  }
}

function runGitStatusAsFailure(engine: Engine, vfs: Vfs): { chunks: OutputChunk[]; code: number } {
  const r = runGit(engine, vfs, ['status']);
  return { chunks: r.chunks, code: 1 };
}
