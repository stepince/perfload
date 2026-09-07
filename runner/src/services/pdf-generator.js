import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { access } from 'fs/promises';
import path from 'path';

/**
 * Generates a side-by-side comparison PDF for multiple completed runs.
 * @param {Array<{run: object, summaryData: object|null}>} runsData
 */
export async function buildComparisonPdf(runsData) {
  const fmt = (v, suffix = '') => v != null ? `${Number(v).toFixed(2)}${suffix}` : '—';

  const rows = runsData.map(({ run, summaryData }) => {
    const m    = summaryData?.metrics || {};
    const http = m.http_req_duration?.values || {};
    const reqs = m.http_reqs?.values        || {};
    const errs = m.http_req_failed?.values  || {};

    const elapsedMs = (run.startedAt && run.finishedAt)
      ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
    const elapsed = elapsedMs != null
      ? (elapsedMs < 60000
          ? `${(elapsedMs / 1000).toFixed(1)} s`
          : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`)
      : '—';

    return {
      name:     run.config?.name     || '',
      url:      run.config?.url      || '—',
      method:   run.config?.method   || '—',
      users:    run.config?.users    ?? '—',
      duration: run.config?.duration ?? '—',
      started:  run.startedAt ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
      elapsed,
      requests: reqs.count ?? '—',
      rps:      fmt(reqs.rate),
      avg:      fmt(http.avg,        ' ms'),
      p95:      fmt(http['p(95)'],   ' ms'),
      p99:      fmt(http['p(99)'],   ' ms'),
      max:      fmt(http.max,        ' ms'),
      errors:   errs.rate != null ? `${(errs.rate * 100).toFixed(2)} %` : '—',
    };
  });

  const tableRows = rows.map((r, i) => `
    <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td class="label-col">${r.name || `Run ${i + 1}`}</td>
      <td class="url-col" title="${r.url}">${r.url}</td>
      <td>${r.method}</td>
      <td>${r.users}</td>
      <td>${r.duration}</td>
      <td>${r.started}</td>
      <td>${r.elapsed}</td>
      <td>${r.requests}</td>
      <td>${r.rps}</td>
      <td>${r.avg}</td>
      <td>${r.p95}</td>
      <td>${r.p99}</td>
      <td>${r.max}</td>
      <td>${r.errors}</td>
    </tr>`).join('');

  // ── Inline SVG latency bar chart ─────────────────────────────────────────
  const chartData = rows.map((r, i) => ({
    label: (r.name || `Run ${i + 1}`).slice(0, 18),
    avg:   parseFloat(r.avg) || 0,
    p95:   parseFloat(r.p95) || 0,
    p99:   parseFloat(r.p99) || 0,
  }));

  const W = 960, H = 260;
  const PAD = { top: 24, right: 24, bottom: 56, left: 64 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;

  const maxVal = Math.max(...chartData.flatMap(d => [d.avg, d.p95, d.p99]), 1) * 1.15;
  const yScale = v => cH - (v / maxVal) * cH;

  const groupW  = cW / chartData.length;
  const barW    = Math.max(8, (groupW - 16) / 3);
  const barGap  = (groupW - barW * 3) / 4;

  const bars = chartData.map((d, gi) => {
    const gx = gi * groupW;
    const bAvg = `<rect x="${gx + barGap}"             y="${yScale(d.avg)}" width="${barW}" height="${(d.avg / maxVal) * cH}" fill="#38bdf8" rx="2"/>`;
    const bP95 = `<rect x="${gx + barGap * 2 + barW}"  y="${yScale(d.p95)}" width="${barW}" height="${(d.p95 / maxVal) * cH}" fill="#818cf8" rx="2"/>`;
    const bP99 = `<rect x="${gx + barGap * 3 + barW * 2}" y="${yScale(d.p99)}" width="${barW}" height="${(d.p99 / maxVal) * cH}" fill="#c084fc" rx="2"/>`;
    const lx   = gx + groupW / 2;
    const lbl  = `<text x="${lx}" y="${cH + 18}" text-anchor="middle" font-size="10" fill="#64748b">${d.label}</text>`;
    return bAvg + bP95 + bP99 + lbl;
  }).join('');

  // Y-axis ticks
  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const val  = (maxVal / tickCount) * i;
    const y    = yScale(val);
    const fmtV = val >= 1000 ? `${(val / 1000).toFixed(1)}s` : `${Math.round(val)}ms`;
    return `<line x1="0" y1="${y}" x2="${cW}" y2="${y}" stroke="#1e293b" stroke-width="1"/>
            <text x="-8" y="${y + 4}" text-anchor="end" font-size="10" fill="#475569">${fmtV}</text>`;
  }).join('');

  const legend = `
    <rect x="0"  y="0" width="12" height="12" fill="#38bdf8" rx="2"/> <text x="16" y="10" font-size="11" fill="#94a3b8">Avg</text>
    <rect x="52" y="0" width="12" height="12" fill="#818cf8" rx="2"/> <text x="68" y="10" font-size="11" fill="#94a3b8">p95</text>
    <rect x="104" y="0" width="12" height="12" fill="#c084fc" rx="2"/> <text x="120" y="10" font-size="11" fill="#94a3b8">p99</text>`;

  const chartSvg = `
  <svg width="${W}" height="${H + 20}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(${PAD.left},${PAD.top})">
      ${yTicks}
      ${bars}
    </g>
    <g transform="translate(${PAD.left}, ${H + 4})">${legend}</g>
  </svg>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    padding: 48px;
  }
  .header { margin-bottom: 40px; }
  .header h1 { font-size: 30px; color: #7dd3fc; margin-bottom: 8px; }
  .header .meta { font-size: 13px; color: #475569; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    background: #1e2330;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid #334155;
    white-space: nowrap;
  }
  td { padding: 10px 12px; vertical-align: top; }
  tr.even td { background: #1a1f2e; }
  tr.odd  td { background: #141822; }
  .label-col { color: #7dd3fc; font-weight: 600; white-space: nowrap; }
  .url-col {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #94a3b8;
    font-family: monospace;
    font-size: 11px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>PerfLoad &nbsp;/&nbsp; Comparison Report</h1>
    <div class="meta">Generated: ${new Date().toLocaleString()} &nbsp;·&nbsp; ${rows.length} runs</div>
  </div>

  <div style="margin-bottom:36px;">
    <div style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:12px;">Latency (ms)</div>
    ${chartSvg}
  </div>

  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>URL</th>
        <th>Method</th>
        <th>VUs</th>
        <th>Duration</th>
        <th>Started</th>
        <th>Elapsed</th>
        <th>Requests</th>
        <th>Req/s</th>
        <th>Avg</th>
        <th>p95</th>
        <th>p99</th>
        <th>Max</th>
        <th>Errors</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBytes = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
  }
}

/**
 * Generates a PDF report for a completed run.
 * Page 1: styled metrics summary.
 * Page 2+: k6 dashboard (if dashboard.html exists for the run).
 *
 * Streams the final PDF directly into the Express response.
 *
 * @param {object} run         - run record from run-store (includes dir, config, startedAt, finishedAt)
 * @param {object} summaryData - parsed summary.json from k6
 * @param {object} res         - Express response (headers must not yet be sent)
 */
export async function buildRunPdf(run, summaryData) {
  const m    = summaryData.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values        || {};
  const errs = m.http_req_failed?.values  || {};

  const elapsedMs = (run.startedAt && run.finishedAt)
    ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
  const elapsed = elapsedMs != null
    ? (elapsedMs < 60000
        ? `${(elapsedMs / 1000).toFixed(1)} s`
        : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`)
    : '—';

  const fmt = (v, suffix = '') => v != null ? `${Number(v).toFixed(2)}${suffix}` : '—';
  const metrics = [
    ['Elapsed',        elapsed],
    ['Total requests', reqs.count ?? '—'],
    ['Req/s',          fmt(reqs.rate)],
    ['Latency avg',    fmt(http.avg,        ' ms')],
    ['Latency p95',    fmt(http['p(95)'],   ' ms')],
    ['Latency p99',    fmt(http['p(99)'],   ' ms')],
    ['Latency max',    fmt(http.max,        ' ms')],
    ['Error rate',     errs.rate != null ? `${(errs.rate * 100).toFixed(2)} %` : '—'],
  ];

  const metricsRows = metrics.map(([label, value]) => `
    <tr>
      <td>${label}</td>
      <td>${value}</td>
    </tr>`).join('');

  const startedStr  = run.startedAt  ? new Date(run.startedAt).toLocaleString()  : '—';
  const finishedStr = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—';

  const summaryHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    padding: 64px;
    min-height: 100vh;
  }
  .header { margin-bottom: 48px; }
  .header h1 { font-size: 36px; color: #7dd3fc; margin-bottom: 10px; }
  .header .run-id { font-size: 15px; color: #475569; font-family: monospace; margin-bottom: 6px; }
  .header .generated { font-size: 15px; color: #475569; }

  .section { margin-bottom: 40px; }
  .section h2 { font-size: 18px; color: #64748b; text-transform: uppercase;
                letter-spacing: 0.08em; margin-bottom: 16px; }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 12px 16px; font-size: 20px; }
  td:first-child { color: #94a3b8; width: 220px; }
  td:last-child  { color: #e2e8f0; font-family: monospace; font-weight: 600; }
  tr:nth-child(odd)  { background: #1e2330; }
  tr:nth-child(even) { background: #161b27; }

  .config-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 0;
  }
  .config-box {
    background: #1e2330;
    border-radius: 6px;
    padding: 16px 20px;
  }
  .config-label { font-size: 14px; color: #64748b; text-transform: uppercase;
                  letter-spacing: 0.06em; margin-bottom: 6px; }
  .config-value { font-size: 18px; color: #e2e8f0; font-family: monospace;
                  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
  <div class="header">
    <h1>PerfLoad &nbsp;/&nbsp; Load Test Report</h1>
    <div class="run-id">Run ID: ${run.id}</div>
    <div class="generated">Generated: ${new Date().toLocaleString()}</div>
  </div>

  <div class="section">
    <h2>Test Configuration</h2>
    <div class="config-grid">
      <div class="config-box">
        <div class="config-label">URL</div>
        <div class="config-value" title="${run.config.url}">${run.config.url}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Method</div>
        <div class="config-value">${run.config.method}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Virtual Users</div>
        <div class="config-value">${run.config.users}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Duration</div>
        <div class="config-value">${run.config.duration}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Started</div>
        <div class="config-value">${startedStr}</div>
      </div>
      <div class="config-box">
        <div class="config-label">Finished</div>
        <div class="config-value">${finishedStr}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Performance Metrics</h2>
    <table>
      <tbody>${metricsRows}</tbody>
    </table>
  </div>
</body>
</html>`;

  const dashboardPath = path.join(run.dir, 'dashboard.html');
  const hasDashboard = run.dashboard && await access(dashboardPath).then(() => true).catch(() => false);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let finalBytes;

  try {
    const page = await browser.newPage();

    // Render metrics summary page
    await page.setContent(summaryHtml, { waitUntil: 'networkidle0' });
    const summaryPdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    if (!hasDashboard) {
      finalBytes = Buffer.from(summaryPdfBytes);
    } else {
      // Render k6 dashboard — use 'load' since the HTML is self-contained
      await page.goto(`file://${dashboardPath}`, { waitUntil: 'load', timeout: 20000 });
      // Brief pause for chart rendering to settle
      await new Promise(r => setTimeout(r, 1500));
      const dashboardPdfBytes = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      });

      // Merge the two PDFs
      const merged       = await PDFDocument.create();
      const summaryDoc   = await PDFDocument.load(summaryPdfBytes);
      const dashboardDoc = await PDFDocument.load(dashboardPdfBytes);

      const summaryPages   = await merged.copyPages(summaryDoc,   summaryDoc.getPageIndices());
      const dashboardPages = await merged.copyPages(dashboardDoc, dashboardDoc.getPageIndices());

      summaryPages.forEach(p   => merged.addPage(p));
      dashboardPages.forEach(p => merged.addPage(p));

      finalBytes = Buffer.from(await merged.save());
    }
  } finally {
    await browser.close();
  }

  return finalBytes;
}
