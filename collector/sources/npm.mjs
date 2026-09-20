import { getJson, pace } from '../lib/http.mjs';

export const id = 'npm';
export const label = 'npm Registry';

export const SAP_AI_PACKAGES = [
  { id: 'orchestration', name: '@sap-ai-sdk/orchestration', label: 'Orchestration', desc: 'Routes to Joule, RPT-1, LLMs' },
  { id: 'core', name: '@sap-ai-sdk/core', label: 'Core', desc: 'Core client & auth layer' },
  { id: 'ai-api', name: '@sap-ai-sdk/ai-api', label: 'AI API', desc: 'SAP AI Core interface' },
  { id: 'foundation-models', name: '@sap-ai-sdk/foundation-models', label: 'Foundation Models', desc: 'Direct model wrappers' },
  { id: 'langchain', name: '@sap-ai-sdk/langchain', label: 'LangChain', desc: 'LangChain adapter' },
];

/** Fetch download count for a given point period (e.g. 'last-day', 'last-week', 'last-month') */
export async function fetchPoint(packageName, period = 'last-week') {
  const url = `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(packageName)}`;
  return getJson(url);
}

/** Fetch daily download series for a range (max 365 days per call). */
export async function fetchRange(packageName, startDate, endDate) {
  const url = `https://api.npmjs.org/downloads/range/${startDate}:${endDate}/${encodeURIComponent(packageName)}`;
  return getJson(url);
}

/**
 * Standard collector interface: produces telemetry items that feed into the
 * corpus for topics like 'btp_ai' and 'joule_sentiment'.
 */
export async function collect(cfg = {}) {
  const items = [];
  const errors = [];
  const packages = cfg.packages || SAP_AI_PACKAGES.map((p) => p.name);

  for (const pkgName of packages) {
    try {
      const point = await fetchPoint(pkgName, 'last-week');
      const downloads = point?.downloads || 0;
      const start = point?.start;
      const end = point?.end;

      items.push({
        id: `npm:${pkgName}:${end}`,
        source: id,
        sourceLabel: label,
        kind: 'telemetry',
        author: 'npm registry',
        title: `${pkgName}: ${downloads.toLocaleString()} downloads in the last week`,
        text: `Official SAP AI SDK package ${pkgName} recorded ${downloads.toLocaleString()} downloads between ${start} and ${end}. This measures real enterprise developer adoption for SAP AI Core, Joule, and Orchestration services.`,
        url: `https://www.npmjs.com/package/${pkgName}`,
        date: end ? `${end}T00:00:00Z` : new Date().toISOString(),
        engagement: downloads,
        metric: {
          package: pkgName,
          downloads,
          start,
          end,
        },
      });
    } catch (err) {
      errors.push(`${pkgName}: ${err.message}`);
    }
    await pace(250);
  }

  if (errors.length) items.errors = errors;
  return items;
}

/** Update the sdk-downloads.json file with the latest point and recent data. */
export async function syncSdkDownloads(filePath = 'web/data/sdk-downloads.json') {
  const fs = await import('node:fs');
  try {
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let updatedAny = false;
    for (const pkg of SAP_AI_PACKAGES) {
      try {
        const ptWeek = await fetchPoint(pkg.name, 'last-week');
        if (typeof ptWeek?.downloads === 'number' && data.summary?.byPackage?.[pkg.name]) {
          data.summary.byPackage[pkg.name].weekly = ptWeek.downloads;
          updatedAny = true;
        }
        await pace(150);
        const ptMonth = await fetchPoint(pkg.name, 'last-month');
        if (typeof ptMonth?.downloads === 'number' && data.summary?.byPackage?.[pkg.name]) {
          data.summary.byPackage[pkg.name].monthly = ptMonth.downloads;
          updatedAny = true;
        }
        await pace(150);
      } catch { /* keep existing on error */ }
    }

    if (updatedAny && data.summary?.byPackage) {
      let weeklyTotal = 0;
      let monthlyTotal = 0;
      for (const pkg of SAP_AI_PACKAGES) {
        weeklyTotal += data.summary.byPackage[pkg.name]?.weekly || 0;
        monthlyTotal += data.summary.byPackage[pkg.name]?.monthly || 0;
      }
      if (weeklyTotal > 0) data.summary.weeklyGrandTotal = weeklyTotal;
      if (monthlyTotal > 0) data.summary.monthlyGrandTotal = monthlyTotal;

      const orchWeekly = data.summary.byPackage['@sap-ai-sdk/orchestration']?.weekly || 0;
      const langWeekly = data.summary.byPackage['@sap-ai-sdk/langchain']?.weekly || 0;
      if (orchWeekly + langWeekly > 0) {
        data.summary.nativeOrchestrationShare = Math.round((orchWeekly / (orchWeekly + langWeekly)) * 100);
      }
    }

    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* best effort */ }
}
