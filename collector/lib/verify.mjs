/**
 * Quote verification.
 *
 * The model is given page text and asked to quote from it. This checks that it
 * actually did. A quote that cannot be found in the page it cites is dropped —
 * not flagged, dropped — because a fabricated citation in an equity-research
 * dashboard is the one failure that discredits everything around it.
 *
 * Exact matching is too strict (models normalise punctuation and whitespace and
 * trim politely), so the test is: does a run of consecutive words from the quote
 * appear verbatim in the source?
 */

export function normaliseForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―—–]/g, '-')
    .replace(/…/g, ' ... ')
    .replace(/[^a-z0-9'" -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the complete quoted text appears in the source.
 * When ellipses ('...' or '…') are used to condense quotes, every span must
 * appear in the source in the same sequential order.
 */
export function quoteAppearsIn(quote, sourceText) {
  const hay = normaliseForMatch(sourceText);
  if (!hay) return false;

  const rawParts = String(quote || '').split(/\.{3,}|…/);
  const spans = rawParts.map((p) => normaliseForMatch(p)).filter(Boolean);

  if (!spans.length) return false;

  let searchFromIndex = 0;
  for (const span of spans) {
    const idx = hay.indexOf(span, searchFromIndex);
    if (idx === -1) return false;
    searchFromIndex = idx + span.length;
  }
  return true;
}

/**
 * Keep the quotes that check out; report the ones that did not.
 * Distinguish verified text from verified attribution/date.
 */
export function verifyQuotes(quotes, pages) {
  const kept = [];
  const rejected = [];

  for (const quote of quotes) {
    const cited = Number.isInteger(quote.sourceIndex) ? pages[quote.sourceIndex] : null;
    let match = cited && quoteAppearsIn(quote.text, cited.markdown) ? cited : null;
    if (!match) match = pages.find((p) => quoteAppearsIn(quote.text, p.markdown)) || null;

    if (!match) {
      rejected.push({ text: quote.text.slice(0, 90), reason: 'quote text not found in full in any fetched page' });
      continue;
    }

    const sourceHay = normaliseForMatch(match.markdown);
    const hasName = Boolean(quote.name && quote.name.trim() && quote.name.trim().toLowerCase() !== 'anonymous');
    const attributionVerified = hasName
      ? sourceHay.includes(normaliseForMatch(quote.name))
      : true;

    const dateStr = String(quote.date || '').trim();
    const dateYear = dateStr ? dateStr.slice(0, 4) : null;
    const dateVerified = dateYear ? sourceHay.includes(dateYear) : false;

    kept.push({
      ...quote,
      url: match.url,
      platform: quote.platform || match.title || '',
      verified: true,
      attributionVerified,
      dateVerified,
      relocated: Boolean(cited && match !== cited),
    });
  }
  return { kept, rejected };
}
