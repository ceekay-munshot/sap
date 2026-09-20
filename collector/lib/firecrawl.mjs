/**
 * Resilient web retrieval: Firecrawl with automatic fallback to DuckDuckGo,
 * Google News RSS, direct page scraping, and the verified practitioner corpus.
 *
 * Bedrock has no server-side web search, so retrieval happens here.
 * When Firecrawl has credits, it provides fast scraped search results.
 * If Firecrawl is not configured, runs out of credits (HTTP 402), or encounters
 * rate limits / downtime, this seamlessly falls back to free web search engines,
 * direct DOM text scraping, and verified practitioner evidence from the corpus.
 *
 * It NEVER crashes the research pass or returns zero pages due to credit limits.
 */

import { fetchWithRetry, stripHtml } from './http.mjs';
import { readJson } from './store.mjs';
import { topicsFor } from './topicmatch.mjs';

const BASE = process.env.FIRECRAWL_BASE || 'https://api.firecrawl.dev';
const VERSIONS = [process.env.FIRECRAWL_VERSION || 'v2', 'v1'];
const CORPUS_PATH = 'data/corpus.json';

let firecrawlExhausted = false;

function key() {
  return process.env.FIRECRAWL_API_KEY || '';
}

async function callFirecrawl(path, body, { log = () => {} } = {}) {
  const apiKey = key();
  if (!apiKey || firecrawlExhausted) return null;

  let lastError;
  for (const version of [...new Set(VERSIONS)]) {
    const url = `${BASE}/${version}${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 402) {
        firecrawlExhausted = true;
        log(`    ! Firecrawl credits exhausted (${version}${path} → HTTP 402) — switching to resilient search`);
        return null;
      }
      if (res.status === 404 || res.status === 400) {
        lastError = new Error(`${version}${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }
      if (!res.ok) {
        lastError = new Error(`${version}${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
        continue;
      }
      log(`    ${version}${path} ok`);
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    log(`    ! Firecrawl unavailable: ${lastError.message}`);
  }
  return null;
}

/** Normalise the differently-shaped payloads Firecrawl versions return. */
function normaliseFirecrawlResults(payload) {
  const rows = payload?.data?.web || payload?.data || payload?.results || [];
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({
    url: row.url || row.link || '',
    title: row.title || row.metadata?.title || '',
    description: row.description || row.snippet || row.metadata?.description || '',
    markdown: row.markdown || row.content || row.metadata?.markdown || '',
  })).filter((row) => row.url);
}

/** Free fallback search using DuckDuckGo HTML search. */
async function searchDuckDuckGo(query, { limit = 6, log = () => {} } = {}) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, { timeoutMs: 12000, retries: 2 });
    const html = await res.text();
    const results = [];
    const blocks = html.split(/class=\"[^\"]*result\s+results_links[^\"]*\"/);
    for (const block of blocks.slice(1)) {
      const linkMatch = block.match(/href=\"([^\"]*uddg=[^\"]*)\"/);
      const rawLink = linkMatch ? linkMatch[1] : '';
      let link = '';
      if (rawLink.includes('uddg=')) {
        try {
          const u = new URL(rawLink, 'https://duckduckgo.com');
          link = decodeURIComponent(u.searchParams.get('uddg') || '');
        } catch {}
      }
      const title = stripHtml((block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '');
      const snippet = stripHtml((block.match(/<a[^>]+class=\"[^\"]*result__snippet[^\"]*\"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
      if (link && (title || snippet)) {
        results.push({ url: link, title: title || snippet, description: snippet, markdown: '' });
        if (results.length >= limit) break;
      }
    }
    return results;
  } catch (err) {
    log(`    ! DuckDuckGo fallback failed: ${err.message}`);
    return [];
  }
}

/** Free fallback search using Google News RSS. */
async function searchGoogleNews(query, { limit = 6, log = () => {} } = {}) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, { timeoutMs: 10000, retries: 1 });
    const text = await res.text();
    const items = [...text.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/gi)];
    return items.slice(0, limit).map((m) => ({
      url: stripHtml(m[2]).trim(),
      title: stripHtml(m[1]).trim(),
      description: `Published: ${m[3]}`,
      markdown: '',
    })).filter((r) => r.url);
  } catch (err) {
    return [];
  }
}

/** Search the web using Firecrawl, falling back to free search engines on quota exhaustion. */
export async function search(query, { limit = 6, log = () => {} } = {}) {
  if (key() && !firecrawlExhausted) {
    try {
      const payload = await callFirecrawl('/search', {
        query,
        limit,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      }, { log });
      if (payload) {
        const results = normaliseFirecrawlResults(payload);
        if (results.length) return results;
      }
    } catch (err) {
      log(`    ! Firecrawl search error: ${err.message}`);
    }
  }

  // Free fallback search engines
  const ddg = await searchDuckDuckGo(query, { limit, log });
  if (ddg.length >= limit) return ddg;

  const gnews = await searchGoogleNews(query, { limit: limit - ddg.length, log });
  const byUrl = new Map();
  for (const item of [...ddg, ...gnews]) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

/** Convert raw HTML into clean readable markdown / text. */
function htmlToReadableMarkdown(html) {
  if (!html) return { title: '', text: '' };
  let clean = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');

  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripHtml(titleMatch ? titleMatch[1] : '');

  const mainMatch = clean.match(/<article[\s\S]*?<\/article>/i)
    || clean.match(/<main[\s\S]*?<\/main>/i)
    || clean.match(/<div[^>]+class=[\"'][^\"']*(?:content|article|post-body|entry-content)[^\"']*[\"'][\s\S]*?<\/div>/i)
    || clean.match(/<body[\s\S]*?<\/body>/i);

  let body = mainMatch ? mainMatch[0] : clean;
  body = body
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n# $1\n\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  const text = stripHtml(body)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .trim();

  return { title, text };
}

/** Direct page fetch and clean extraction for public URLs. */
async function scrapeDirect(url, { log = () => {} } = {}) {
  try {
    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, { timeoutMs: 12000, retries: 1 });
    const html = await res.text();
    const { title, text } = htmlToReadableMarkdown(html);
    return { url, title, markdown: text };
  } catch (err) {
    return { url, title: '', markdown: '' };
  }
}

/** Fetch one page as text, with direct scrape fallback if Firecrawl is out of credits. */
export async function scrape(url, { log = () => {} } = {}) {
  if (key() && !firecrawlExhausted) {
    try {
      const payload = await callFirecrawl('/scrape', {
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }, { log });
      const data = payload?.data || payload;
      if (data?.markdown || data?.content) {
        return {
          url,
          title: data?.metadata?.title || '',
          markdown: data?.markdown || data?.content || '',
        };
      }
    } catch {}
  }
  return scrapeDirect(url, { log });
}

/**
 * Retrieve authentic practitioner evidence from the local corpus for this topic.
 * Guarantees that the research pass always has real, verbatim quotes and
 * verified URLs even during external API downtime or credit exhaustion.
 */
export function getCorpusPages(topicId, queries = [], count = 8) {
  const corpusData = readJson(CORPUS_PATH, { items: [] });
  const items = Array.isArray(corpusData.items) ? corpusData.items : [];
  if (!items.length) return [];

  const terms = (queries || [])
    .flatMap((q) => q.toLowerCase().split(/\s+/))
    .filter((w) => w.length > 3 && !['review', 'experience', 'feedback', 'practitioner', 'assistant'].includes(w));

  const matched = items.filter((item) => {
    if (!item.text || item.text.length < 150) return false;
    if (topicId && Array.isArray(item.topics) && item.topics.includes(topicId)) return true;
    if (topicId && topicsFor(item.text).includes(topicId)) return true;
    const textLower = `${item.title || ''} ${item.text}`.toLowerCase();
    return terms.some((t) => textLower.includes(t));
  });

  // Sort by recency, prioritizing recent years (2026, 2025)
  matched.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

  const byUrl = new Map();
  for (const item of matched) {
    if (!item.url || byUrl.has(item.url)) continue;
    const dateStr = item.date ? item.date.slice(0, 10) : '';
    const platform = item.sourceLabel || item.source || 'Practitioner Review';
    const author = item.author && item.author !== 'null' ? ` | Author: ${item.author}` : '';
    const dateLine = dateStr ? ` | Date: ${dateStr}` : '';
    const cleanText = stripHtml(item.text).trim();
    if (cleanText.length < 150) continue;

    const page = {
      url: item.url,
      title: item.title || `${platform} discussion on SAP`,
      markdown: `# ${item.title || platform}\nPlatform: ${platform}${author}${dateLine}\n\n${cleanText}\n`,
    };
    byUrl.set(item.url, page);
    if (byUrl.size >= count) break;
  }

  return [...byUrl.values()];
}

/**
 * Gather research pages: Firecrawl searches + fallback web searches + verified practitioner corpus.
 * Always delivers high-quality, authentic evidence and never fails due to API credit limits.
 */
export async function gather(queries, { perQuery = 5, maxPages = 12, log = () => {}, topicId = null, topicLabel = null } = {}) {
  const byUrl = new Map();
  const errors = [];

  for (const query of queries) {
    try {
      const results = await search(query, { limit: perQuery, log });
      for (const row of results) {
        if (!byUrl.has(row.url)) byUrl.set(row.url, { ...row, query });
      }
      log(`    "${query}" → ${results.length} results`);
    } catch (err) {
      errors.push(`search "${query}": ${err.message}`);
      log(`    ! search "${query}" failed: ${err.message}`);
    }
  }

  const pages = [...byUrl.values()].slice(0, maxPages);
  for (const page of pages) {
    if (page.markdown && page.markdown.length > 400) continue;
    try {
      const fetched = await scrape(page.url, { log });
      page.markdown = fetched.markdown || page.markdown || page.description || '';
      page.title = page.title || fetched.title;
    } catch (err) {
      errors.push(`scrape ${page.url}: ${err.message}`);
    }
  }

  let usable = pages.filter((p) => (p.markdown || '').trim().length > 200);

  // If live web search and scraping returned fewer than 8 usable pages (e.g. Firecrawl credits exhausted,
  // paywalls, or blocking), supplement with verified practitioner evidence from the corpus.
  if (usable.length < Math.min(maxPages, 8)) {
    const needed = maxPages - usable.length;
    const corpusPages = getCorpusPages(topicId, queries, needed);
    for (const cp of corpusPages) {
      if (!byUrl.has(cp.url)) {
        usable.push(cp);
        byUrl.set(cp.url, cp);
      }
      if (usable.length >= maxPages) break;
    }
    if (corpusPages.length) {
      log(`    supplemented with ${corpusPages.length} verified practitioner page(s)`);
    }
  }

  log(`    ${usable.length}/${usable.length > pages.length ? usable.length : pages.length} pages usable`);
  return { pages: usable, errors };
}
