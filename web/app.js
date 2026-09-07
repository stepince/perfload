// Copyright (c) 2026 Stephen Ince
// Licensed under custom license. See LICENSE file.
// perfload web UI — vanilla JS, no frameworks
const API = '';

function toggleCollapsible(label) {
  label.classList.toggle('open');
}

const _workbenchChannel = new BroadcastChannel('perfload-workbench');
window.addEventListener('beforeunload', () => _workbenchChannel.close());

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;`
    + `background:${isError ? '#7f1d1d' : '#1e3a5f'};color:#fff;`
    + `padding:0.55rem 1rem;border-radius:6px;font-size:0.83rem;`
    + `box-shadow:0 2px 8px rgba(0,0,0,0.4);transition:opacity 0.3s;`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function openWorkbench() {
  window.open('/load-tester.html', 'perfload-workbench');
}

function openWorkbenchWithProject() {
  const name = $('projectName').value.trim();
  if (!name) return;
  const config = {
    name,
    url:                  $('url').value.trim(),
    method:               $('method').value,
    headers:              (() => { try { return JSON.parse($('headers').value); } catch { return {}; } })(),
    body:                 $('body').value.trim() || null,
    users:                parseInt($('users').value, 10) || 10,
    duration:             $('duration').value.trim() || '30s',
    pause:                parseFloat($('pause').value) || 0,
    timeout:              $('timeout').value.trim() || '30s',
    variables:            getVariableDefinitions(),
    responseContentType:  $('responseContentType').value,
    validationExpression: $('validationExpression').value.trim(),
  };

  // Ensure the workbench window exists; if not open it now
  window.open('/load-tester.html', 'perfload-workbench');

  let acked = false;
  const onAck = e => {
    if (e.data?.type === 'workbench-prefill-ack') {
      acked = true;
      _workbenchChannel.removeEventListener('message', onAck);
      showToast('Project sent to Workbench');
    }
  };
  _workbenchChannel.addEventListener('message', onAck);

  const send = () => { if (!acked) _workbenchChannel.postMessage({ type: 'workbench-prefill', payload: config }); };
  send();           // catches already-open tab (BroadcastChannel is ready)
  setTimeout(send, 600); // catches freshly opened tab (needs parse + script exec time)

  // Give up after 4 s and tell the user
  setTimeout(() => {
    _workbenchChannel.removeEventListener('message', onAck);
    if (!acked) showToast('Could not reach Workbench — try clicking Update Project again', true);
  }, 4000);
}

function setCollapsible(fieldId, open) {
  const el = $(fieldId);
  if (!el) return;
  const label = el.closest('.card')?.querySelector('.collapsible-label');
  if (label) label.classList.toggle('open', open);
}

let currentRunId = null;
let currentRunMeta = null; // { id, project, users, duration } for grid rendering during polls
let varCounter = 0;
let pollInterval = null;
let historyPollInterval = null;
let outputMode = 'text';
let lastFinishedData = null;
let outputCollapsed = true;
let k6DashWin = null;
let initialLoadDone = false;
const selectedRunIds = new Set();
const runStatusMap   = new Map(); // runId → status, kept current after each renderHistory

const $ = (id) => document.getElementById(id);

$('runBtn').addEventListener('click', startTest);
$('stopBtn').addEventListener('click', stopTest);
$('refreshBtn').addEventListener('click', loadHistory);

// ─── New run ──────────────────────────────────────────────────────────────────

async function startTest() {
  const url      = $('url').value.trim();
  const name     = $('projectName').value.trim();
  const method   = $('method').value;
  const users    = parseInt($('users').value, 10) || 10;
  const duration = $('duration').value.trim() || '30s';
  const pause    = parseFloat($('pause').value) || 0;
  const timeout  = $('timeout').value.trim() || '30s';

  let headers = {};
  let body    = null;

  try {
    const raw = $('headers').value.trim();
    if (raw) headers = JSON.parse(raw);
  } catch {
    alert('Headers must be valid JSON.');
    return;
  }

  try {
    const raw = $('body').value.trim();
    if (raw) body = JSON.parse(raw);
  } catch {
    alert('Body must be valid JSON.');
    return;
  }

  const responseContentType  = $('responseContentType').value;
  const validationExpression = $('validationExpression').value.trim();

  if (!url) { alert('Please enter a URL.'); return; }

  $('runBtn').disabled = true;
  $('historyDetail').style.display = 'block';
  $('detailOutput').textContent = 'Starting…';
  $('dashboardLink').style.display = 'none';
  $('pdfLink').style.display = 'none';
  lastFinishedData = null;
  renderDetailMetrics([
    ['Project',  name || '—'],
    ['Run ID',   '—'],
    ['Started',  '—'],
    ['Finished', '—'],
    ['VUs',      users],
    ['Duration', duration],
    ['Status',   'starting…'],
  ]);

  try {
    const resp = await fetch(`${API}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, method, headers, body, users, duration, pause, timeout, variables: getVariableDefinitions(), responseContentType, validationExpression }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || resp.statusText);
    }

    const run = await resp.json();
    currentRunId = run.id;
    selectedRunIds.clear();
    selectedRunIds.add(run.id);
    runStatusMap.set(run.id, run.status);
    updateBulkUI();

    currentRunMeta = { id: run.id, project: name, users, duration };
    renderDetailMetrics([
      ['Project',  name || '—'],
      ['Run ID',   run.id],
      ['Started',  '—'],
      ['Finished', '—'],
      ['VUs',      users],
      ['Duration', duration],
      ['Status',   run.status],
    ]);
    $('stopBtn').style.display = 'inline-block';
    showLiveDashboardLink(run.id);

    startPolling();
    loadHistory();
  } catch (err) {
    $('detailOutput').textContent = `Error: ${err.message}`;
    $('runBtn').disabled = false;
  }
}

async function stopTest() {
  if (!currentRunId) return;
  $('stopBtn').disabled = true;
  await fetch(`${API}/runs/${currentRunId}/stop`, { method: 'POST' }).catch(() => {});
}

// ─── Active run polling ───────────────────────────────────────────────────────

function startPolling() {
  pollInterval = setInterval(async () => {
    if (!currentRunId) return;

    try {
      const r = await fetch(`${API}/runs/${currentRunId}/status`);
      const { status, startedAt, finishedAt } = await r.json();

      if (currentRunMeta) {
        renderDetailMetrics([
          ['Project',  currentRunMeta.project || '—'],
          ['Run ID',   currentRunMeta.id],
          ['Started',  startedAt  ? new Date(startedAt).toLocaleTimeString()  : '—'],
          ['Finished', finishedAt ? new Date(finishedAt).toLocaleTimeString() : '—'],
          ['VUs',      currentRunMeta.users],
          ['Duration', currentRunMeta.duration],
          ['Status',   status],
        ]);
      }

      if (['running', 'stopping'].includes(status)) {
        try {
          const mr = await fetch(`${API}/runs/${currentRunId}/metrics`);
          if (mr.ok) {
            const elapsedSec = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : null;
            $('detailOutput').textContent = formatLiveMetrics(await mr.json(), elapsedSec);
          }
        } catch { /* transient */ }

        // Close the live k6 dashboard window once the test duration has elapsed.
        // An open SSE connection prevents k6 from finalising its dashboard export,
        // which blocks handleSummary and prevents summary.json from being written.
        if (k6DashWin && !k6DashWin.closed && startedAt && currentRunMeta?.duration) {
          const durationSec = parseDurationSec(currentRunMeta.duration) || 30;
          const expectedEndMs = new Date(startedAt).getTime() + (durationSec + 10) * 1000;
          if (Date.now() > expectedEndMs) {
            // Navigate to the dashboard URL — this drops the SSE connection so
            // k6 can finalise its export. The server returns a "generating…"
            // waiting page that auto-reloads until dashboard.html is ready.
            k6DashWin.location.href = `/runs/${currentRunId}/dashboard`;
          }
        }
      }

      if (['finished', 'failed', 'stopped'].includes(status)) {
        clearInterval(pollInterval);
        $('runBtn').disabled = false;
        $('stopBtn').style.display = 'none';
        await loadOutput(status);
        loadHistory(); // refresh list once done
      }
    } catch { /* transient — keep polling */ }
  }, 1500);
}

async function loadOutput(status) {
  lastFinishedData = null;
  if (status === 'finished' || status === 'stopped') {
    try {
      const [sr, rr, stdr] = await Promise.all([
        fetch(`${API}/runs/${currentRunId}/summary`),
        fetch(`${API}/runs/${currentRunId}`),
        fetch(`${API}/runs/${currentRunId}/stdout`),
      ]);
      if (sr.ok) {
        const data   = await sr.json();
        const run    = rr.ok   ? await rr.json()   : {};
        const stdout = stdr.ok ? await stdr.text()  : null;
        const elapsedMs = (run.startedAt && run.finishedAt)
          ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
        const dashboardReport = run.dashboardReport || null;
        renderDetailMetrics([
          ['Project',  run.config?.name || '—'],
          ['Run ID',   run.id],
          ['Started',  run.startedAt  ? new Date(run.startedAt).toLocaleTimeString()  : '—'],
          ['Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : '—'],
          ['VUs',      run.config?.users],
          ['Duration', formatConfigDuration(run.config?.duration)],
          ['Status',   run.status || status],
        ]);
        lastFinishedData = { runId: currentRunId, data, elapsedMs, stdout, dashboardReport, hasCert: !!run.hasCert };
        renderOutput();
        return;
      }
    } catch { /* fall through */ }
  }
  try {
    const r = await fetch(`${API}/runs/${currentRunId}/stdout`);
    if (r.ok) { $('detailOutput').textContent = await r.text(); return; }
  } catch { /* fall through */ }
  $('detailOutput').textContent = 'No output available.';
}

// ─── Run history ──────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const r = await fetch(`${API}/runs?limit=50`);
    if (!r.ok) return;
    const runs = await r.json();
    renderHistory(runs);
    updateBulkUI();

    // If there's a run in progress that we don't know about (started externally),
    // populate the form so the dashboard reflects what's running. Skip this
    // while the user is actively comparing 2+ runs — comparing a still-running
    // run is a deliberate choice (see the refresh hook below) and this block
    // would otherwise tear down that view and jump back to the single-run
    // detail every ~5s, since compare mode never sets currentRunId.
    const activeRun = runs.find(r => ['created', 'running'].includes(r.status));
    if (activeRun && activeRun.id !== currentRunId && selectedRunIds.size <= 1) {
      currentRunId = activeRun.id;
      selectedRunIds.clear();
      selectedRunIds.add(activeRun.id);
      updateBulkUI();
      populateForm(activeRun);
      $('historyDetail').style.display = 'block';
      $('compareDetail').style.display = 'none';
      currentRunMeta = { id: activeRun.id, project: activeRun.config?.name, users: activeRun.config?.users, duration: formatConfigDuration(activeRun.config?.duration) };
      renderDetailMetrics([
        ['Project',  activeRun.config?.name || '—'],
        ['Run ID',   activeRun.id],
        ['Started',  '—'],
        ['Finished', '—'],
        ['VUs',      activeRun.config?.users],
        ['Duration', formatConfigDuration(activeRun.config?.duration)],
        ['Status',   activeRun.status],
      ]);
      $('runBtn').disabled = true;
      $('stopBtn').style.display = 'inline-block';
      // Leave blank rather than a placeholder — startPolling() below fills
      // this in with live metrics within its first tick.
      $('detailOutput').textContent = '';
      showLiveDashboardLink(activeRun.id);
      startPolling();
    }

    // If the compare view is currently showing 2+ runs, refresh it on the
    // same 5s cadence as the rest of history — otherwise a still-running
    // run's live metrics would freeze at whatever they were when the
    // comparison was first opened.
    if ($('compareDetail').style.display !== 'none' && selectedRunIds.size > 1) {
      renderCompareDetail([...selectedRunIds]);
    }

    if (!initialLoadDone) {
      initialLoadDone = true;
      const hashId = window.location.hash.slice(1);
      if (hashId && runs.some(r => r.id === hashId)) {
        focusRun(hashId);
        history.replaceState(null, '', window.location.pathname);
      } else if (runs.length === 1 && !currentRunId) {
        focusRun(runs[0].id);
      }
    }
  } catch { /* network error */ }
}

function populateForm(run) {
  const c = run.config || {};
  $('projectName').value = c.name     || '';
  $('url').value         = c.url      || '';
  $('users').value       = c.users    ?? 10;
  $('duration').value    = c.duration || '30s';
  $('pause').value       = c.pause    ?? 1;
  $('timeout').value     = c.timeout  ?? '30s';
  const headersVal = c.headers && Object.keys(c.headers).length
    ? JSON.stringify(c.headers, null, 2) : '';
  const bodyVal = c.body ? JSON.stringify(c.body, null, 2) : '';
  $('headers').value = headersVal;
  $('body').value    = bodyVal;
  setCollapsible('headers', !!headersVal);
  setCollapsible('body',    !!bodyVal);
  $('responseContentType').value = c.responseContentType || '*';
  $('validationExpression').value = c.validationExpression || '';
  onResponseTypeChange();
  setCollapsible('responseContentType', !!(c.responseContentType && c.responseContentType !== '*') || !!c.validationExpression);
  const methodEl = $('method');
  [...methodEl.options].forEach(o => { o.selected = o.value === c.method; });
  $('variables').innerHTML = '';
  varCounter = 0;
  Object.entries(c.variables || {}).forEach(([name, def]) => {
    addVariable(name, (def.values || []).join(', '), def.type);
  });
  setCollapsible('variables', Object.keys(c.variables || {}).length > 0);
}

function renderHistory(runs) {
  const list = $('historyList');

  if (runs.length === 0) {
    list.innerHTML = '<li style="color:#475569; font-size:0.85rem;">No runs yet.</li>';
    return;
  }

  runs.forEach(r => runStatusMap.set(r.id, r.status));

  list.innerHTML = runs.map((run) => {
    const name    = run.config?.name || '';
    const url     = run.config?.url  || '—';
    const vus     = run.config?.users    ?? '?';
    const dur     = formatConfigDuration(run.config?.duration);
    const timeStr = run.startedAt
      ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : formatElapsed(run.createdAt);
    const checked = selectedRunIds.has(run.id) ? 'checked' : '';
    const active  = selectedRunIds.has(run.id) ? 'active'  : '';

    return `
      <li class="run-row ${active}" data-id="${run.id}">
        <input type="checkbox" class="run-checkbox" data-id="${run.id}" ${checked}
               onclick="handleCheckboxChange('${run.id}', this.checked)" />
        <span class="status-badge status-${run.status}">${run.status}</span>
        <div class="run-row-info run-row-label" onclick="focusRun('${run.id}')">
          ${name ? `<div class="run-row-name">${name}</div>` : ''}
          <div class="run-row-url" title="${url}">${url}</div>
        </div>
        <span class="run-row-meta run-row-label" onclick="focusRun('${run.id}')">${vus}vu · ${dur}<br>${timeStr}</span>
        ${['created','running','stopping'].includes(run.status)
          ? `<button title="Stop run" style="background:none; border:none; color:#f59e0b; opacity:0.6; padding:0 0.25rem; cursor:pointer; line-height:1; flex-shrink:0;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6"
                onclick="stopRun('${run.id}')"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="8.3,3 15.7,3 21,8.3 21,15.7 15.7,21 8.3,21 3,15.7 3,8.3"/></svg></button>`
          : `<span style="display:inline-block; width:26px; flex-shrink:0;"></span>`}
        <button title="Delete run" style="background:none; border:none; color:#ef4444; opacity:0.6; padding:0 0.25rem; cursor:pointer; line-height:1; flex-shrink:0;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6"
            onclick="deleteRun('${run.id}')"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </li>`;
  }).join('');
}

function handleCheckboxChange(id, checked) {
  if (checked) selectedRunIds.add(id);
  else          selectedRunIds.delete(id);
  refreshSelectionView();
}

// Shared tail of handleCheckboxChange/selectAll — must run once after all
// selection changes are applied, not per-checkbox, or the intermediate
// size===1 state fires an async selectRun() that later resolves and clobbers
// the compare view once every run is selected.
function refreshSelectionView() {
  document.querySelectorAll('.run-row').forEach(el => {
    el.classList.toggle('active', selectedRunIds.has(el.dataset.id));
  });

  updateBulkUI();

  if (selectedRunIds.size === 0) {
    $('historyDetail').style.display = 'none';
    $('compareDetail').style.display = 'none';
    clearForm();
  } else if (selectedRunIds.size === 1) {
    $('compareDetail').style.display = 'none';
    const singleId = [...selectedRunIds][0];
    loadIntoForm(singleId);
    selectRun(singleId);
  } else {
    $('historyDetail').style.display = 'none';
    clearForm();
    renderCompareDetail([...selectedRunIds]);
  }
}

function clearForm() {
  const updateBtn = $('updateProjectBtn');
  if (updateBtn) updateBtn.disabled = true;
  $('projectName').value = '';
  $('url').value         = '';
  $('users').value       = 10;
  $('duration').value    = '30s';
  $('pause').value       = 1;
  $('timeout').value     = '30s';
  $('headers').value     = '';
  $('body').value        = '';
  $('responseContentType').value = '*';
  $('validationExpression').value = '';
  onResponseTypeChange();
  setCollapsible('headers', false);
  setCollapsible('body', false);
  setCollapsible('responseContentType', false);
  setCollapsible('variables', false);
  $('variables').innerHTML = '';
  varCounter = 0;
  const methodEl = $('method');
  [...methodEl.options].forEach(o => { o.selected = o.value === 'GET'; });
}

function updateBulkUI() {
  const total     = document.querySelectorAll('.run-checkbox').length;
  const checked   = selectedRunIds.size;
  const selectAll = $('selectAllCheckbox');
  const deleteBtn = $('deleteSelectedBtn');
  const stopBtn   = $('stopSelectedBtn');
  const compareBtn = $('comparePdfBtn');

  if (selectAll) {
    selectAll.checked       = total > 0 && checked === total;
    selectAll.indeterminate = checked > 0 && checked < total;
  }
  if (deleteBtn) {
    deleteBtn.style.display = checked > 0 ? 'inline-block' : 'none';
    deleteBtn.textContent   = `Delete Selected (${checked})`;
  }
  if (stopBtn) {
    const activeCount = [...selectedRunIds].filter(id =>
      ['created', 'running', 'stopping'].includes(runStatusMap.get(id))
    ).length;
    stopBtn.style.display = activeCount > 0 ? 'inline-block' : 'none';
    stopBtn.textContent   = `Stop Selected (${activeCount})`;
  }
  if (compareBtn) {
    compareBtn.style.display = checked > 1 ? 'inline-block' : 'none';
    if (checked > 1) $('pdfLink').style.display = 'none';
  }
}

function selectAll(checked) {
  document.querySelectorAll('.run-checkbox').forEach(cb => {
    cb.checked = checked;
    if (checked) selectedRunIds.add(cb.dataset.id);
    else          selectedRunIds.delete(cb.dataset.id);
  });
  refreshSelectionView();
}

async function deleteSelected() {
  const ids = [...selectedRunIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} run${ids.length > 1 ? 's' : ''}?`)) return;

  for (const id of ids) {
    try {
      const sr = await fetch(`${API}/runs/${id}/status`);
      const { status } = sr.ok ? await sr.json() : {};
      const isActive = ['created', 'running', 'stopping'].includes(status);

      if (isActive) {
        await fetch(`${API}/runs/${id}/stop`, { method: 'POST' }).catch(() => {});
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const pr = await fetch(`${API}/runs/${id}/status`);
          const { status: s } = pr.ok ? await pr.json() : {};
          if (['finished', 'failed', 'stopped'].includes(s)) break;
        }
      }
      await fetch(`${API}/runs/${id}`, { method: 'DELETE' });
      selectedRunIds.delete(id);
    } catch { /* skip failed deletes */ }
  }

  currentRunId = null;
  $('historyDetail').style.display = 'none';
  $('compareDetail').style.display = 'none';
  await loadHistory();
}

async function stopSelected() {
  const activeIds = [...selectedRunIds].filter(id =>
    ['created', 'running', 'stopping'].includes(runStatusMap.get(id))
  );
  if (activeIds.length === 0) return;
  if (!confirm(`Stop ${activeIds.length} running test${activeIds.length > 1 ? 's' : ''}?`)) return;

  await Promise.all(activeIds.map(id =>
    fetch(`${API}/runs/${id}/stop`, { method: 'POST' }).catch(() => {})
  ));
  await loadHistory();
}

let _loadIntoFormId = null;

function loadIntoForm(id) {
  _loadIntoFormId = id;
  fetch(`${API}/runs/${id}`)
    .then(r => r.json())
    .then(data => {
      if (_loadIntoFormId !== id) return;
      const c = data.config || {};
      $('projectName').value = c.name     || '';
      $('url').value         = c.url      || '';
      $('users').value    = c.users    ?? 10;
      $('duration').value = c.duration || '30s';
      $('pause').value    = c.pause    ?? 1;
      $('timeout').value  = c.timeout  ?? '30s';
      const headersVal = Object.keys(c.headers || {}).length ? JSON.stringify(c.headers, null, 2) : '';
      const bodyVal    = c.body ? JSON.stringify(c.body, null, 2) : '';
      $('headers').value = headersVal;
      $('body').value    = bodyVal;
      setCollapsible('headers', !!headersVal);
      setCollapsible('body',    !!bodyVal);
      $('responseContentType').value  = c.responseContentType || '*';
      $('validationExpression').value = c.validationExpression || '';
      onResponseTypeChange();
      setCollapsible('responseContentType', !!(c.responseContentType && c.responseContentType !== '*') || !!c.validationExpression);

      // Restore variables
      $('variables').innerHTML = '';
      varCounter = 0;
      Object.entries(c.variables || {}).forEach(([name, def]) => {
        addVariable(name, (def.values || []).join(', '), def.type);
      });
      setCollapsible('variables', Object.keys(c.variables || {}).length > 0);

      // Select the matching method option
      const methodEl = $('method');
      [...methodEl.options].forEach(o => { o.selected = o.value === c.method; });

      // Re-expand textareas after programmatic fill
      document.querySelectorAll('textarea').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });

      // Scroll form into view
      $('url').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('url').focus();
    })
    .catch(() => {});
}

function focusRun(id) {
  // Clear all selections and show only this run's detail
  selectedRunIds.clear();
  selectedRunIds.add(id);
  document.querySelectorAll('.run-checkbox').forEach(cb => {
    cb.checked = cb.dataset.id === id;
  });
  document.querySelectorAll('.run-row').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  $('compareDetail').style.display = 'none';
  updateBulkUI();
  loadIntoForm(id);
  selectRun(id);
}

async function selectRun(id) {
  $('compareDetail').style.display = 'none';
  $('historyDetail').style.display = 'block';
  $('detailOutput').textContent = 'Loading…';
  $('detailMetrics').innerHTML = '';

  // Fetch run metadata + output. Summary/stdout are speculatively fetched in
  // parallel with the run itself (they 404 cheaply if the run isn't terminal
  // yet) instead of waiting on a separate /status round-trip first — that
  // extra sequential hop was what delayed the PDF button from appearing.
  const terminal = ['finished', 'stopped'];
  try {
    const [runR, summaryR, stdoutR] = await Promise.all([
      fetch(`${API}/runs/${id}`),
      fetch(`${API}/runs/${id}/summary`),
      fetch(`${API}/runs/${id}/stdout`),
    ]);
    const run = runR.ok ? await runR.json() : {};
    $('projectName').value = run.config?.name || '';
    const updateBtn = $('updateProjectBtn');
    if (updateBtn) updateBtn.disabled = !run.config?.name;
    renderDetailMetrics([
      ['Project',  run.config?.name || '—'],
      ['Run ID',   run.id],
      ['Started',  run.startedAt  ? new Date(run.startedAt).toLocaleTimeString()  : '—'],
      ['Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : '—'],
      ['VUs',      run.config?.users],
      ['Duration', formatConfigDuration(run.config?.duration)],
      ['Status',   run.status],
    ]);

    if (terminal.includes(run.status) && summaryR.ok) {
      const data        = await summaryR.json();
      const stdout      = stdoutR.ok ? await stdoutR.text() : null;
      const elapsedMs   = (run.startedAt && run.finishedAt)
        ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
      const dashboardReport = run.dashboardReport || null;
      lastFinishedData  = { runId: id, data, elapsedMs, stdout, dashboardReport, hasCert: !!run.hasCert };
      renderOutput();
      return;
    }

    if (['running', 'created', 'stopping'].includes(run.status)) {
      // Summary isn't ready yet — leave the panel blank rather than dumping
      // raw stdout (k6's startup banner/live progress text), which reads as
      // a confusing, self-correcting flash right after a run starts.
      // startPolling() takes over and renders the properly formatted report
      // (live metrics, then the final summary) once there's real data.
      $('detailOutput').textContent = '';
    } else {
      // Terminal but no summary (e.g. failed) — raw stdout is the only
      // diagnostic info available, so show it.
      $('detailOutput').textContent = stdoutR.ok ? await stdoutR.text() : 'No output yet.';
    }
  } catch {
    $('detailOutput').textContent = 'Failed to load output.';
  }
}

function renderDetailMetrics(pairs, append = false) {
  const grid = $('detailMetrics');
  if (!append) grid.innerHTML = '';
  pairs.forEach(([label, value]) => {
    const box = document.createElement('div');
    box.className = 'metric-box';
    box.innerHTML = `<div class="metric-label">${label}</div><div class="metric-value">${value ?? '—'}</div>`;
    grid.appendChild(box);
  });
}

function summaryMetrics(data, elapsedMs = null) {
  const m    = data.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values || {};
  const errs = m.http_req_failed?.values || {};
  const elapsed = elapsedMs != null
    ? (elapsedMs < 60000
        ? `${(elapsedMs / 1000).toFixed(1)} s`
        : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`)
    : null;
  return [
    ...(elapsed                  ? [['Elapsed',    elapsed]]                                       : []),
    ...(reqs.count   != null     ? [['Requests',   reqs.count]]                                   : []),
    ...(reqs.rate    != null     ? [['Req/s',       reqs.rate.toFixed(1)]]                        : []),
    ...(http.avg     != null     ? [['Avg Latency', `${http.avg.toFixed(0)} ms`]]                 : []),
    ...(http['p(95)'] != null    ? [['p95 Latency', `${http['p(95)'].toFixed(0)} ms`]]            : []),
    ...(http['p(99)'] != null    ? [['p99 Latency', `${http['p(99)'].toFixed(0)} ms`]]            : []),
    ...(http.max      != null    ? [['Max Latency', `${http.max.toFixed(0)} ms`]]                 : []),
    ...(errs.rate    != null     ? [['Error Rate',  `${(errs.rate * 100).toFixed(2)} %`]]         : []),
  ];
}

// Parse a k6 duration string ("30s", "5m", "1h30m", "300s") into total seconds
function parseDurationSec(str) {
  if (!str) return null;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    const v = parseFloat(match[1]);
    if (match[2] === 'h')  total += v * 3600;
    else if (match[2] === 'm')  total += v * 60;
    else if (match[2] === 's')  total += v;
    else if (match[2] === 'ms') total += v / 1000;
  }
  return total || null;
}

function formatConfigDuration(str) {
  const sec = parseDurationSec(str);
  if (sec == null) return str || '—';
  if (sec < 60) return `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s.toFixed(0)}s`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function onResponseTypeChange() {
  const type    = $('responseContentType').value;
  const wrapper = $('validationWrapper');
  const label   = $('validationLabel');
  const input   = $('validationExpression');
  const config = {
    json: { label: 'JSONPath expression (e.g. $.data.id)', placeholder: '$.status' },
    xml:  { label: 'XPath expression (e.g. //item/name)', placeholder: '//status' },
    text: { label: 'Regex pattern (e.g. success)',         placeholder: 'success' },
  };
  if (type === '*' || !config[type]) {
    wrapper.style.display = 'none';
    input.value = '';
  } else {
    wrapper.style.display = 'block';
    label.textContent    = config[type].label;
    input.placeholder    = config[type].placeholder;
  }
}

// ─── Variables ───────────────────────────────────────────────────────────────

function addVariable(name = '', values = '', type = 'constant') {
  const idx = ++varCounter;
  const div = document.createElement('div');
  div.className = 'variable-row';
  div.innerHTML = `
    <input id="varName_${idx}" placeholder="Name" value="${name}" style="flex:1;" />
    <input id="varValue_${idx}" class="variable-value" placeholder="Values (comma or newline)" value="${values}" style="flex:2;" />
    <select id="varType_${idx}" class="variable-type" style="width:110px;">
      <option value="constant"${type==='constant'?' selected':''}>Constant</option>
      <option value="sequential"${type==='sequential'?' selected':''}>Sequential</option>
      <option value="random"${type==='random'?' selected':''}>Random</option>
    </select>
    <button onclick="this.closest('.variable-row').remove()" title="Remove variable"
      style="background:none; border:none; color:#ef4444; opacity:0.6; padding:0 0.25rem; cursor:pointer; line-height:1; flex-shrink:0; align-self:flex-end;"
      onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
    </button>
  `;
  $('variables').appendChild(div);
}

function getVariableDefinitions() {
  const vars = {};
  document.querySelectorAll('.variable-row').forEach(row => {
    const name   = row.querySelector('[id^="varName_"]')?.value.trim();
    const values = row.querySelector('.variable-value')?.value
      .split(/[\n,]/).map(v => v.trim()).filter(Boolean);
    const type   = row.querySelector('.variable-type')?.value || 'constant';
    if (name && values?.length) vars[name] = { type, values };
  });
  return vars;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatReport(data, elapsedMs = null) {
  const m    = data.metrics || {};
  const http = m.http_req_duration?.values || {};
  const reqs = m.http_reqs?.values || {};
  const errs = m.http_req_failed?.values || {};

  const lines = [];
  if (elapsedMs != null) {
    const elapsed = elapsedMs < 60000
      ? `${(elapsedMs / 1000).toFixed(1)} s`
      : `${Math.floor(elapsedMs / 60000)}m ${((elapsedMs % 60000) / 1000).toFixed(0)}s`;
    lines.push(`Elapsed        : ${elapsed}`);
  }
  if (reqs.count    != null) lines.push(`Total requests : ${reqs.count}`);
  if (reqs.rate     != null) lines.push(`Req/s          : ${reqs.rate.toFixed(2)}`);
  if (http.avg      != null) lines.push(`Latency avg    : ${http.avg.toFixed(2)} ms`);
  if (http['p(95)'] != null) lines.push(`Latency p95    : ${http['p(95)'].toFixed(2)} ms`);
  if (http['p(99)'] != null) lines.push(`Latency p99    : ${http['p(99)'].toFixed(2)} ms`);
  if (http.max      != null) lines.push(`Latency max    : ${http.max.toFixed(2)} ms`);
  if (errs.rate     != null) lines.push(`Error rate     : ${(errs.rate * 100).toFixed(2)} %`);

  return lines.join('\n');
}


function showLiveDashboardLink(runId) {
  const link = $('dashboardLink');
  link.dataset.url = `/runs/${runId}/dashboard/live/`;
  link.style.display = 'inline';
}

function openK6Dashboard(url) {
  k6DashWin = window.open(url, 'perfload-k6-dashboard');
}


function setOutputMode(mode) {
  outputMode = mode;
  $('modeTextBtn').style.background = mode === 'text' ? '#3b82f6' : '#475569';
  $('modeJsonBtn').style.background = mode === 'json' ? '#3b82f6' : '#475569';
  if (mode === 'text') {
    $('outputToggleBtn').textContent = outputCollapsed ? '▼' : '▲';
  }
  if (lastFinishedData) renderOutput();
}

function toggleOutput() {
  if (outputMode === 'json') return;
  outputCollapsed = !outputCollapsed;
  $('outputToggleBtn').textContent = outputCollapsed ? '▼' : '▲';
  renderOutput();
}

function renderOutput() {
  if (!lastFinishedData) return;
  const { data, elapsedMs, stdout, dashboardReport } = lastFinishedData;
  const isJson = outputMode === 'json';

  // Collapse toggle is disabled in JSON mode
  $('outputToggleBtn').disabled = isJson;
  $('outputToggleBtn').style.opacity = isJson ? '0.3' : '1';
  $('outputToggleBtn').style.cursor  = isJson ? 'not-allowed' : 'pointer';

  if (isJson) {
    $('detailOutput').textContent = JSON.stringify(data, null, 2);
  } else if (outputCollapsed) {
    $('detailOutput').textContent = formatReport(data, elapsedMs);
  } else {
    $('detailOutput').textContent =
      formatReport(data, elapsedMs) + '\n\n--- full summary (TEXT) ---\n' + (stdout || 'No text output available.');
  }
  const link = $('dashboardLink');
  if (dashboardReport) {
    link.dataset.url = dashboardReport;
    link.style.display = 'inline';
    if (k6DashWin && !k6DashWin.closed) k6DashWin.location.href = dashboardReport;
  } else {
    link.style.display = 'none';
  }

  const certLink = $('certLink');
  const keyLink  = $('keyLink');
  if (lastFinishedData?.hasCert && lastFinishedData?.runId) {
    certLink.href = `/runs/${lastFinishedData.runId}/client.crt`;
    keyLink.href  = `/runs/${lastFinishedData.runId}/client.key`;
    certLink.style.display = 'inline';
    keyLink.style.display  = 'inline';
  } else {
    certLink.style.display = 'none';
    keyLink.style.display  = 'none';
  }

  const pdfLink = $('pdfLink');
  if (lastFinishedData?.runId) {
    pdfLink.style.display = 'inline-block';
    pdfLink.onclick = (e) => {
      e.preventDefault();
      if (pdfLink.dataset.loading) return;
      pdfLink.dataset.loading = '1';
      pdfLink.style.opacity = '0.5';
      pdfLink.style.pointerEvents = 'none';
      let dotCount = 0;
      const dotTimer = setInterval(() => {
        dotCount = (dotCount % 5) + 1;
        pdfLink.innerHTML = 'Generating PDF <span style="font-size:0.25em;letter-spacing:2px">' + '●'.repeat(dotCount) + '</span>';
      }, 400);
      fetch(`/runs/${lastFinishedData.runId}/report.pdf`)
        .then(r => r.ok ? r.blob() : Promise.reject())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `perfload-${lastFinishedData.runId}.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        })
        .catch(() => {})
        .finally(() => {
          clearInterval(dotTimer);
          delete pdfLink.dataset.loading;
          pdfLink.innerHTML = 'Download PDF ↓';
          pdfLink.style.opacity = '';
          pdfLink.style.pointerEvents = '';
        });
    };
  } else {
    pdfLink.style.display = 'none';
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  return Promise.resolve();
}

function copyReport(btn) {
  const text = $('detailOutput').textContent;
  if (!text) return;
  copyToClipboard(text).then(() => {
    const origBg = btn.style.background;
    btn.style.background = "url('data:image/svg+xml;charset=utf-8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2215%22><path fill=%22%2300aa00%22 d=%22M13.5 2l-7.5 7.5-3.5-3.5L1 7.5 6 12.5 15 3.5z%22/></svg>') 50% no-repeat";
    setTimeout(() => { btn.style.background = origBg; }, 1500);
  });
}

function formatElapsed(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ─── Live progress parser ─────────────────────────────────────────────────────

function formatLiveMetrics(m, elapsedSec) {
  const elapsed = elapsedSec != null
    ? (elapsedSec < 60
        ? `${elapsedSec.toFixed(1)}s`
        : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toFixed(0)}s`)
    : '—';
  const rps     = (m.requests && elapsedSec > 0) ? (m.requests / elapsedSec).toFixed(2) : '—';
  return [
    `Elapsed        : ${elapsed}`,
    `Total requests : ${m.requests ?? '—'}`,
    `Req/s          : ${rps}`,
    `Latency avg    : ${m.avg  != null ? m.avg  + ' ms' : '—'}`,
    `Latency p95    : ${m.p95  != null ? m.p95  + ' ms' : '—'}`,
    `Latency p99    : ${m.p99  != null ? m.p99  + ' ms' : '—'}`,
    `Latency max    : ${m.max  != null ? m.max  + ' ms' : '—'}`,
    `Error rate     : ${m.errorRate != null ? m.errorRate + ' %' : '—'}`,
  ].join('\n');
}

// ─── Comparison PDF ──────────────────────────────────────────────────────────

async function downloadComparisonPdf() {
  const btn = $('comparePdfBtn');
  const originalText = btn.textContent;
  btn.textContent = 'Generating…';
  btn.style.pointerEvents = 'none';

  try {
    const ids = [...selectedRunIds];
    const resp = await fetch(`${API}/runs/compare/report.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!resp.ok) {
      const { error } = await resp.json().catch(() => ({}));
      alert(`PDF generation failed: ${error || resp.statusText}`);
      return;
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'perfload-comparison.pdf' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`PDF generation failed: ${err.message}`);
  } finally {
    btn.textContent = originalText;
    btn.style.pointerEvents = '';
  }
}

// ─── Comparison view ─────────────────────────────────────────────────────────

async function renderCompareDetail(ids) {
  $('compareDetail').style.display = 'block';
  $('compareGrid').innerHTML = '<span style="color:#475569; font-size:0.85rem;">Loading…</span>';

  const results = await Promise.all(ids.map(async id => {
    try {
      const [runR, statusR] = await Promise.all([
        fetch(`${API}/runs/${id}`),
        fetch(`${API}/runs/${id}/status`),
      ]);
      const run    = runR.ok    ? await runR.json()    : {};
      const { status } = statusR.ok ? await statusR.json() : {};
      let summaryData = null, elapsedMs = null, liveMetrics = null;
      if (['finished', 'stopped'].includes(status)) {
        const sr = await fetch(`${API}/runs/${id}/summary`);
        if (sr.ok) {
          summaryData = await sr.json();
          elapsedMs = (run.startedAt && run.finishedAt)
            ? new Date(run.finishedAt) - new Date(run.startedAt) : null;
        }
      } else if (['created', 'running', 'stopping'].includes(status)) {
        // No summary yet — pull the same live-metrics snapshot the single-run
        // view uses, so a run in progress shows more than just "Started".
        const mr = await fetch(`${API}/runs/${id}/metrics`);
        if (mr.ok) {
          liveMetrics = await mr.json();
          elapsedMs = run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null;
        }
      }
      return { id, run, status, summaryData, elapsedMs, liveMetrics };
    } catch {
      return { id, run: {}, status: 'error', summaryData: null, elapsedMs: null, liveMetrics: null };
    }
  }));

  $('compareGrid').innerHTML = results.map(renderCompareCard).join('');
}

function renderCompareCard({ id, run, status, summaryData, elapsedMs, liveMetrics }) {
  const name   = run.config?.name     || '';
  const url    = run.config?.url      || '—';
  const vus    = run.config?.users    ?? '?';
  const dur    = run.config?.duration ?? '?';
  const method = run.config?.method   || '';
  const timeStr = run.startedAt
    ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  const box = (label, value) =>
    `<div class="metric-box"><div class="metric-label">${label}</div><div class="metric-value">${value ?? '—'}</div></div>`;

  let metricPairs;
  if (summaryData) {
    metricPairs = [['Started', timeStr], ...summaryMetrics(summaryData, elapsedMs)];
  } else if (liveMetrics) {
    const elapsedSec = elapsedMs != null ? elapsedMs / 1000 : null;
    const elapsed = elapsedSec != null
      ? (elapsedSec < 60
          ? `${elapsedSec.toFixed(1)} s`
          : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toFixed(0)}s`)
      : null;
    const rps = (liveMetrics.requests && elapsedSec > 0) ? (liveMetrics.requests / elapsedSec).toFixed(2) : null;
    metricPairs = [
      ['Started',    timeStr],
      ...(elapsed                     ? [['Elapsed',    elapsed]]                          : []),
      ...(liveMetrics.requests != null ? [['Requests',   liveMetrics.requests]]            : []),
      ...(rps != null                  ? [['Req/s',      rps]]                             : []),
      ...(liveMetrics.avg      != null ? [['Avg Latency', `${liveMetrics.avg} ms`]]        : []),
      ...(liveMetrics.p95      != null ? [['p95 Latency', `${liveMetrics.p95} ms`]]        : []),
      ...(liveMetrics.p99      != null ? [['p99 Latency', `${liveMetrics.p99} ms`]]        : []),
      ...(liveMetrics.max      != null ? [['Max Latency', `${liveMetrics.max} ms`]]        : []),
      ...(liveMetrics.errorRate != null ? [['Error Rate', `${liveMetrics.errorRate} %`]]   : []),
    ];
  } else {
    metricPairs = [['Started', timeStr]];
  }

  const metricsHtml = `<div class="metric-grid" style="margin-top:0.65rem;">${metricPairs.map(([l, v]) => box(l, v)).join('')}</div>`;

  return `
    <div class="compare-card">
      ${name ? `<div class="compare-card-name">${name}</div>` : ''}
      <div class="compare-card-url" title="${url}">${url}</div>
      <div style="display:flex; align-items:center; justify-content:space-between; margin-top:0.35rem;">
        <span class="compare-card-meta">${method} · ${vus}vu · ${dur}</span>
        <span class="status-badge status-${status}">${status}</span>
      </div>
      ${metricsHtml}
    </div>`;
}

async function stopRun(id) {
  await fetch(`${API}/runs/${id}/stop`, { method: 'POST' }).catch(() => {});
  loadHistory();
}

async function deleteRun(id) {
  try {
    // Check current status
    const sr = await fetch(`${API}/runs/${id}/status`);
    const { status } = sr.ok ? await sr.json() : {};
    const isActive = ['created', 'running', 'stopping'].includes(status);

    if (!confirm(isActive ? 'Stop and delete this run?' : 'Delete this run?')) return;

    // Stop first if active, then wait until terminal
    if (isActive) {
      await fetch(`${API}/runs/${id}/stop`, { method: 'POST' }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const pr = await fetch(`${API}/runs/${id}/status`);
        const { status: s } = pr.ok ? await pr.json() : {};
        if (['finished', 'failed', 'stopped'].includes(s)) break;
      }
    }

    const r = await fetch(`${API}/runs/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || 'Failed to delete run');
      return;
    }
    selectedRunIds.delete(id);
    if (currentRunId === id) currentRunId = null;

    // Remove the compare card immediately without waiting for re-fetch
    const card = $('compareGrid')?.querySelector(`[data-id="${id}"]`);
    if (card) card.remove();

    if (selectedRunIds.size === 0) {
      $('historyDetail').style.display = 'none';
      $('compareDetail').style.display = 'none';
    } else if (selectedRunIds.size === 1) {
      $('compareDetail').style.display = 'none';
      selectRun([...selectedRunIds][0]);
    } else {
      $('compareDetail').style.display = 'block';
    }
    await loadHistory();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

$('projectName').value = '';
loadHistory();
// Refresh history every 5s to catch runs started via CLI or API
historyPollInterval = setInterval(loadHistory, 5000);

// When the workbench opens the dashboard with /#runId in an already-open window,
// the browser updates the hash without a full reload — handle that here.
window.addEventListener('hashchange', () => {
  const hashId = window.location.hash.slice(1);
  if (hashId) {
    focusRun(hashId);
    history.replaceState(null, '', window.location.pathname);
  }
});