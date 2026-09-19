/**
 * Firecrawl: web search and page fetching.
 *
 * Bedrock has no server-side web search, so retrieval happens here instead.
 * That is the better arrangement anyway — we end up holding the real URLs and
 * the real page text, so a quote can be checked against the page it cites.
 *
 * The API version is configurable because it moves; FIRECRAWL_VERSION overrides,
 * and a version mismatch is retried against the other one rather than failing
 * the whole run.
 */

const BASE = process.env.FIRECRAWL_BASE || 'https://api.firecrawl.dev';
const VERSIONS = [process.env.FIRECRAWL_VERSION || 'v2', 'v1'];

function key() {
  const value = process.env.FIRECRAWL_API_KEY;
  if (!value) throw new Error('FIRECRAWL_API_KEY is not set');
  return value;
}

async function call(path, body, { log = () => {} } = {}) {
  let lastError;
  for (const version of [...new Set(VERSIONS)]) {
    const url = `${BASE}/${version}${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 404 || res.status === 400) {
        // Most likely the wrong API version for this account; try the other.
        lastError = new Error(`${version}${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
        log(`    ${version} rejected (${res.status}), trying the next version`);
        continue;
      }
      if (!res.ok) throw new Error(`${version}${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      log(`    ${version}${path} ok`);
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`all Firecrawl versions failed for ${path}`);
}

/** Normalise the differently-shaped payloads the versions return. */
function normaliseResults(payload) {
  const rows = payload?.data?.web || payload?.data || payload?.results || [];
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({
    url: row.url || row.link || '',
    title: row.title || row.metadata?.title || '',
    description: row.description || row.snippet || row.metadata?.description || '',
    markdown: row.markdown || row.content || row.metadata?.markdown || '',
  })).filter((row) => row.url);
}

/** Search the web, asking for page text in the same call where supported. */
export async function search(query, { limit = 6, log } = {}) {
  const payload = await call('/search', {
    query,
    limit,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  }, { log });
  return normaliseResults(payload);
}

/** Fetch one page as text, for results a search returned without content. */
export async function scrape(url, { log } = {}) {
  const payload = await call('/scrape', {
    url,
    formats: ['markdown'],
    onlyMainContent: true,
  }, { log });
  const data = payload?.data || payload;
  return {
    url,
    title: data?.metadata?.title || '',
    markdown: data?.markdown || data?.content || '',
  };
}

/**
 * Everything a topic needs: several searches, deduped, with page text filled in.
 * Failures are per query and per page — a dead result never costs the run.
 */
export async function gather(queries, { perQuery = 5, maxPages = 12, log = () => {} } = {}) {
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
      page.markdown = fetched.markdown || page.markdown;
      page.title = page.title || fetched.title;
    } catch (err) {
      errors.push(`scrape ${page.url}: ${err.message}`);
    }
  }

  const usable = pages.filter((p) => (p.markdown || '').trim().length > 200);
  log(`    ${usable.length}/${pages.length} pages usable`);
  return { pages: usable, errors };
}
