/** Port of Go's text/tabwriter column-block algorithm (enough for kubectl's usage: no HTML, no AlignRight). */

interface Cell { text: string; width: number }

export interface TabwriterOptions { minwidth: number; tabwidth: number; padding: number; padchar?: string }

export function tabwrite(text: string, opts: TabwriterOptions): string {
  const padchar = opts.padchar ?? ' ';
  const lines: Cell[][] = text.split('\n').map((l) => l.split('\t').map((t) => ({ text: t, width: [...t].length })));
  // the text after the final newline is an empty trailing line; keep Go semantics by treating it as a line with one empty cell
  const widths: number[] = [];
  const out: string[] = [];
  const writeLines = (line0: number, line1: number): void => {
    for (let i = line0; i < line1; i++) {
      const line = lines[i] as Cell[];
      let s = '';
      for (let j = 0; j < line.length; j++) {
        const c = line[j] as Cell;
        if (j < widths.length) {
          s += c.text;
          const w = widths[j] as number;
          if (w > c.width) s += padchar === '\t' ? '\t'.repeat(Math.ceil((w - c.width) / opts.tabwidth)) : padchar.repeat(w - c.width);
        } else {
          s += c.text; // last cell of a line (no trailing tab) is written as-is
        }
      }
      out.push(s);
    }
  };
  const format = (line0: number, line1: number): void => {
    const column = widths.length;
    let start = line0;
    for (let i = line0; i < line1; i++) {
      const line = lines[i] as Cell[];
      if (column >= line.length - 1) continue;
      writeLines(start, i);
      start = i;
      let width = opts.minwidth;
      let discardable = true;
      let j = i;
      for (; j < line1; j++) {
        const l = lines[j] as Cell[];
        if (column >= l.length - 1) break;
        const c = l[column] as Cell;
        const w = c.width + opts.padding;
        if (w > width) width = w;
        if (c.width > 0) discardable = false;
      }
      if (discardable) width = 0; // DiscardEmptyColumns is not set in kubectl, but empty cells still get min width; keep Go behaviour: width=minwidth
      if (discardable) width = opts.minwidth === 0 ? opts.padding : opts.minwidth;
      widths.push(width);
      format(start, j);
      widths.pop();
      start = j;
      i = j - 1;
    }
    writeLines(start, line1);
  };
  format(0, lines.length);
  return out.join('\n');
}
