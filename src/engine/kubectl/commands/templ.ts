/** Pod template rendering shared by `rollout history --revision`. */
import type { PodTemplateSpec } from '../../types.ts';
import { tabwrite } from '../tabwriter.ts';
import { labelsToString } from '../../selector.ts';

export function describePodTemplateOnly(tpl: PodTemplateSpec): string {
  const lines: string[] = ['Pod Template:'];
  lines.push(`  Labels:\t${labelsToString(tpl.metadata.labels).replace(/,/g, '\n\t')}`);
  if (tpl.metadata.annotations && Object.keys(tpl.metadata.annotations).length) lines.push(`  Annotations:\t${Object.entries(tpl.metadata.annotations).map(([k, v]) => `${k}: ${v}`).join('\n\t')}`);
  lines.push('  Containers:');
  for (const c of tpl.spec.containers) {
    lines.push(`   ${c.name}:`);
    lines.push(`    Image:\t${c.image}`);
    const ports = c.ports ?? [];
    lines.push(`    Port:\t${ports.length ? ports.map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') : '<none>'}`);
    lines.push(`    Host Port:\t${ports.length ? ports.map((p) => `${p.hostPort ?? 0}/${p.protocol ?? 'TCP'}`).join(', ') : '<none>'}`);
    const env = c.env ?? [];
    if (env.length) { lines.push('    Environment:'); for (const e of env) lines.push(`      ${e.name}:\t${e.value ?? ''}`); }
    else lines.push('    Environment:\t<none>');
    lines.push(`    Mounts:\t${c.volumeMounts?.length ? c.volumeMounts.map((m) => `${m.mountPath} from ${m.name}`).join('\n\t') : '<none>'}`);
  }
  lines.push(`  Volumes:\t${tpl.spec.volumes?.length ? tpl.spec.volumes.map((v) => v.name).join(', ') : '<none>'}`);
  lines.push(`  Node-Selectors:\t${tpl.spec.nodeSelector ? Object.entries(tpl.spec.nodeSelector).map(([k, v]) => `${k}=${v}`).join(',') : '<none>'}`);
  lines.push(`  Tolerations:\t${tpl.spec.tolerations?.length ? tpl.spec.tolerations.map((t) => `${t.key ?? ''}${t.value ? '=' + t.value : ''}:${t.effect ?? ''}${t.operator === 'Exists' ? ' op=Exists' : ''}${t.tolerationSeconds !== undefined ? ` for ${t.tolerationSeconds}s` : ''}`).join('\n\t') : '<none>'}`);
  return tabwrite(lines.join('\n') + '\n', { minwidth: 0, tabwidth: 8, padding: 2 });
}
