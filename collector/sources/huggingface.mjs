import { getJson, pace, truncate } from '../lib/http.mjs';

export const id = 'huggingface';
export const label = 'Hugging Face';

/**
 * Where a released model is actually used and argued about. The public API
 * needs no key; model cards carry the maintainer's claims and the community
 * tab carries everyone else's.
 */
export async function collect(cfg) {
  const items = [];
  const errors = [];

  for (const query of cfg.queries || []) {
    try {
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}`
        + `&limit=${cfg.perQuery || 10}&full=true&sort=downloads&direction=-1`;
      const models = await getJson(url);
      for (const model of Array.isArray(models) ? models : []) {
        const card = model.cardData?.model_description || model.cardData?.description || '';
        const text = `${model.pipeline_tag || ''} ${card}`.trim();
        if (!model.id) continue;
        items.push({
          id: `hf:${model.id}`,
          source: id,
          sourceLabel: label,
          kind: 'model',
          author: model.author || null,
          title: model.id,
          text: truncate(text || model.id),
          url: `https://huggingface.co/${model.id}`,
          date: model.lastModified || model.createdAt || null,
          engagement: model.downloads || model.likes || 0,
          query,
        });
      }
    } catch (err) {
      errors.push(`models "${query}": ${err.message}`);
    }
    await pace(800);
  }

  // The community tab is where people say whether it actually works.
  for (const repo of cfg.discussionsFor || []) {
    try {
      const data = await getJson(`https://huggingface.co/api/models/${repo}/discussions`);
      for (const d of data?.discussions || []) {
        if (!d.title) continue;
        items.push({
          id: `hf-disc:${repo}:${d.num}`,
          source: id,
          sourceLabel: `Hugging Face: ${repo}`,
          kind: 'comment',
          author: d.author?.name || null,
          title: d.title,
          text: truncate(d.title),
          url: `https://huggingface.co/${repo}/discussions/${d.num}`,
          date: d.createdAt || null,
          engagement: d.numComments || 0,
        });
      }
    } catch (err) {
      errors.push(`discussions ${repo}: ${err.message}`);
    }
    await pace(800);
  }

  if (errors.length) items.errors = errors;
  return items;
}
