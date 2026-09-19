/** Small, polite HTTP helpers. Every network edge in the collector goes through here. */

export const USER_AGENT =
  process.env.COLLECTOR_UA ||
  'sap-ai-radar/1.0 (+https://github.com/ceekay-munshot/sap) research-dashboard';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 20000, backoffMs = 1200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(options.headers || {}) },
      });
      clearTimeout(timer);
      // 4xx other than 429 will not get better by retrying.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function getJson(url, options) {
  const res = await fetchWithRetry(url, options);
  return res.json();
}

export async function getText(url, options) {
  const res = await fetchWithRetry(url, options);
  return res.text();
}

/** Keep us well inside every source's rate limit. */
export const pace = (ms = 350) => sleep(ms);

/** Strip HTML to readable text without pulling in a parser. */
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text, max = 1200) {
  const t = (text || '').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
