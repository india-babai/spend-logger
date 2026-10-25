'use strict';
/*
 * Spend Logger — personal credit card spending tracker.
 * Plain JS, no build step. All data lives in this browser's localStorage.
 *
 * Sections:
 *   1. Constants & default data
 *   2. Small helpers (ids, escaping, money)
 *   3. Dates & billing cycles
 *   4. Storage
 *   5. Calculations
 *   6. Rendering: header, home, history, settings
 *   7. Adding / editing expenses (sheet + pause screen)
 *   8. Quick-add (tap = log, long-press = edit first)
 *   9. Toast with undo
 *  10. Backup: export / import
 *  11. Events & start-up
 */

/* ==========================================================================
   1. Constants & default data
   ========================================================================== */

const STORAGE_KEY = 'spendlogger.v1';
const CYCLE_START_DAY = 19;       // cycle runs 19th → 18th (statement date: 18th)
const SMALL_SPEND_LIMIT = 200;    // "small spend" counter threshold
const PAUSE_THRESHOLD = 1000;     // show the pause screen at or above this amount
const BACKUP_REMINDER_DAYS = 14;  // nag if the last export is older than this
const LONG_PRESS_MS = 500;
const FIXED_ID = 'fixed';         // id of the built-in Fixed/EMI category

function defaultState() {
  const thisCycle = currentKey();
  return {
    version: 1,
    budget: 22000,
    theme: 'auto', // 'auto' | 'light' | 'dark'
    categories: [
      { id: 'blinkit', name: 'Blinkit/Zepto', budget: 1800 },
      { id: 'cafe', name: 'Café & outings', budget: 1500 },
      { id: 'snacks', name: 'Snacks & tea', budget: 1000 },
      { id: 'fruitveg', name: 'Local fruit/veg', budget: 1000 },
      { id: 'fuel', name: 'Fuel', budget: 700 },
      { id: 'upi', name: 'UPI to people', budget: 2000 },
      { id: 'shopping', name: 'Shopping/one-offs', budget: 2500 },
      { id: 'salon', name: 'Salon & other', budget: 500 },
      { id: FIXED_ID, name: 'Fixed/EMI', budget: null }, // null = no cap
    ],
    presets: [
      { id: 'p-sujata', name: 'Sujata', amount: 70, categoryId: 'snacks' },
      { id: 'p-soumen', name: 'Soumen Foods', amount: 80, categoryId: 'snacks' },
      { id: 'p-tea', name: 'Tea', amount: 20, categoryId: 'snacks' },
      { id: 'p-fruitveg', name: 'Fruit/veg', amount: 100, categoryId: 'fruitveg' },
      { id: 'p-blinkit', name: 'Blinkit', amount: 400, categoryId: 'blinkit' },
      { id: 'p-fuel', name: 'Fuel', amount: 200, categoryId: 'fuel' },
    ],
    // One-time entries use `cycle`; recurring ones use `startCycle` (+ optional `endCycle`).
    // Cycle keys are the cycle's start date, e.g. '2026-10-19' = 19 Oct → 18 Nov 2026.
    fixedCosts: [
      { id: 'f-emi-final', name: 'Final EMIs (Easy Trip + Pista House, 3 of 3)', amount: 7983, recurring: false, cycle: '2026-10-19' },
      { id: 'f-mobile', name: 'Mobile recharge', amount: 369, recurring: true, startCycle: thisCycle, endCycle: null },
    ],
    transactions: [], // { id, amount, categoryId, note, date: 'YYYY-MM-DD', createdAt, fixedId? }
    statements: {},   // { [cycleKey]: statement total }
    lastExport: null, // ISO timestamp of last backup
  };
}

/* ==========================================================================
   2. Small helpers
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Escape text before putting it into innerHTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Round to paise so floating point noise never shows up. */
const roundMoney = (n) => Math.round(n * 100) / 100;
const sumAmounts = (list) => roundMoney(list.reduce((s, x) => s + Number(x.amount || 0), 0));

const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrExact = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** ₹24,573 — whole rupees, for totals and calculated figures. */
function fmt(n) {
  const v = Math.round(n);
  return (v < 0 ? '−' : '') + '₹' + inrWhole.format(Math.abs(v));
}
/** ₹24.50 — keeps paise, for individual transactions. */
function fmtExact(n) {
  return (n < 0 ? '−' : '') + '₹' + inrExact.format(Math.abs(n));
}
/** ₹21.4k — compact, for chart labels. */
function fmtShort(n) {
  if (n >= 1000) return '₹' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '₹' + Math.round(n);
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Colour level for a bar: amber at 75%, red at 100%. */
function level(pct) {
  if (pct >= 100) return 'over';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/* ==========================================================================
   3. Dates & billing cycles
   Dates are stored as 'YYYY-MM-DD' strings in local time. Day arithmetic is
   done in UTC so it is never thrown off by time zones.
   ========================================================================== */

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' from year, 0-based month, day. Overflow rolls over (month 12 → next Jan). */
function isoFrom(y, m, d) {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m - 1, d];
}
function dayNumber(iso) {
  const [y, m, d] = parseISO(iso);
  return Date.UTC(y, m, d) / DAY_MS;
}
function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}
function utcDate(iso) {
  const [y, m, d] = parseISO(iso);
  return new Date(Date.UTC(y, m, d));
}

/** A cycle is identified by its start date. 25 Oct → '…-10-19'; 5 Nov → '…-10-19'. */
function cycleKeyFor(iso) {
  const [y, m, d] = parseISO(iso);
  return d >= CYCLE_START_DAY ? isoFrom(y, m, CYCLE_START_DAY) : isoFrom(y, m - 1, CYCLE_START_DAY);
}
function currentKey() {
  return cycleKeyFor(todayISO());
}
function shiftCycle(key, n) {
  const [y, m] = parseISO(key);
  return isoFrom(y, m + n, CYCLE_START_DAY);
}
function cycleInfo(key) {
  const [y, m] = parseISO(key);
  const end = isoFrom(y, m + 1, CYCLE_START_DAY - 1);
  return { start: key, end, days: dayNumber(end) - dayNumber(key) + 1 };
}

const fmtDayMonth = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' });
const fmtWeekday = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLongDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** "19 Oct – 18 Nov" */
function cycleLabel(key) {
  const { start, end } = cycleInfo(key);
  return `${fmtDayMonth.format(utcDate(start))} – ${fmtDayMonth.format(utcDate(end))}`;
}
/** "19 Oct – 18 Nov 2026" */
function cycleLabelYear(key) {
  return `${cycleLabel(key)} ${parseISO(cycleInfo(key).end)[0]}`;
}

/* ==========================================================================
   4. Storage
   ========================================================================== */

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (err) {
    console.error('Could not read saved data', err);
  }
  return defaultState();
}

/** Fill in anything missing (e.g. data from an older version or an import). */
function normalizeState(data) {
  const d = defaultState();
  const s = { ...d, ...data };
  for (const key of ['categories', 'presets', 'fixedCosts', 'transactions']) {
    if (!Array.isArray(s[key])) s[key] = d[key];
  }
  if (!s.statements || typeof s.statements !== 'object') s.statements = {};
  // The Fixed/EMI category must always exist.
  if (!s.categories.some((c) => c.id === FIXED_ID)) {
    s.categories.push({ id: FIXED_ID, name: 'Fixed/EMI', budget: null });
  }
  s.budget = Number(s.budget) || 0;
  return s;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    alert('Could not save — storage may be full. Export a backup now.');
    console.error(err);
  }
}

/* ==========================================================================
   5. Calculations
   ========================================================================== */

/** Fixed cost entries that apply to a cycle. */
function fixedCostsFor(key) {
  return state.fixedCosts.filter((f) => (f.recurring
    ? key >= f.startCycle && (!f.endCycle || key <= f.endCycle)
    : f.cycle === key));
}

/** Fixed spending is not extrapolated in the projection. */
const isFixedTxn = (t) => Boolean(t.fixedId) || t.categoryId === FIXED_ID;

/**
 * Everything the screens need for one cycle.
 *
 * Fixed costs count from day one of the cycle: until a fixed cost is marked
 * as charged (which logs a linked transaction), its expected amount is added
 * to the bill, so the meter never looks better than it really is.
 */
function summarize(key) {
  const { start, end, days } = cycleInfo(key);
  const txns = state.transactions.filter((t) => t.date >= start && t.date <= end);

  const logged = sumAmounts(txns);
  const fixedLogged = sumAmounts(txns.filter(isFixedTxn));
  const variable = roundMoney(logged - fixedLogged);

  const fixedDue = fixedCostsFor(key);
  const pendingFixed = fixedDue.filter((f) => !txns.some((t) => t.fixedId === f.id));
  const pendingTotal = sumAmounts(pendingFixed);

  // The expected bill: what's logged + fixed costs still to come.
  const bill = roundMoney(logged + pendingTotal);

  // Days elapsed / left, both counting today. Past cycles: all elapsed.
  const today = dayNumber(todayISO());
  const elapsed = Math.min(days, Math.max(0, today - dayNumber(start) + 1));
  const daysLeft = Math.min(days, Math.max(0, dayNumber(end) - today + 1));

  // Projection: fixed costs + (variable so far ÷ days elapsed × days in cycle)
  const projection = fixedLogged + pendingTotal + (elapsed ? (variable / elapsed) * days : 0);

  // Daily allowance: (budget − spent − fixed not yet charged) ÷ days left
  const allowance = daysLeft ? (state.budget - bill) / daysLeft : 0;

  const small = txns.filter((t) => t.amount < SMALL_SPEND_LIMIT);

  const byCategory = {};
  for (const t of txns) byCategory[t.categoryId] = (byCategory[t.categoryId] || 0) + t.amount;
  byCategory[FIXED_ID] = (byCategory[FIXED_ID] || 0) + pendingTotal;

  return {
    start, end, days, txns, logged, variable, fixedDue, pendingTotal, bill,
    elapsed, daysLeft, projection, allowance, byCategory,
    smallCount: small.length, smallTotal: sumAmounts(small),
  };
}

function categoryName(id) {
  return state.categories.find((c) => c.id === id)?.name ?? 'Uncategorised';
}

/* ==========================================================================
   6. Rendering
   ========================================================================== */

let currentTab = 'home';
let viewKey = currentKey();       // the cycle being viewed
let knownCurrent = currentKey();  // to notice when the app is reopened in a new cycle

function render() {
  const isSettings = currentTab === 'settings';
  const isCurrent = viewKey === currentKey();

  // Header
  $('#cycleNav').hidden = isSettings;
  $('#pageTitle').hidden = !isSettings;
  $('#cycleLabel').textContent = cycleLabel(viewKey);
  const sub = $('#cycleSub');
  sub.textContent = isCurrent ? `Current cycle · ${parseISO(cycleInfo(viewKey).end)[0]}` : `Past cycle · tap for current`;
  sub.classList.toggle('past', !isCurrent);
  $('#nextCycleBtn').disabled = viewKey >= currentKey();

  // Tabs & views
  for (const tab of ['home', 'history', 'settings']) {
    $(`#view-${tab}`).hidden = tab !== currentTab;
    document.querySelector(`[data-tab="${tab}"]`).classList.toggle('active', tab === currentTab);
  }
  $('#fab').hidden = isSettings;

  renderBanner();
  if (currentTab === 'home') renderHome();
  if (currentTab === 'history') renderHistory();
  if (currentTab === 'settings') renderSettings();
}

/** Progress bar HTML. */
function bar(spent, cap, extraClass = '') {
  const pct = cap > 0 ? (spent / cap) * 100 : 0;
  return `<div class="bar ${extraClass}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
    <div class="fill ${level(pct)}" style="width:${Math.min(100, pct)}%"></div></div>`;
}

function renderBanner() {
  const el = $('#backupBanner');
  const hasData = state.transactions.length > 0;
  const daysSince = state.lastExport ? Math.floor((Date.now() - new Date(state.lastExport)) / DAY_MS) : null;
  const overdue = hasData && (daysSince === null || daysSince > BACKUP_REMINDER_DAYS);
  el.hidden = !overdue;
  if (!overdue) return;
  const msg = daysSince === null ? 'You haven’t backed up your data yet.' : `Last backup was ${daysSince} days ago.`;
  el.innerHTML = `<div class="banner-inner"><span>${msg}</span>
    <button class="btn small primary" data-action="export-download">Back up</button></div>`;
}

/* ---------- Home ---------- */

function renderHome() {
  const s = summarize(viewKey);
  const isCurrent = viewKey === currentKey();
  const budget = state.budget;

  // Projection colour: green ≤ 90% of budget, amber up to 100%, red above.
  const paceRatio = budget ? s.projection / budget : 0;
  const paceClass = paceRatio > 1 ? 'over-text' : paceRatio > 0.9 ? 'warn-text' : 'ok-text';

  let allowanceHtml;
  if (s.daysLeft === 0) {
    allowanceHtml = `<span class="muted">Cycle closed</span>`;
  } else if (s.allowance > 0) {
    allowanceHtml = `${fmt(s.allowance)}/day<small>for ${plural(s.daysLeft, 'day')}</small>`;
  } else {
    allowanceHtml = `<span class="over-text">₹0/day</span><small>over by ${fmt(s.bill - budget)}</small>`;
  }

  const meterNote = s.pendingTotal > 0
    ? `Includes ${fmt(s.pendingTotal)} of fixed costs not yet charged`
    : `${fmt(Math.max(0, budget - s.bill))} left in budget`;

  let html = `
    <div class="card meter">
      <div class="meter-amount num">${fmt(s.bill)} <small>of ${fmt(budget)}</small></div>
      ${bar(s.bill, budget, 'thick')}
      <div class="meter-foot">${meterNote}</div>
    </div>

    <div class="card stat-list">
      <div class="stat">
        <span class="stat-label">At this pace</span>
        <span class="stat-value num ${paceClass}">${fmt(s.projection)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Daily allowance</span>
        <span class="stat-value num">${allowanceHtml}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Small spends (under ${fmt(SMALL_SPEND_LIMIT)})</span>
        <span class="stat-value num">${fmt(s.smallTotal)}<small>${plural(s.smallCount, 'transaction')}</small></span>
      </div>
    </div>`;

  // Quick-add only makes sense for the current cycle (presets log for today).
  if (isCurrent) {
    html += `
    <div class="card">
      <div class="card-head"><h2>Quick add</h2><span class="hint">Tap to log · hold to edit</span></div>
      <div class="quick-grid">
        ${state.presets.map((p) => `
          <button class="preset" data-preset="${esc(p.id)}">
            <span class="preset-name">${esc(p.name)}</span>
            <span class="preset-amt num">${fmtExact(p.amount)}</span>
          </button>`).join('')}
      </div>
      ${state.presets.length ? '' : '<p class="hint">Add presets in Settings.</p>'}
    </div>`;
  }

  // Category bars
  html += `<div class="card"><h2>Categories</h2>
    ${state.categories.map((c) => {
      const spent = s.byCategory[c.id] || 0;
      if (c.budget == null) {
        return `<div class="cat-row"><div class="cat-top"><span>${esc(c.name)}</span>
          <span class="num">${fmt(spent)} · no cap</span></div></div>`;
      }
      return `<div class="cat-row"><div class="cat-top"><span>${esc(c.name)}</span>
        <span class="num">${fmt(spent)} / ${fmt(c.budget)}</span></div>${bar(spent, c.budget)}</div>`;
    }).join('')}
  </div>`;

  // Fixed costs for this cycle, with a button to mark each one as charged.
  if (s.fixedDue.length) {
    html += `<div class="card"><h2>Fixed costs this cycle</h2>
      ${s.fixedDue.map((f) => {
        const linked = s.txns.filter((t) => t.fixedId === f.id);
        const right = linked.length
          ? `<span class="charged">✓ ${fmtExact(sumAmounts(linked))}</span>`
          : `<button class="btn small" data-action="mark-charged" data-id="${esc(f.id)}">Mark charged</button>`;
        return `<div class="fixed-row"><div class="grow">
          <div class="fixed-name">${esc(f.name)}</div>
          <div class="fixed-amt num">${fmtExact(f.amount)} · ${f.recurring ? 'recurring' : 'one-time'}</div>
        </div>${right}</div>`;
      }).join('')}
    </div>`;
  }

  $('#view-home').innerHTML = html;
}

/* ---------- History ---------- */

function renderHistory() {
  const s = summarize(viewKey);
  const stmt = state.statements[viewKey];

  let html = `
    <div class="card">
      <h2>Reconcile with statement</h2>
      <label class="field">Statement total (₹)
        <input id="stmtInput" type="number" inputmode="decimal" step="0.01" min="0"
               placeholder="Enter when the statement arrives" value="${stmt ?? ''}">
      </label>
      <p class="reconcile-result" id="reconcileResult">${reconcileText(s, stmt)}</p>
    </div>

    <div class="card">
      <h2>Last 6 cycles</h2>
      ${renderChart(viewKey)}
    </div>`;

  // Transactions grouped by day, newest first.
  const txns = [...s.txns].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  if (!txns.length) {
    html += `<div class="card empty">No expenses logged in this cycle.</div>`;
  } else {
    const days = new Map();
    for (const t of txns) {
      if (!days.has(t.date)) days.set(t.date, []);
      days.get(t.date).push(t);
    }
    for (const [date, list] of days) {
      html += `<div class="day-head"><span>${fmtWeekday.format(utcDate(date))}</span>
        <span class="num">${fmtExact(sumAmounts(list))}</span></div>
        <div class="card txn-group">
        ${list.map((t) => {
          const cat = categoryName(t.categoryId);
          const title = t.note || cat;
          const sub = [t.note ? cat : '', t.fixedId ? 'fixed cost' : ''].filter(Boolean).join(' · ');
          return `<button class="txn" data-action="edit-txn" data-id="${esc(t.id)}">
            <span class="txn-main"><span class="txn-title">${esc(title)}</span>
            ${sub ? `<span class="txn-sub">${esc(sub)}</span>` : ''}</span>
            <span class="txn-amt num">${fmtExact(t.amount)}</span></button>`;
        }).join('')}
        </div>`;
    }
  }

  $('#view-history').innerHTML = html;
}

/** "Logged ₹A vs Statement ₹B, gap ₹C" */
function reconcileText(s, stmt) {
  const pendingNote = s.pendingTotal > 0 ? ` (includes ${fmt(s.pendingTotal)} of fixed costs not marked charged)` : '';
  if (stmt == null || stmt === '') {
    return `<span class="muted">Logged so far: ${fmtExact(s.bill)}${pendingNote}.</span>`;
  }
  const gap = roundMoney(stmt - s.bill);
  let hint;
  if (Math.abs(gap) < 1) hint = '<span class="ok-text">Spot on.</span>';
  else if (gap > 0) hint = '<span class="warn-text">The statement is higher — some spends weren’t logged.</span>';
  else hint = '<span class="warn-text">You logged more than the statement — a charge may be pending or duplicated.</span>';
  return `Logged <strong>${fmtExact(s.bill)}</strong> vs Statement <strong>${fmtExact(stmt)}</strong>,
    gap <strong>${fmtExact(Math.abs(gap))}</strong>${pendingNote}<br>${hint}`;
}

/** Inline SVG bar chart of the 6 cycles ending at `endKey`. No library. */
function renderChart(endKey) {
  const keys = [];
  for (let i = 5; i >= 0; i--) keys.push(shiftCycle(endKey, -i));
  const data = keys.map((k) => ({ key: k, total: summarize(k).bill, stmt: state.statements[k] }));

  const W = 340, H = 190, top = 22, bottom = 26, side = 6;
  const plotH = H - top - bottom;
  const max = Math.max(state.budget, ...data.map((d) => Math.max(d.total, d.stmt || 0)), 1) * 1.08;
  const slot = (W - side * 2) / data.length;
  const barW = slot * 0.58;
  const y = (v) => top + plotH - (v / max) * plotH;

  let svg = '';
  // Budget line
  if (state.budget > 0) {
    const by = y(state.budget);
    svg += `<line class="budget-line" x1="${side}" x2="${W - side}" y1="${by}" y2="${by}"/>
      <text class="axis-label" x="${W - side}" y="${by - 4}" text-anchor="end">Budget ${fmtShort(state.budget)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = side + slot * i + slot / 2;
    const h = Math.max(0, top + plotH - y(d.total));
    const cls = 'bar-' + level(state.budget ? (d.total / state.budget) * 100 : 0);
    const selected = d.key === endKey ? ' bar-selected' : '';
    svg += `<rect class="${cls}${selected}" x="${cx - barW / 2}" y="${top + plotH - h}" width="${barW}" height="${h}" rx="4">
      <title>${cycleLabelYear(d.key)}: ${fmt(d.total)}</title></rect>`;
    if (d.total > 0) {
      svg += `<text class="value-label" x="${cx}" y="${top + plotH - h - 5}" text-anchor="middle">${fmtShort(d.total)}</text>`;
    }
    // Statement total as a short dark tick, if entered
    if (d.stmt != null && d.stmt !== '') {
      const sy = y(d.stmt);
      svg += `<line class="stmt-mark" x1="${cx - barW / 2 - 3}" x2="${cx + barW / 2 + 3}" y1="${sy}" y2="${sy}">
        <title>Statement: ${fmt(d.stmt)}</title></line>`;
    }
    svg += `<text class="axis-label" x="${cx}" y="${H - 8}" text-anchor="middle">${fmtMonth.format(utcDate(d.key))}</text>`;
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bill totals for the last 6 cycles">${svg}</svg>
    <p class="hint">Bars show each cycle’s logged bill (labelled by the month it starts). A dark tick marks the statement total.</p>`;
}

/* ---------- Settings ---------- */

// Maps a settings row's data-kind to its array in state.
const COLLECTIONS = { category: 'categories', preset: 'presets', fixed: 'fixedCosts' };

function categoryOptions(selected) {
  return state.categories.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

/** Options for a cycle picker: 12 cycles back to 12 ahead of the current one. */
function cycleOptions(selected, allowNone = false) {
  const cur = currentKey();
  const keys = [];
  for (let i = -12; i <= 12; i++) keys.push(shiftCycle(cur, i));
  if (selected && !keys.includes(selected)) { keys.push(selected); keys.sort(); }
  return (allowNone ? `<option value="" ${!selected ? 'selected' : ''}>No end</option>` : '')
    + keys.map((k) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${cycleLabelYear(k)}</option>`).join('');
}

function categoryTotalText() {
  const total = state.categories.reduce((s, c) => s + (c.budget || 0), 0);
  return `Category budgets add up to ${fmt(total)} of your ${fmt(state.budget)} budget.`;
}

function renderSettings() {
  const lastExport = state.lastExport ? fmtLongDate.format(new Date(state.lastExport)) : 'never';

  $('#view-settings').innerHTML = `
    <div class="card">
      <h2>Budget</h2>
      <label class="field">Monthly budget (₹)
        <input type="number" inputmode="numeric" min="0" data-setting="budget" value="${state.budget}">
      </label>
      <label class="field">Theme
        <select data-setting="theme">
          ${['auto', 'light', 'dark'].map((t) => `<option value="${t}" ${state.theme === t ? 'selected' : ''}>
            ${t === 'auto' ? 'Match phone' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="card">
      <h2>Categories</h2>
      <p class="hint" id="catTotal">${categoryTotalText()}</p>
      ${state.categories.map((c) => `
        <div class="edit-row cat" data-kind="category" data-id="${esc(c.id)}">
          <input type="text" data-field="name" value="${esc(c.name)}" aria-label="Category name">
          <input type="number" inputmode="numeric" min="0" data-field="budget" value="${c.budget ?? ''}"
                 placeholder="No cap" aria-label="Budget for ${esc(c.name)}">
          ${c.id === FIXED_ID ? '<span></span>' : `<button class="del" data-action="delete-category" aria-label="Delete ${esc(c.name)}">✕</button>`}
        </div>`).join('')}
      <div class="settings-actions"><button class="btn" data-action="add-category">+ Add category</button></div>
      <p class="hint">Leave a budget blank for no cap.</p>
    </div>

    <div class="card">
      <h2>Quick-add presets</h2>
      ${state.presets.map((p) => `
        <div class="edit-row" data-kind="preset" data-id="${esc(p.id)}">
          <input type="text" class="span-2" data-field="name" value="${esc(p.name)}" aria-label="Preset name">
          <button class="del" data-action="delete-preset" aria-label="Delete ${esc(p.name)}">✕</button>
          <input type="number" inputmode="decimal" min="0" step="0.01" data-field="amount" value="${p.amount}" aria-label="Amount">
          <select class="span-2" data-field="categoryId" aria-label="Category">${categoryOptions(p.categoryId)}</select>
        </div>`).join('')}
      <div class="settings-actions"><button class="btn" data-action="add-preset">+ Add preset</button></div>
    </div>

    <div class="card">
      <h2>Fixed costs</h2>
      <p class="hint">Counted from the first day of their cycle until you mark them charged on Home.</p>
      ${state.fixedCosts.map((f) => `
        <div class="edit-row" data-kind="fixed" data-id="${esc(f.id)}">
          <input type="text" class="span-2" data-field="name" value="${esc(f.name)}" aria-label="Fixed cost name">
          <button class="del" data-action="delete-fixed" aria-label="Delete ${esc(f.name)}">✕</button>
          <label class="mini-label">Amount (₹)
            <input type="number" inputmode="decimal" min="0" step="0.01" data-field="amount" value="${f.amount}">
          </label>
          <label class="mini-label span-2">Repeats
            <select data-field="recurring">
              <option value="no" ${f.recurring ? '' : 'selected'}>One-time</option>
              <option value="yes" ${f.recurring ? 'selected' : ''}>Every cycle</option>
            </select>
          </label>
          ${f.recurring ? `
            <label class="mini-label span-all">From cycle
              <select data-field="startCycle">${cycleOptions(f.startCycle)}</select></label>
            <label class="mini-label span-all">Until cycle
              <select data-field="endCycle">${cycleOptions(f.endCycle, true)}</select></label>`
          : `
            <label class="mini-label span-all">Cycle
              <select data-field="cycle">${cycleOptions(f.cycle)}</select></label>`}
        </div>`).join('')}
      <div class="settings-actions"><button class="btn" data-action="add-fixed">+ Add fixed cost</button></div>
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="hint">Data is stored only on this device. Last export: <strong>${esc(lastExport)}</strong>.</p>
      <div class="settings-actions">
        <button class="btn primary" data-action="export-download">Export JSON</button>
        ${navigator.canShare ? '<button class="btn" data-action="export-share">Share…</button>' : ''}
        <button class="btn" data-action="import">Import</button>
      </div>
    </div>

    <p class="hint" style="text-align:center">Spend Logger · cycle runs ${CYCLE_START_DAY}th → ${CYCLE_START_DAY - 1}th</p>`;
}

/** Inline edits in Settings save on change (no re-render, so focus isn't lost). */
function onSettingsChange(e) {
  const el = e.target;

  if (el.dataset.setting === 'budget') {
    const v = Number(el.value);
    if (v >= 0) state.budget = roundMoney(v); else el.value = state.budget;
    $('#catTotal').textContent = categoryTotalText();
    return save();
  }
  if (el.dataset.setting === 'theme') {
    state.theme = el.value;
    applyTheme();
    return save();
  }

  const row = el.closest('[data-kind]');
  const field = el.dataset.field;
  if (!row || !field) return;
  const item = state[COLLECTIONS[row.dataset.kind]].find((x) => x.id === row.dataset.id);
  if (!item) return;

  let value = el.value;
  if (field === 'name') {
    value = value.trim();
    if (!value) { el.value = item.name; return; }
  } else if (field === 'amount') {
    value = roundMoney(Number(value));
    if (!(value > 0)) { el.value = item.amount; return; }
  } else if (field === 'budget') {
    value = value === '' ? null : roundMoney(Number(value));
    if (value !== null && !(value >= 0)) { el.value = item.budget ?? ''; return; }
  } else if (field === 'recurring') {
    value = value === 'yes';
  } else if (field === 'endCycle') {
    value = value || null;
  }
  item[field] = value;

  if (field === 'recurring') {
    // Carry the chosen cycle across when switching between one-time and recurring.
    if (value) item.startCycle = item.startCycle || item.cycle || currentKey();
    else item.cycle = item.cycle || item.startCycle || currentKey();
    save();
    return renderSettings();
  }
  save();
  if (row.dataset.kind === 'category') $('#catTotal').textContent = categoryTotalText();
}

/** Add a row to a settings list, then focus its name field. */
function addSettingsItem(kind, item) {
  state[COLLECTIONS[kind]].push(item);
  save();
  renderSettings();
  const input = document.querySelector(`[data-kind="${kind}"][data-id="${item.id}"] [data-field="name"]`);
  if (input) { input.focus(); input.select(); }
}

/** Remove a row from a settings list, with undo. */
function deleteSettingsItem(kind, id, label) {
  const list = state[COLLECTIONS[kind]];
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return;
  const [removed] = list.splice(index, 1);
  save();
  renderSettings();
  showToast(`Deleted ${label}`, () => {
    list.splice(index, 0, removed);
    save();
    render();
  });
}

/* ==========================================================================
   7. Adding / editing expenses
   ========================================================================== */

const expenseDialog = $('#expenseDialog');
const pauseDialog = $('#pauseDialog');
let editing = { id: null, fixedId: null }; // what the open sheet is editing
let onPauseConfirm = null;

/** Default date for a new expense: today, or the last day of a past cycle being viewed. */
function defaultDate() {
  const today = todayISO();
  const { start, end } = cycleInfo(viewKey);
  return today >= start && today <= end ? today : end;
}

function openExpenseDialog({ id = null, amount = '', categoryId, note = '', date, fixedId = null } = {}) {
  editing = { id, fixedId };
  $('#expenseTitle').textContent = id ? 'Edit expense' : fixedId ? 'Mark fixed cost charged' : 'Add expense';
  // New expenses default to the most recently used category.
  const lastCat = state.transactions.at(-1)?.categoryId;
  $('#fCategory').innerHTML = categoryOptions(categoryId || lastCat || state.categories[0]?.id);
  $('#fAmount').value = amount;
  $('#fNote').value = note;
  $('#fDate').value = date || defaultDate();
  $('#fDelete').hidden = !id;
  expenseDialog.showModal();
}

function openEditTxn(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (t) openExpenseDialog(t);
}

$('#expenseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = roundMoney(Number($('#fAmount').value));
  if (!(amount > 0)) { $('#fAmount').focus(); return; }
  const data = {
    amount,
    categoryId: $('#fCategory').value,
    note: $('#fNote').value.trim(),
    date: $('#fDate').value || todayISO(),
  };

  if (editing.id) {
    const t = state.transactions.find((x) => x.id === editing.id);
    if (t) Object.assign(t, data);
    save();
    expenseDialog.close();
    render();
    showToast('Saved');
    return;
  }

  const txn = { id: uid(), ...data, createdAt: Date.now() };
  if (editing.fixedId) txn.fixedId = editing.fixedId;
  requestAdd(txn, () => expenseDialog.close());
});

$('#fDelete').addEventListener('click', () => {
  const index = state.transactions.findIndex((x) => x.id === editing.id);
  if (index < 0) return;
  const [removed] = state.transactions.splice(index, 1);
  save();
  expenseDialog.close();
  render();
  showToast(`Deleted ${fmtExact(removed.amount)}`, () => {
    state.transactions.push(removed);
    save();
    render();
  });
});

/** Log a new expense — via the pause screen if it's a big one. */
function requestAdd(txn, onDone) {
  const commit = () => { addTransaction(txn); onDone?.(); };
  // Fixed costs were planned for, so they skip the pause.
  if (txn.amount >= PAUSE_THRESHOLD && !txn.fixedId) showPause(txn, commit);
  else commit();
}

function addTransaction(txn) {
  state.transactions.push(txn);
  save();
  render();
  showToast(`Logged ${fmtExact(txn.amount)} · ${txn.note || categoryName(txn.categoryId)}`, () => {
    state.transactions = state.transactions.filter((t) => t.id !== txn.id);
    save();
    render();
    showToast('Removed');
  });
}

/** "This is X days of your daily allowance. Still buy?" */
function showPause(txn, onConfirm) {
  const { allowance, daysLeft } = summarize(currentKey());
  $('#pauseAmount').textContent = fmtExact(txn.amount);
  if (allowance > 0) {
    const days = txn.amount / allowance;
    const shown = days >= 10 ? Math.round(days) : days.toFixed(1);
    $('#pauseText').textContent = `This is ${shown} days of your daily allowance. Still buy?`;
    $('#pauseSub').textContent = `Allowance: ${fmt(allowance)}/day for ${plural(daysLeft, 'day')}.`;
  } else {
    $('#pauseText').textContent = 'You have no daily allowance left this cycle. Still buy?';
    $('#pauseSub').textContent = '';
  }
  onPauseConfirm = onConfirm;
  pauseDialog.showModal();
  $('#pauseCancel').focus();
}

$('#pauseConfirm').addEventListener('click', () => {
  pauseDialog.close();
  const fn = onPauseConfirm;
  onPauseConfirm = null;
  fn?.();
});
$('#pauseCancel').addEventListener('click', () => {
  onPauseConfirm = null;
  pauseDialog.close();
});

// Tapping the dark backdrop closes the add/edit sheet.
expenseDialog.addEventListener('click', (e) => {
  if (e.target === expenseDialog) expenseDialog.close();
});

/* ==========================================================================
   8. Quick-add: tap logs the preset, long-press opens it in the sheet
   ========================================================================== */

function quickLog(presetId) {
  const p = state.presets.find((x) => x.id === presetId);
  if (!p) return;
  requestAdd({ id: uid(), amount: p.amount, categoryId: p.categoryId, note: p.name, date: todayISO(), createdAt: Date.now() });
}

function editPresetFirst(presetId) {
  const p = state.presets.find((x) => x.id === presetId);
  if (p) openExpenseDialog({ amount: p.amount, categoryId: p.categoryId, note: p.name, date: todayISO() });
}

(function setupQuickAdd() {
  const home = $('#view-home');
  let timer = null;
  let pressed = null; // { id, el, x, y }

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    pressed?.el.classList.remove('pressing');
    pressed = null;
  };

  home.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-preset]');
    if (!el || e.button > 0) return;
    pressed = { id: el.dataset.preset, el, x: e.clientX, y: e.clientY };
    el.classList.add('pressing');
    timer = setTimeout(() => {
      const id = pressed.id;
      cancel();
      navigator.vibrate?.(15);
      editPresetFirst(id);
    }, LONG_PRESS_MS);
  });

  home.addEventListener('pointermove', (e) => {
    // Finger moved (scrolling) — not a tap or a hold.
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 10) cancel();
  });

  home.addEventListener('pointerup', () => {
    if (!pressed || !timer) return; // long-press already fired
    const id = pressed.id;
    cancel();
    quickLog(id);
  });

  home.addEventListener('pointercancel', cancel);
  home.addEventListener('pointerleave', cancel);

  // Keyboard users: Enter/Space on a preset produces a click with detail 0.
  home.addEventListener('click', (e) => {
    const el = e.target.closest('[data-preset]');
    if (el && e.detail === 0) quickLog(el.dataset.preset);
  });

  // No context menu / text selection popup on long-press.
  home.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-preset]')) e.preventDefault();
  });
})();

/* ==========================================================================
   9. Toast with undo
   ========================================================================== */

const toast = $('#toast');
let toastTimer = null;
let toastUndo = null;

function showToast(message, undoFn = null) {
  toastUndo = undoFn;
  toast.innerHTML = `<span>${esc(message)}</span>${undoFn ? '<button data-action="undo">Undo</button>' : ''}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoFn ? 6000 : 2500);
}
function hideToast() {
  toast.hidden = true;
  toastUndo = null;
}

/* ==========================================================================
   10. Backup: export / import
   ========================================================================== */

function backupFile() {
  const data = { ...state, exportedAt: new Date().toISOString() };
  const name = `spend-logger-backup-${todayISO()}.json`;
  return new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
}

function markExported() {
  state.lastExport = new Date().toISOString();
  save();
  render();
  showToast('Backup exported');
}

/** Download the backup as a .json file. */
function exportDownload() {
  const file = backupFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markExported();
}

/** Send the backup via the phone's share sheet (e.g. to Drive or yourself). */
async function exportShare() {
  const file = backupFile();
  if (!navigator.canShare?.({ files: [file] })) return exportDownload();
  try {
    await navigator.share({ files: [file], title: 'Spend Logger backup' });
    markExported();
  } catch (err) {
    if (err.name !== 'AbortError') exportDownload();
  }
}

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow picking the same file again later
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.categories)) {
      throw new Error('This doesn’t look like a Spend Logger backup.');
    }
    const when = data.exportedAt ? fmtLongDate.format(new Date(data.exportedAt)) : 'an unknown date';
    const ok = confirm(`Replace all current data with the backup from ${when} (${plural(data.transactions.length, 'transaction')})?`);
    if (!ok) return;
    delete data.exportedAt;
    state = normalizeState(data);
    save();
    applyTheme();
    viewKey = currentKey();
    render();
    showToast('Backup restored');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
});

/* ==========================================================================
   11. Events & start-up
   ========================================================================== */

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = state.theme;
  const dark = state.theme === 'dark'
    || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').content = dark ? '#0e1116' : '#f5f6f8';
}

// One click handler for every [data-action] / [data-tab] button.
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    currentTab = tab.dataset.tab;
    window.scrollTo(0, 0);
    return render();
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  const row = el.closest('[data-kind]');

  switch (el.dataset.action) {
    case 'prev-cycle': viewKey = shiftCycle(viewKey, -1); render(); break;
    case 'next-cycle': if (viewKey < currentKey()) { viewKey = shiftCycle(viewKey, 1); render(); } break;
    case 'current-cycle': viewKey = currentKey(); render(); break;
    case 'add': openExpenseDialog(); break;
    case 'close-dialog': el.closest('dialog').close(); break;
    case 'undo': { const fn = toastUndo; hideToast(); fn?.(); break; }
    case 'edit-txn': openEditTxn(id); break;
    case 'mark-charged': {
      const f = state.fixedCosts.find((x) => x.id === id);
      if (f) openExpenseDialog({ amount: f.amount, categoryId: FIXED_ID, note: f.name, fixedId: f.id });
      break;
    }
    case 'add-category':
      addSettingsItem('category', { id: uid(), name: 'New category', budget: 500 });
      break;
    case 'delete-category': {
      const catId = row.dataset.id;
      const used = state.transactions.filter((t) => t.categoryId === catId).length
        + state.presets.filter((p) => p.categoryId === catId).length;
      if (used) { alert('This category is used by expenses or presets. Rename it instead.'); break; }
      deleteSettingsItem('category', catId, categoryName(catId));
      break;
    }
    case 'add-preset':
      addSettingsItem('preset', { id: uid(), name: 'New preset', amount: 100, categoryId: state.categories[0]?.id });
      break;
    case 'delete-preset':
      deleteSettingsItem('preset', row.dataset.id, 'preset');
      break;
    case 'add-fixed':
      addSettingsItem('fixed', { id: uid(), name: 'New fixed cost', amount: 500, recurring: false, cycle: currentKey() });
      break;
    case 'delete-fixed':
      deleteSettingsItem('fixed', row.dataset.id, 'fixed cost');
      break;
    case 'export-download': exportDownload(); break;
    case 'export-share': exportShare(); break;
    case 'import': $('#importFile').click(); break;
  }
});

$('#view-settings').addEventListener('change', onSettingsChange);

// Statement total for reconciliation — save as you type.
$('#view-history').addEventListener('input', (e) => {
  if (e.target.id !== 'stmtInput') return;
  const v = e.target.value;
  if (v === '') delete state.statements[viewKey];
  else if (Number(v) >= 0) state.statements[viewKey] = roundMoney(Number(v));
  save();
  $('#reconcileResult').innerHTML = reconcileText(summarize(viewKey), state.statements[viewKey]);
});
// Redraw the chart once editing is done (keeps the input focused while typing).
$('#view-history').addEventListener('change', (e) => {
  if (e.target.id === 'stmtInput') renderHistory();
});

// When the app comes back to the foreground, the date (or cycle) may have changed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const cur = currentKey();
  if (cur !== knownCurrent) {
    if (viewKey === knownCurrent) viewKey = cur;
    knownCurrent = cur;
  }
  if (currentTab !== 'settings') render(); // don't disturb an edit in progress
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Start
applyTheme();
save(); // writes seed data on first run
render();

// Ask the browser not to evict our localStorage under storage pressure.
navigator.storage?.persist?.();

// Offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('SW registration failed', err));
  });
}
