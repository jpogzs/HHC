/**
 * ============================================================
 * POGI SCRIPTS
 * Do not edit the code without informing James Pogio
 * Contact: james.pogio@eagleview.com
 * ============================================================
 */

const STATE_API = (id) => `https://api.cmh.platform-prod2.evinternal.net/operations-center/api/TaskState/report/${id}`;

// Set date picker default to today
(function () {
  const today = new Date();
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const dd    = String(today.getDate()).padStart(2, '0');
  const yyyy  = today.getFullYear();
  document.getElementById('dateInput').value = `${yyyy}-${mm}-${dd}`;

  // Reflect default sort on the Completed column header
  const ths  = document.querySelectorAll('th');
  const keys = ['reportID','companyName','completedTime','taskState','deliveryProductName','primaryProductName','status','subStatus','techName'];
  ths[keys.indexOf('completedTime')].classList.add('sort-desc');
})();

// ─── Traffic API builder ─────────────────────────────────────────────────────
function getTrafficAPI() {
  const raw = document.getElementById('dateInput').value; // yyyy-mm-dd
  if (!raw) return null;
  const [y, m, d] = raw.split('-');
  const formatted  = `${parseInt(m)}/${parseInt(d)}/${y}`; // M/D/YYYY
  return `https://api.cmh.platform-prod.evinternal.net/operations-center/api/TaskTrafficView/?type=25&value=${formatted}&type=30&value=Test&type=18&value=HQ&type=33&value=3DRoofHipster&type=44&value=Completed-Sent&type=30&value=Training&`;
}

// ─── Tuning constants ────────────────────────────────────────────────────────
const CONCURRENCY   = 100;  // parallel state requests
const RENDER_MS     = 250;  // table re-render throttle in ms
const FETCH_TIMEOUT = 5000; // per-request timeout in ms
// ────────────────────────────────────────────────────────────────────────────

// ─── App state ───────────────────────────────────────────────────────────────
let allData     = [];
let sortKey     = 'completedTime';
let sortDir     = 'desc';
let abortCtrl   = null; // AbortController for the current load
let currentPage = 1;
const PAGE_SIZE = 15;

// Hourly table sort state
let hourlySortKey = 'hour';
let hourlySortDir = 'desc';

// ─── Status pill ─────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const pill = document.getElementById('statusPill');
  pill.className   = `status-pill ${state}`;
  pill.textContent = text;
}

// ─── Timezone ────────────────────────────────────────────────────────────────
// API times are naive ISO strings representing Pacific wall-clock time (no Z/offset).
// We rewrite them as explicit Pacific offsets so JS Date holds the correct UTC epoch.
const PT_ZONE  = 'America/Los_Angeles';
let useLocalTZ = false; // false = show Pacific, true = show browser local

function applyTZ() {
  const btn = document.getElementById('tzToggle');
  btn.textContent   = useLocalTZ ? '🕐 Local' : '🕐 PDT/PST';
  btn.style.color   = useLocalTZ ? 'var(--accent)' : '';
  btn.style.borderColor = useLocalTZ ? 'var(--accent)' : '';
  const tzLabel = document.getElementById('hourlyTZLabel');
  if (tzLabel) tzLabel.textContent = useLocalTZ ? '(Local)' : '(PDT/PST)';
}

function toggleTZ() {
  useLocalTZ = !useLocalTZ;
  localStorage.setItem('hipster_useLocalTZ', useLocalTZ ? '1' : '0');
  applyTZ();
  // Re-render everything that shows times
  if (allData.length) { filterTable(); renderHourly(); }
}

// Restore saved TZ preference
(function () {
  const saved = localStorage.getItem('hipster_useLocalTZ');
  if (saved !== null) useLocalTZ = saved === '1';
  applyTZ();
})();

// Convert a naive Pacific ISO string (e.g. "2026-03-16T19:24:41.517") to a
// proper Date by figuring out the correct UTC offset for that moment in PT.
function ptToDate(iso) {
  if (!iso) return null;
  // Step 1: assume UTC to get an approximate epoch for DST lookup
  const approx = new Date(iso + 'Z');
  // Step 2: find what Pacific wall-clock looks like at that UTC moment
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PT_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(approx);
  const p = {};
  parts.forEach(({ type, value }) => { p[type] = value; });
  // Step 3: difference between what PT says and what we fed in = PT offset
  const ptWall  = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}Z`);
  const offsetMs = approx - ptWall; // e.g. +7h for PDT, +8h for PST
  // Step 4: correct epoch = naive-as-UTC + offset
  return new Date(approx.getTime() + offsetMs);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = ptToDate(iso);
  if (!d) return '—';
  const tz = useLocalTZ ? undefined : PT_ZONE;
  return d.toLocaleDateString('en-US',  { timeZone: tz, month: 'short', day: '2-digit', year: '2-digit' })
       + ' ' + d.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── Tech extraction ─────────────────────────────────────────────────────────
// Optimised: single reverse pass collects both landmarks, no second loop needed
function extractTech(taskStates) {
  if (!taskStates || !taskStates.length) return '—';

  let metricsIdx  = -1;
  let checkinDesc = null;

  for (let i = taskStates.length - 1; i >= 0; i--) {
    const desc = taskStates[i].description || '';

    if (metricsIdx === -1) {
      // Still looking for the metrics marker
      if (desc.includes('MetricsCalculated-StateTransition')) metricsIdx = i;
      continue; // keep scanning backwards
    }

    // metrics marker found — now find the first Measured-CheckIn before it
    if (desc.includes('Measured-CheckIn')) {
      checkinDesc = desc;
      break; // done — no need to scan further
    }
  }

  if (metricsIdx === -1 || checkinDesc === null) return '—';
  const match = checkinDesc.match(/\(([^)]+)\)/);
  return match ? match[1] : checkinDesc;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function statusBadge(s) {
  if (!s) return '<span class="badge badge-other">—</span>';
  const lower = s.toLowerCase();
  if (lower.includes('complet'))                          return `<span class="badge badge-completed">${s}</span>`;
  if (lower.includes('process') || lower.includes('pending')) return `<span class="badge badge-inprocess">${s}</span>`;
  return `<span class="badge badge-other">${s}</span>`;
}

// ─── Row rendering ───────────────────────────────────────────────────────────
function renderRows(data) {
  const tbody = document.getElementById('tableBody');

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="icon">◈</div><p>No matching records found</p></div></td></tr>`;
    document.getElementById('tableFooter').style.display = 'flex';
    document.getElementById('footerLeft').textContent    = '0 BOG records shown';
    document.getElementById('footerRight').textContent   = `${allData.length} total loaded`;
    document.getElementById('pagination').innerHTML      = '';
    return;
  }

  const totalPages = Math.ceil(data.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = totalPages;

  const start    = (currentPage - 1) * PAGE_SIZE;
  const pageData = data.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = pageData.map(r => `
    <tr data-id="${r.reportID}">
      <td class="td-id">${r.reportID}</td>
      <td class="td-company" title="${r.companyName}">${r.companyName || '—'}</td>
      <td class="td-date">${r.techName === null ? '<span class="td-loading">loading…</span>' : formatDate(r.completedTime)}</td>
      <td class="td-state">${r.taskState || '—'}</td>
      <td style="font-size:12px;color:var(--text)">${r.deliveryProductName || '—'}</td>
      <td style="font-size:12px;color:var(--text);max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${r.primaryProductName}">${r.primaryProductName || '—'}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${statusBadge(r.subStatus)}</td>
      <td class="${r.techName && r.techName !== '—' ? 'td-tech' : 'td-loading'}">${r.techName === null ? '<span class="td-loading">loading…</span>' : (r.techName || '—')}</td>
    </tr>
  `).join('');

  // Stats
  document.getElementById('statsBar').style.display   = 'flex';
  document.getElementById('statTotal').textContent    = allData.length;
  document.getElementById('statTech').textContent     = allData.filter(r => r.techName && r.techName.includes('-BOG')).length;

  // Footer
  document.getElementById('tableFooter').style.display = 'flex';
  document.getElementById('footerLeft').textContent    = `${start + 1}–${Math.min(start + PAGE_SIZE, data.length)} of ${data.length} BOG records`;
  document.getElementById('footerRight').textContent   = `${allData.length} total loaded`;

  // Pagination controls
  renderPagination(totalPages);
}

// ─── Pagination ──────────────────────────────────────────────────────────────
function renderPagination(totalPages) {
  const el = document.getElementById('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  // Always show first, last, current ±1, with ellipsis
  const show   = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...show].sort((a, b) => a - b);

  let html = `<button class="page-btn nav" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;

  let prev = null;
  for (const p of sorted) {
    if (prev !== null && p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  }

  html += `<button class="page-btn nav" onclick="goPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;
  el.innerHTML = html;
}

function goPage(page) {
  currentPage = page;
  filterTable();
}

// ─── Hourly sort ─────────────────────────────────────────────────────────────
function sortHourly(key) {
  if (hourlySortKey === key) hourlySortDir = hourlySortDir === 'asc' ? 'desc' : 'asc';
  else { hourlySortKey = key; hourlySortDir = key === 'hour' ? 'desc' : 'desc'; }
  renderHourly();
}

// ─── Hourly table render ─────────────────────────────────────────────────────
function renderHourly() {
  const buckets = {};

  for (const r of allData) {
    if (!r.completedTime) continue;
    const d = ptToDate(r.completedTime);
    if (!d) continue;
    let hh;
    if (useLocalTZ) {
      hh = String(d.getHours()).padStart(2, '0');
    } else {
      const hp = new Intl.DateTimeFormat('en-US', { timeZone: PT_ZONE, hour: '2-digit', hour12: false }).formatToParts(d);
      hh = hp.find(x => x.type === 'hour').value;
      if (hh === '24') hh = '00';
    }
    const key = `${hh}:00`;
    if (!buckets[key]) buckets[key] = { hour: key, total: 0, bog: 0, mnl: 0, cbu: 0, pending: 0 };
    buckets[key].total++;
    if      (r.techName === null)                            buckets[key].pending++;
    else if (r.techName && r.techName.includes('-BOG'))      buckets[key].bog++;
    else if (r.techName && r.techName.includes('-MNL'))      buckets[key].mnl++;
    else if (r.techName && r.techName.includes('-CBU'))      buckets[key].cbu++;
  }

  const rows = Object.values(buckets).map(r => {
    const measured = r.bog + r.mnl + r.cbu;
    const pctOf    = (v) => measured > 0 ? Math.round((v / measured) * 100) : 0;
    return { ...r, bogPct: pctOf(r.bog), mnlPct: pctOf(r.mnl), cbuPct: pctOf(r.cbu) };
  }).sort((a, b) => {
    const av  = a[hourlySortKey] ?? 0;
    const bv  = b[hourlySortKey] ?? 0;
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return hourlySortDir === 'asc' ? cmp : -cmp;
  });

  // Update header sort indicators
  const hourlyKeys = ['hour','bog','bogPct','mnl','mnlPct','cbu','cbuPct','total'];
  document.querySelectorAll('.hourly-table th').forEach((th, i) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (hourlyKeys[i] === hourlySortKey) th.classList.add(hourlySortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0);
  const tbody    = document.getElementById('hourlyBody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;font-family:var(--mono);font-size:12px;color:var(--text-dim)">No data</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r => {
      const barPct = maxTotal ? Math.round((r.total / maxTotal) * 100) : 0;
      const { bogPct, mnlPct, cbuPct } = r;
      const fmtPct = (v, cls) => v > 0
        ? `<td class="${cls}">${v}%</td>`
        : `<td class="td-pct" style="color:var(--text-dim)">—</td>`;
      const cell = (v, cls) => v > 0 ? `<td class="${cls}">${v}</td>` : `<td style="color:var(--text-dim)">0</td>`;
      return `
        <tr>
          <td class="td-hour">${r.hour}</td>
          ${cell(r.bog, 'td-bog')}
          ${fmtPct(bogPct, 'td-pct-bog')}
          ${cell(r.mnl, 'td-mnl')}
          ${fmtPct(mnlPct, 'td-pct-mnl')}
          ${cell(r.cbu, 'td-cbu')}
          ${fmtPct(cbuPct, 'td-pct-cbu')}
          <td>
            <div class="hourly-bar-wrap">
              <div class="hourly-bar-track">
                <div class="hourly-bar-fill" style="width:${barPct}%"></div>
              </div>
              <span class="hourly-bar-pct">${r.total}</span>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  document.getElementById('hourlyWrap').classList.add('visible');
}

// ─── Search / filter ─────────────────────────────────────────────────────────
function filterTable() {
  const q       = document.getElementById('searchInput').value.toLowerCase();
  const bogOnly = allData.filter(r => r.techName !== null && (r.techName || '').includes('-BOG'));
  const filtered = q
    ? bogOnly.filter(r =>
        String(r.reportID).includes(q) ||
        (r.companyName  || '').toLowerCase().includes(q) ||
        (r.taskState    || '').toLowerCase().includes(q) ||
        (r.techName     || '').toLowerCase().includes(q) ||
        (r.status       || '').toLowerCase().includes(q)
      )
    : bogOnly;
  document.getElementById('filterCount').textContent = q ? `${filtered.length} of ${allData.length}` : '';
  if (document.activeElement === document.getElementById('searchInput')) currentPage = 1;
  renderRows(sortData(filtered));
}

// ─── Table sort ───────────────────────────────────────────────────────────────
function sortData(data) {
  if (!sortKey) return data;
  return [...data].sort((a, b) => {
    const av  = a[sortKey] ?? '';
    const bv  = b[sortKey] ?? '';
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function sortTable(key) {
  if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortKey = key; sortDir = 'asc'; }
  currentPage = 1;

  document.querySelectorAll('th').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
  const ths  = document.querySelectorAll('th');
  const keys = ['reportID','companyName','completedTime','taskState','deliveryProductName','primaryProductName','status','subStatus','techName'];
  const idx  = keys.indexOf(key);
  if (idx !== -1) ths[idx].classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');

  filterTable();
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_DELAY = 1200; // ms between retries

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, signal, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      // Don't retry client errors (4xx), only server errors (5xx)
      if (res.status < 500) return res;
      if (attempt === retries) return res; // give up, return the bad response
    } catch (err) {
      if (err.name === 'AbortError') throw err; // never swallow abort
      if (attempt === retries) throw err;
    }
    await sleep(RETRY_DELAY * attempt); // back-off: 1.2s, 2.4s
  }
}

// ─── Main data loader ─────────────────────────────────────────────────────────
async function loadData() {
  // Cancel any previous in-flight load
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;

  document.getElementById('loadBtn').disabled           = true;
  document.getElementById('refreshBtn').style.display   = 'none';
  setStatus('loading', 'FETCHING');
  allData = [];
  document.getElementById('hourlyWrap').classList.remove('visible');
  document.getElementById('tableWrap').style.display    = 'none';
  document.getElementById('searchInput').style.display  = 'none';

  const progressWrap  = document.getElementById('progressWrap');
  const progressFill  = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');

  try {
    // Step 1: fetch traffic view (with retry)
    const TRAFFIC_API = getTrafficAPI();
    if (!TRAFFIC_API) throw new Error('Please select a date before loading data.');

    setStatus('loading', 'FETCHING');
    let res;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      progressLabel.textContent = attempt > 1 ? `Retrying… attempt ${attempt} of ${MAX_RETRIES}` : '';
      progressWrap.classList.toggle('visible', attempt > 1);
      res = await fetch(TRAFFIC_API, { signal });
      if (res.ok) break;
      if (res.status < 500 || attempt === MAX_RETRIES)
        throw new Error(`Server returned ${res.status} after ${attempt} attempt(s). The server may be temporarily unavailable — please try again in a moment.`);
      await sleep(RETRY_DELAY * attempt);
    }
    progressWrap.classList.remove('visible');

    const reports = await res.json();

    if (!reports.length) {
      setStatus('done', 'DONE');
      document.getElementById('tableBody').innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="icon">◈</div><p>No reports returned</p></div></td></tr>`;
      document.getElementById('loadBtn').disabled = false;
      return;
    }

    // Initialize rows with null techName (loading state)
    allData = reports.map(r => ({ ...r, techName: null }));
    document.getElementById('tableWrap').style.display   = 'block';
    document.getElementById('searchInput').style.display = 'block';
    renderRows(sortData(allData));
    renderHourly();
    document.getElementById('statsBar').style.display    = 'flex';
    document.getElementById('statTotal').textContent     = allData.length;
    document.getElementById('statTime').textContent      = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Step 2: fetch task states concurrently with throttled re-renders
    progressWrap.classList.add('visible');
    progressLabel.textContent  = `Fetching task states… 0 / ${reports.length}`;
    progressFill.style.width   = '0%';

    let completed = 0;

    // Patch a single resolved row in-place — no full re-render needed
    function patchRow(r) {
      const tr = document.querySelector(`#tableBody tr[data-id="${r.reportID}"]`);
      if (!tr) return;
      const cells = tr.cells;
      // cell 2 = Completed time
      cells[2].className = 'td-date';
      cells[2].innerHTML = formatDate(r.completedTime);
      // cell 8 = Tech
      const hasTech = r.techName && r.techName !== '—';
      cells[8].className   = hasTech ? 'td-tech' : '';
      cells[8].textContent = r.techName || '—';
    }

    // Throttled hourly + stat re-render (heavier, runs less often)
    let hourlyTimer = null;
    function scheduleHourly() {
      if (!hourlyTimer) {
        hourlyTimer = setTimeout(() => {
          hourlyTimer = null;
          renderHourly();
          document.getElementById('statTech').textContent =
            allData.filter(r => r.techName && r.techName.includes('-BOG')).length;
        }, RENDER_MS * 4);
      }
    }

    async function fetchState(report, idx) {
      let timeoutId;
      const timeoutSignal = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new DOMException('Timeout', 'TimeoutError')), FETCH_TIMEOUT);
      });

      try {
        const fetchPromise = fetch(STATE_API(report.reportID), { signal });
        const r = await Promise.race([fetchPromise, timeoutSignal]);
        clearTimeout(timeoutId);
        if (!r.ok) { allData[idx].techName = '—'; }
        else {
          const data = await r.json();
          allData[idx].techName      = extractTech(data.taskStates);
          const completedState = (data.taskStates || []).find(s => s.description === 'Completed-Trigger');
          allData[idx].completedTime = completedState ? completedState.stateTime : null;
        }
      } catch {
        clearTimeout(timeoutId);
        allData[idx].techName = '—';
      } finally {
        completed++;
        const pct = Math.round((completed / reports.length) * 100);
        progressFill.style.width   = pct + '%';
        progressLabel.textContent  = `Fetching task states… ${completed} / ${reports.length}`;
        patchRow(allData[idx]);
        scheduleHourly();
      }
    }

    // Rolling concurrency limiter
    await new Promise(resolve => {
      let started = 0, finished = 0;
      function next() {
        while (started < reports.length && (started - finished) < CONCURRENCY) {
          const idx = started++;
          fetchState(reports[idx], idx).then(() => {
            finished++;
            if (finished === reports.length) resolve();
            else next();
          });
        }
      }
      next();
    });

    if (hourlyTimer) { clearTimeout(hourlyTimer); hourlyTimer = null; }
    progressWrap.classList.remove('visible');
    setStatus('done', 'LOADED');
    document.getElementById('refreshBtn').style.display = 'inline-block';
    // Final authoritative render now all states are resolved
    filterTable();
    renderHourly();
    document.getElementById('statTech').textContent =
      allData.filter(r => r.techName && r.techName.includes('-BOG')).length;

  } catch (err) {
    if (err.name === 'AbortError') return; // silently ignore cancelled loads
    setStatus('error', 'ERROR');
    document.getElementById('tableBody').innerHTML = `
      <tr><td colspan="9"><div class="empty-state">
        <div class="icon">⚠</div>
        <p style="color:var(--red)">${err.message}</p>
        <p style="margin-top:8px;font-size:11px">Check CORS / network access and try again</p>
      </div></td></tr>`;
    progressWrap.classList.remove('visible');
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
}
