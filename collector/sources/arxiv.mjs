import { getText, pace, stripHtml, truncate } from '../lib/http.mjs';

export const id = 'arxiv';
export const label = 'arXiv';

/**
 * SAP's RPT-1 is a research artifact, so the substantive discussion of it sits
 * in papers rather than in ERP trade press. arXiv's API is public and keyless.
 */
const field = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
};

export async function collect(cfg) {
  const items = [];
  const errors = [];
  for (const query of cfg.queries || []) {
    try {
      const url = 'https://export.arxiv.org/api/query'
        + `?search_query=${encodeURIComponent(query)}`
        + `&sortBy=submittedDate&sortOrder=descending&max_results=${cfg.perQuery || 15}`;
      const xml = await getText(url);
      for (const m of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
        const entry = m[0];
        const link = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
        const title = field(entry, 'title');
        const summary = field(entry, 'summary');
        if (!title) continue;
        items.push({
          id: `arxiv:${link.trim()}`,
          source: id,
          sourceLabel: label,
          kind: 'paper',
          author: field(entry, 'name') || null,
          title,
          text: truncate(summary || title),
          url: link.trim(),
          date: field(entry, 'published') || null,
          engagement: 0,
          query,
        });
      }
    } catch (err) {
      errors.push(`${query}: ${err.message}`);
    }
    await pace(3000);   // arXiv asks for one request every few seconds
  }
  if (errors.length) items.errors = errors;
  return items;
}
