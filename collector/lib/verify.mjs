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
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9'" -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `minRun` consecutive words of the quote appear in the source.
 * Short quotes must match in full.
 */
export function quoteAppearsIn(quote, sourceText, { minRun = 8 } = {}) {
  const needleWords = normaliseForMatch(quote).split(' ').filter(Boolean);
  const hay = normaliseForMatch(sourceText);
  if (!needleWords.length || !hay) return false;

  if (needleWords.length <= minRun) return hay.includes(needleWords.join(' '));

  for (let i = 0; i + minRun <= needleWords.length; i += 1) {
    if (hay.includes(needleWords.slice(i, i + minRun).join(' '))) return true;
  }
  return false;
}

/**
 * Keep the quotes that check out; report the ones that did not.
 * A quote may cite any of the supplied pages — the model's index is a hint, not
 * a constraint, so a correct quote attributed to the wrong page still survives
 * and gets its link corrected.
 */
export function verifyQuotes(quotes, pages, { minRun = 8 } = {}) {
  const kept = [];
  const rejected = [];

  for (const quote of quotes) {
    const cited = Number.isInteger(quote.sourceIndex) ? pages[quote.sourceIndex] : null;
    let match = cited && quoteAppearsIn(quote.text, cited.markdown, { minRun }) ? cited : null;
    if (!match) match = pages.find((p) => quoteAppearsIn(quote.text, p.markdown, { minRun })) || null;

    if (!match) {
      rejected.push({ text: quote.text.slice(0, 90), reason: 'not found in any fetched page' });
      continue;
    }
    kept.push({
      ...quote,
      url: match.url,
      platform: quote.platform || match.title || '',
      verified: true,
      relocated: Boolean(cited && match !== cited),
    });
  }
  return { kept, rejected };
}
