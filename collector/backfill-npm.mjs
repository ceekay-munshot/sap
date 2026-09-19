#!/usr/bin/env node
/**
 * Backfills the full historical daily time-series of npm downloads for all official
 * SAP AI SDK packages (@sap-ai-sdk) and saves to web/data/sdk-downloads.json.
 *
 * Safe to run anytime: it handles range chunking (365 days max per npm query)
 * and aggregates daily & weekly series with summary KPIs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAP_AI_PACKAGES, fetchRange, fetchPoint } from './sources/npm.mjs';
import { pace } from './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'web', 'data', 'sdk-downloads.json');

// Range spans from package introduction (~September 2024) to present
const RANGES = [
  ['2024-09-09', '2025-09-08'],
  ['2025-09-09', '2026-09-19'],
];

async function main() {
  console.log('Fetching SAP AI SDK (@sap-ai-sdk) telemetry from npm...');

  const packageDailyMap = new Map(); // pkgId -> Map(day -> count)
  const packageSummaries = {};

  for (const pkg of SAP_AI_PACKAGES) {
    console.log(`\nFetching ${pkg.name}...`);
    const dayMap = new Map();
    let totalAllTime = 0;

    for (const [start, end] of RANGES) {
      try {
        const res = await fetchRange(pkg.name, start, end);
        const downloads = res?.downloads || [];
        for (const item of downloads) {
          dayMap.set(item.day, item.downloads);
          totalAllTime += item.downloads;
        }
        console.log(`  ${start} to ${end}: ${downloads.length} days fetched`);
      } catch (err) {
        console.warn(`  ! Range ${start}:${end} failed for ${pkg.name}:`, err.message);
      }
      await pace(250);
    }

    // Also fetch point stats for last-week and last-month
    let weekly = 0;
    let monthly = 0;
    try {
      const ptWeek = await fetchPoint(pkg.name, 'last-week');
      weekly = ptWeek?.downloads || 0;
      await pace(150);
      const ptMonth = await fetchPoint(pkg.name, 'last-month');
      monthly = ptMonth?.downloads || 0;
    } catch (err) {
      console.warn(`  ! Point stats failed for ${pkg.name}:`, err.message);
    }

    packageDailyMap.set(pkg.id, dayMap);
    packageSummaries[pkg.name] = {
      id: pkg.id,
      label: pkg.label,
      weekly,
      monthly,
      allTime: totalAllTime,
    };
    console.log(`  Total: ${totalAllTime.toLocaleString()} all-time | ${weekly.toLocaleString()} last week`);
  }

  // Find sorted list of all unique days
  const allDaysSet = new Set();
  for (const dayMap of packageDailyMap.values()) {
    for (const day of dayMap.keys()) {
      allDaysSet.add(day);
    }
  }
  const allDays = Array.from(allDaysSet).sort();
  console.log(`\nProcessing ${allDays.length} days across ${SAP_AI_PACKAGES.length} packages...`);

  // Build daily series
  const dailySeries = [];
  for (const day of allDays) {
    const pkgCounts = {};
    let dayTotal = 0;
    for (const pkg of SAP_AI_PACKAGES) {
      const count = packageDailyMap.get(pkg.id)?.get(day) || 0;
      pkgCounts[pkg.id] = count;
      dayTotal += count;
    }
    dailySeries.push({
      date: day,
      total: dayTotal,
      packages: pkgCounts,
    });
  }

  // Build weekly rollups (7-day buckets ending on each Friday/end-of-week)
  const weeklySeries = [];
  const chunkSize = 7;
  for (let i = 0; i < dailySeries.length; i += chunkSize) {
    const slice = dailySeries.slice(i, i + chunkSize);
    const endDay = slice[slice.length - 1].date;
    const pkgTotals = {};
    let weekTotal = 0;

    for (const pkg of SAP_AI_PACKAGES) {
      pkgTotals[pkg.id] = slice.reduce((sum, d) => sum + (d.packages[pkg.id] || 0), 0);
      weekTotal += pkgTotals[pkg.id];
    }

    weeklySeries.push({
      weekEnding: endDay,
      daysInBucket: slice.length,
      total: weekTotal,
      packages: pkgTotals,
    });
  }

  // Compute 30d growth velocities (last 30 days vs preceding 30 days)
  const last60 = dailySeries.slice(-60);
  const prev30 = last60.slice(0, 30);
  const cur30 = last60.slice(30);

  const prev30Total = prev30.reduce((s, d) => s + d.total, 0);
  const cur30Total = cur30.reduce((s, d) => s + d.total, 0);
  const overallGrowth30d = prev30Total > 0
    ? Math.round(((cur30Total - prev30Total) / prev30Total) * 1000) / 10
    : 0;

  for (const pkg of SAP_AI_PACKAGES) {
    const pPrev = prev30.reduce((s, d) => s + (d.packages[pkg.id] || 0), 0);
    const pCur = cur30.reduce((s, d) => s + (d.packages[pkg.id] || 0), 0);
    const growth = pPrev > 0 ? Math.round(((pCur - pPrev) / pPrev) * 1000) / 10 : 0;
    if (packageSummaries[pkg.name]) {
      packageSummaries[pkg.name].growth30d = growth;
      packageSummaries[pkg.name].last30dTotal = pCur;
    }
  }

  const allTimeGrandTotal = Object.values(packageSummaries).reduce((s, p) => s + p.allTime, 0);
  const weeklyGrandTotal = Object.values(packageSummaries).reduce((s, p) => s + p.weekly, 0);
  const monthlyGrandTotal = Object.values(packageSummaries).reduce((s, p) => s + p.monthly, 0);

  const orchWeekly = packageSummaries['@sap-ai-sdk/orchestration']?.weekly || 0;
  const lcWeekly = packageSummaries['@sap-ai-sdk/langchain']?.weekly || 0;
  const orchVsLcTotal = orchWeekly + lcWeekly;
  const nativeShare = orchVsLcTotal > 0 ? Math.round((orchWeekly / orchVsLcTotal) * 1000) / 10 : 100;

  const dataset = {
    updatedAt: new Date().toISOString(),
    packages: SAP_AI_PACKAGES,
    summary: {
      allTimeGrandTotal,
      weeklyGrandTotal,
      monthlyGrandTotal,
      growth30d: overallGrowth30d,
      cur30dTotal: cur30Total,
      prev30dTotal: prev30Total,
      nativeOrchestrationShare: nativeShare,
      byPackage: packageSummaries,
    },
    weeklySeries,
    dailySeries,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dataset, null, 2), 'utf8');
  console.log(`\nSuccessfully wrote ${OUTPUT_FILE}`);
  console.log(`Grand Total: ${allTimeGrandTotal.toLocaleString()} downloads across ${dailySeries.length} days (${weeklySeries.length} weeks)`);
  console.log(`Weekly Volume: ${weeklyGrandTotal.toLocaleString()} | 30d Growth: ${overallGrowth30d}%`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
