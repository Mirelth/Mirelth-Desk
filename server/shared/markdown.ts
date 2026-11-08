function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listOpen = false;
  let tableRows: string[][] = [];
  let codeOpen = false;

  const flushParagraph = (): void => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (listOpen) html.push('</ul>');
    listOpen = false;
  };
  const flushTable = (): void => {
    if (!tableRows.length) return;
    const [head, ...body] = tableRows;
    html.push('<table><thead><tr>' + head.map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>');
    for (const row of body) html.push('<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>');
    html.push('</tbody></table>');
    tableRows = [];
  };
  const flushAll = (): void => { flushParagraph(); flushList(); flushTable(); };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushAll();
      if (codeOpen) html.push('</code></pre>');
      else html.push('<pre><code>');
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) { html.push(`${escapeHtml(line)}\n`); continue; }
    const trimmed = line.trim();
    if (!trimmed) { flushAll(); continue; }
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph(); flushList();
      const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(cells);
      continue;
    }
    flushTable();
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) { flushAll(); html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inline(trimmed.replace(/^(?:[-*]|\d+\.)\s+/, ''))}</li>`);
      continue;
    }
    flushList();
    if (trimmed.startsWith('>')) { flushParagraph(); html.push(`<blockquote>${inline(trimmed.slice(1).trim())}</blockquote>`); continue; }
    paragraph.push(trimmed);
  }
  flushAll();
  if (codeOpen) html.push('</code></pre>');
  return html.join('\n');
}

export function exportHtml(title: string, markdown: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{max-width:820px;margin:48px auto;padding:0 24px;font:16px/1.8 -apple-system,"PingFang SC",sans-serif;color:#1c2333}h1,h2,h3{margin-top:1.6em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe3ec;padding:8px 12px;text-align:left}th{background:#f4f6fb}code{background:#f1f3f8;padding:2px 6px;border-radius:4px}pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:10px;overflow:auto}blockquote{border-left:3px solid #6c7cff;margin:0;padding-left:16px;color:#5a6478}</style>
</head><body>${renderMarkdown(markdown)}</body></html>`;
}
