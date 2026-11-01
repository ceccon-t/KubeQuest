/** Shared -o handling for get/create/run/apply (yaml, json, name, jsonpath, wide, table). */
import type { KubeObject } from '../types.ts';
import { stringify, toJsonPretty } from '../yaml.ts';
import { jsonpath } from './jsonpath.ts';
import { KubectlError } from './args.ts';
import { qualifiedName } from '../registry.ts';
import { sortKeys } from '../yaml.ts';

export type OutputFormat = { kind: 'table'; wide: boolean } | { kind: 'yaml' } | { kind: 'json' } | { kind: 'name' } | { kind: 'jsonpath'; template: string };

export function parseOutputFlag(o: string | undefined): OutputFormat {
  if (!o || o === '') return { kind: 'table', wide: false };
  if (o === 'wide') return { kind: 'table', wide: true };
  if (o === 'yaml') return { kind: 'yaml' };
  if (o === 'json') return { kind: 'json' };
  if (o === 'name') return { kind: 'name' };
  if (o.startsWith('jsonpath=')) return { kind: 'jsonpath', template: o.slice('jsonpath='.length) };
  if (o.startsWith('custom-columns') || o.startsWith('go-template') || o.startsWith('template') || o === 'jsonpath-file' || o.startsWith('jsonpath-as-json')) {
    throw new KubectlError(`kubequest: output format "${o.split('=')[0]}" is not supported in the simulator yet`);
  }
  throw new KubectlError(`unable to match a printer suitable for the output format "${o}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`);
}

/** Strip nothing — our objects are already API-shaped. Kept as a hook for future managedFields etc. */
export function forOutput(obj: KubeObject): KubeObject {
  return sortKeys(obj) as KubeObject;
}

export function listOf(items: KubeObject[]): KubeObject {
  return { apiVersion: 'v1', items: items.map(forOutput), kind: 'List', metadata: { resourceVersion: '' } } as unknown as KubeObject;
}

export function renderObjects(fmt: OutputFormat, objs: KubeObject[], single: boolean): string {
  const data = single && objs.length === 1 ? forOutput(objs[0] as KubeObject) : listOf(objs);
  switch (fmt.kind) {
    case 'yaml': return stringify(data as never);
    case 'json': return toJsonPretty(data) + '\n';
    case 'name': return objs.map((o) => qualifiedName(o.kind, o.metadata.name)).join('\n') + (objs.length ? '\n' : '');
    case 'jsonpath': {
      const s = jsonpath(fmt.template, data);
      return s;
    }
    default: return '';
  }
}
