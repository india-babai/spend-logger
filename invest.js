'use strict';
/*
 * Investment Logger — a simple month-wise record of where income goes.
 *
 * Each entry belongs to a calendar month and is one of four types:
 *   income  (Salary 2.5L)   invest  (Groww SIP 80k)   save  (FD 20k)   bills  (Rent 25k)
 * The month screen shows income split into invested / saved / bills / left over,
 * plus a 6-month chart and a financial-year (Apr–Mar) summary.
 *
 * Loaded after app.js and reuses its helpers ($, esc, uid, fmt, fmtExact,
 * roundMoney, sumAmounts, plural, showToast, render, isoFrom, utcDate, …).
 * Data lives under its own localStorage key, separate from the spend data.
 */

/* ---------- Data ---------- */

const INVEST_KEY = 'investlogger.v1';

// Entry types in display order, with name suggestions for the Name field.
const INVEST_TYPES = {
  income: { label: 'Income', group: 'Income', suggestions: ['Salary', 'Bonus', 'Interest', 'Freelance'] },
  invest: { label: 'Investment', group: 'Investments', suggestions: ['Groww SIP', 'IndMoney', 'PPF', 'NPS', 'Stocks'] },
  save: { label: 'Savings', group: 'Savings', suggestions: ['FD', 'RD', 'Emergency fund', 'Savings account'] },
  bills: { label: 'Bills', group: 'Bills', suggestions: ['Credit card bill', 'Rent', 'Electricity', 'Home loan EMI', 'Insurance'] },
};

let investState = loadInvest();  // { version, entries: [{ id, month: 'YYYY-MM', type, name, amount, note, createdAt }] }
let investMonth = thisMonth();   // month being viewed
let investEditingId = null;      // entry open in the sheet (null = new)

function loadInvest() {
  try {
    const raw = localStorage.getItem(INVEST_KEY);
    if (raw) return normalizeInvest(JSON.parse(raw));
  } catch (err) {
    console.error('Could not read investment data', err);
  }
  return normalizeInvest({});
}

function normalizeInvest(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return { version: 1, entries: entries.filter((e) => e && INVEST_TYPES[e.type] && e.month) };
}

function saveInvest() {
  try {
    localStorage.setItem(INVEST_KEY, JSON.stringify(investState));
  } catch (err) {
    alert('Could not save — storage may be full. Export a backup now.');
    console.error(err);
  }
}

/** Used by import in app.js. */
function setInvestState(data) {
  investState = normalizeInvest(data);
  investMonth = thisMonth();
  saveInvest();
}

/* ---------- Months ---------- */

function thisMonth() {
  return todayISO().slice(0, 7);
}
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  return isoFrom(y, m - 1 + n, 1).slice(0, 7);
}
const fmtMonthYear = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (month) => fmtMonthYear.format(utcDate(`${month}-01`));
const monthName = (month) => fmtMonth.format(utcDate(`${month}-01`));

/** First month of the Indian financial year (April–March) containing `month`. */
function fyStart(month) {
  const [y, m] = month.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04`;
}

/** ₹2.5L, ₹80k, ₹1.2Cr — compact Indian style for labels. */
function fmtLakh(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const short = (x) => String(Number(x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)));
  if (a >= 1e7) return `${sign}₹${short(a / 1e7)}Cr`;
  if (a >= 1e5) return `${sign}₹${short(a / 1e5)}L`;
  if (a >= 1e3) return `${sign}₹${short(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

/* ---------- Calculations ---------- */

/** Totals for a list of entries. `rate` = share of income invested or saved (bills don't count). */
function totals(entries) {
  const by = (type) => sumAmounts(entries.filter((e) => e.type === type));
  const income = by('income');
  const invested = by('invest');
  const saved = by('save');
  const bills = by('bills');
  return {
    entries, income, invested, saved, bills,
    outflow: roundMoney(invested + saved + bills),
    remaining: roundMoney(income - invested - saved - bills),
    rate: income > 0 ? ((invested + saved) / income) * 100 : null,
  };
}

const monthSummary = (month) => totals(investState.entries.filter((e) => e.month === month));

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '');

/** Invested / saved / bills / left-over split bar. Scaled to income (or to outflow if that's bigger). */
function splitBar(s, extraClass = '') {
  const base = Math.max(s.income, s.outflow);
  if (!base) return `<div class="split-bar ${extraClass}"></div>`;
  const w = (v) => `${(Math.max(0, v) / base) * 100}%`;
  return `<div class="split-bar ${extraClass}" aria-hidden="true">
    <span class="seg invest" style="width:${w(s.invested)}"></span>
    <span class="seg save" style="width:${w(s.saved)}"></span>
    <span class="seg bills" style="width:${w(s.bills)}"></span></div>`;
}

/** One-line summary + bar for the landing page. */
function investLandingInfo() {
  const month = thisMonth();
  const s = monthSummary(month);
  if (!s.entries.length) {
    return { text: `Nothing logged for ${monthName(month)} yet`, barHtml: splitBar(s) };
  }
  const text = s.income > 0
    ? `${monthName(month)}: ${fmtLakh(s.invested + s.saved)} of ${fmtLakh(s.income)} put away · ${pct(s.invested + s.saved, s.income)}`
    : `${monthName(month)}: ${fmtLakh(s.invested + s.saved)} put away`;
  return { text, barHtml: splitBar(s) };
}

/* ---------- Rendering ---------- */

function renderInvest() {
  // Month switcher in the top bar
  const isCurrent = investMonth === thisMonth();
  $('#monthLabel').textContent = monthLabel(investMonth);
  $('#monthSub').textContent = isCurrent ? 'This month' : 'Tap for this month';
  $('#monthSub').classList.toggle('past', !isCurrent);
  $('#nextMonthBtn').disabled = investMonth >= thisMonth();

  const s = monthSummary(investMonth);
  let html = '';

  // 1. Where the income went
  const leftLabel = s.remaining >= 0 ? 'Left over' : 'More than income by';
  html += `
    <div class="card">
      <div class="card-head">
        <span class="stat-label">Income</span>
        ${s.rate != null ? `<span class="pill">${Math.round(s.rate)}% put away</span>` : ''}
      </div>
      <div class="meter-amount num">${fmt(s.income)}</div>
      ${splitBar(s, 'thick')}
      <div class="legend-row"><span class="dot invest"></span><span class="grow">Invested</span>
        <span class="num">${fmt(s.invested)}</span><span class="pct num">${pct(s.invested, s.income)}</span></div>
      <div class="legend-row"><span class="dot save"></span><span class="grow">Saved</span>
        <span class="num">${fmt(s.saved)}</span><span class="pct num">${pct(s.saved, s.income)}</span></div>
      <div class="legend-row"><span class="dot bills"></span><span class="grow">Bills</span>
        <span class="num">${fmt(s.bills)}</span><span class="pct num">${pct(s.bills, s.income)}</span></div>
      <div class="legend-row"><span class="dot rest"></span><span class="grow">${leftLabel}</span>
        <span class="num ${s.remaining < 0 ? 'warn-text' : ''}">${fmt(Math.abs(s.remaining))}</span>
        <span class="pct num">${s.remaining >= 0 ? pct(s.remaining, s.income) : ''}</span></div>
    </div>`;

  // 2. One-tap repeats of last month's entries that aren't logged yet this month
  const prevMonth = shiftMonth(investMonth, -1);
  const have = new Set(s.entries.map(entryKey));
  const missing = monthSummary(prevMonth).entries.filter((e) => !have.has(entryKey(e)));
  if (missing.length) {
    html += `
      <div class="card">
        <div class="card-head"><h2>From ${monthName(prevMonth)}</h2><span class="hint">Tap to log again</span></div>
        <div class="chips">
          ${missing.map((e) => `<button class="chip ${e.type}" data-action="inv-repeat" data-id="${esc(e.id)}">
            + ${esc(e.name)} <span class="muted num">${fmtLakh(e.amount)}</span></button>`).join('')}
        </div>
        ${missing.length > 1 ? `<div class="settings-actions"><button class="btn small" data-action="inv-repeat-all">
          Add all ${missing.length}</button></div>` : ''}
      </div>`;
  }

  // 3. Entries, grouped by type
  if (!s.entries.length) {
    html += `<div class="card empty">Nothing logged for ${esc(monthLabel(investMonth))} yet.<br>
      Tap <strong>+ Add</strong> to log your salary, SIPs and savings.</div>`;
  }
  if (s.entries.length) html += `<p class="hint list-hint">Tap an entry to edit or delete it.</p>`;
  for (const [type, info] of Object.entries(INVEST_TYPES)) {
    const list = s.entries.filter((e) => e.type === type).sort((a, b) => b.amount - a.amount);
    if (!list.length) continue;
    html += `<div class="day-head"><span>${info.group}</span><span class="num">${fmtExact(sumAmounts(list))}</span></div>
      <div class="card txn-group">
        ${list.map((e) => `<button class="txn" data-action="inv-edit" data-id="${esc(e.id)}">
          <span class="dot ${type}"></span>
          <span class="txn-main"><span class="txn-title">${esc(e.name)}</span>
          ${e.note ? `<span class="txn-sub">${esc(e.note)}</span>` : ''}</span>
          <span class="txn-amt num">${fmtExact(e.amount)}</span>
          <span class="txn-chev" aria-hidden="true">›</span></button>`).join('')}
      </div>`;
  }

  // 4. Trend + financial-year summary
  const fy = fyStart(investMonth);
  const fyEntries = investState.entries.filter((e) => e.month >= fy && e.month <= investMonth);
  const y = totals(fyEntries);
  const fyLabel = `FY ${fy.slice(0, 4)}–${String(Number(fy.slice(0, 4)) + 1).slice(2)}`;
  html += `
    <div class="card">
      <h2>Last 6 months</h2>
      ${renderInvestChart(investMonth)}
    </div>
    <div class="card stat-list">
      <div class="stat"><span class="stat-label">${fyLabel} income (to ${monthName(investMonth)})</span>
        <span class="stat-value num">${fmt(y.income)}</span></div>
      <div class="stat"><span class="stat-label">Invested</span><span class="stat-value num">${fmt(y.invested)}</span></div>
      <div class="stat"><span class="stat-label">Saved</span><span class="stat-value num">${fmt(y.saved)}</span></div>
      <div class="stat"><span class="stat-label">Bills</span><span class="stat-value num">${fmt(y.bills)}</span></div>
      <div class="stat"><span class="stat-label">Put away</span>
        <span class="stat-value num">${y.rate != null ? `${Math.round(y.rate)}%` : '—'}</span></div>
    </div>`;

  $('#view-invest').innerHTML = html;
}

/** Entries count as "the same" across months if type and name match. */
const entryKey = (e) => `${e.type}|${e.name.trim().toLowerCase()}`;

/** Inline SVG: income as a pale bar, invested + saved + bills stacked inside it. */
function renderInvestChart(endMonth) {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(endMonth, -i));
  const data = months.map((m) => ({ month: m, ...monthSummary(m) }));

  const W = 340, H = 190, top = 22, bottom = 26, side = 6;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.outflow))) * 1.08;
  const slot = (W - side * 2) / data.length;
  const barW = slot * 0.58;
  const h = (v) => (v / max) * plotH;
  const base = top + plotH;

  let svg = '';
  data.forEach((d, i) => {
    const x = side + slot * i + slot / 2 - barW / 2;
    const cx = x + barW / 2;
    const hi = h(d.income), hv = h(d.invested), hs = h(d.saved), hb = h(d.bills);
    const selected = d.month === endMonth ? ' bar-selected' : '';
    svg += `<rect class="inc-bar${selected}" x="${x}" y="${base - hi}" width="${barW}" height="${hi}" rx="4">
      <title>${monthLabel(d.month)}: income ${fmt(d.income)}</title></rect>`;
    svg += `<rect class="inv-bar" x="${x}" y="${base - hv}" width="${barW}" height="${hv}" rx="${hv > 8 ? 4 : 0}">
      <title>Invested ${fmt(d.invested)}</title></rect>`;
    svg += `<rect class="sav-bar" x="${x}" y="${base - hv - hs}" width="${barW}" height="${hs}">
      <title>Saved ${fmt(d.saved)}</title></rect>`;
    svg += `<rect class="bill-bar" x="${x}" y="${base - hv - hs - hb}" width="${barW}" height="${hb}">
      <title>Bills ${fmt(d.bills)}</title></rect>`;
    if (d.rate != null) {
      const topY = base - Math.max(hi, hv + hs + hb);
      svg += `<text class="value-label" x="${cx}" y="${topY - 5}" text-anchor="middle">${Math.round(d.rate)}%</text>`;
    }
    svg += `<text class="axis-label" x="${cx}" y="${H - 8}" text-anchor="middle">${monthName(d.month)}</text>`;
  });

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income, invested, saved and bills for the last 6 months">${svg}</svg>
    <div class="chart-legend">
      <span><span class="dot income"></span>Income</span>
      <span><span class="dot invest"></span>Invested</span>
      <span><span class="dot save"></span>Saved</span>
      <span><span class="dot bills"></span>Bills</span>
    </div>
    <p class="hint">The % above each bar is the share of income invested or saved.</p>`;
}

/* ---------- Add / edit sheet ---------- */

const investDialog = $('#investDialog');

function selectedInvestType() {
  return document.querySelector('input[name="invType"]:checked')?.value || 'invest';
}

/** Name suggestions: names already used for this type (most recent first), then defaults. */
function fillNameSuggestions(type) {
  const used = [...investState.entries]
    .filter((e) => e.type === type)
    .sort((a, b) => b.month.localeCompare(a.month) || (b.createdAt || 0) - (a.createdAt || 0))
    .map((e) => e.name);
  const names = [...new Set([...used, ...INVEST_TYPES[type].suggestions])];
  $('#iNames').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function updateAmountHint() {
  const v = Number($('#iAmount').value);
  $('#iAmountHint').textContent = v > 0 ? `${fmtExact(v)} · ${fmtLakh(v)}` : '';
}

function openInvestDialog({ id = null, type = 'invest', name = '', amount = '', note = '', month = investMonth } = {}) {
  investEditingId = id;
  $('#investTitle').textContent = id ? 'Edit entry' : 'Add entry';
  document.querySelector(`input[name="invType"][value="${type}"]`).checked = true;
  fillNameSuggestions(type);
  $('#iName').value = name;
  $('#iAmount').value = amount;
  $('#iMonth').value = month;
  $('#iNote').value = note;
  $('#iDelete').hidden = !id;
  updateAmountHint();
  investDialog.showModal();
}

$('#investForm').addEventListener('change', (e) => {
  if (e.target.name === 'invType') fillNameSuggestions(e.target.value);
  // Picking a name used before fills in its last amount (if the amount is still empty).
  if (e.target.id === 'iName' && !$('#iAmount').value) {
    const name = e.target.value.trim().toLowerCase();
    const last = [...investState.entries]
      .filter((x) => x.name.trim().toLowerCase() === name)
      .sort((a, b) => b.month.localeCompare(a.month))[0];
    if (last) {
      $('#iAmount').value = last.amount;
      document.querySelector(`input[name="invType"][value="${last.type}"]`).checked = true;
      updateAmountHint();
    }
  }
});
$('#iAmount').addEventListener('input', updateAmountHint);

$('#investForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = roundMoney(Number($('#iAmount').value));
  if (!(amount > 0)) { $('#iAmount').focus(); return; }
  const type = selectedInvestType();
  const data = {
    type,
    name: $('#iName').value.trim() || INVEST_TYPES[type].label,
    amount,
    note: $('#iNote').value.trim(),
    month: /^\d{4}-\d{2}$/.test($('#iMonth').value) ? $('#iMonth').value : investMonth,
  };

  if (investEditingId) {
    const entry = investState.entries.find((x) => x.id === investEditingId);
    if (entry) Object.assign(entry, data);
    saveInvest();
    investDialog.close();
    render();
    showToast('Saved');
    return;
  }

  const entry = { id: uid(), ...data, createdAt: Date.now() };
  investState.entries.push(entry);
  saveInvest();
  investDialog.close();
  render();
  showToast(`Logged ${fmtLakh(entry.amount)} · ${entry.name}`, () => removeInvestEntries([entry.id]));
});

$('#iDelete').addEventListener('click', () => {
  const index = investState.entries.findIndex((x) => x.id === investEditingId);
  if (index < 0) return;
  const [removed] = investState.entries.splice(index, 1);
  saveInvest();
  investDialog.close();
  render();
  showToast(`Deleted ${removed.name}`, () => {
    investState.entries.push(removed);
    saveInvest();
    render();
  });
});

investDialog.addEventListener('click', (e) => {
  if (e.target === investDialog) investDialog.close();
});

function removeInvestEntries(ids) {
  investState.entries = investState.entries.filter((x) => !ids.includes(x.id));
  saveInvest();
  render();
  showToast('Removed');
}

/** Copy entries (from last month) into the month being viewed, with undo. */
function repeatEntries(entries) {
  const copies = entries.map((e) => ({
    id: uid(), type: e.type, name: e.name, amount: e.amount, note: e.note || '', month: investMonth, createdAt: Date.now(),
  }));
  investState.entries.push(...copies);
  saveInvest();
  render();
  const msg = copies.length === 1 ? `Logged ${fmtLakh(copies[0].amount)} · ${copies[0].name}` : `Logged ${copies.length} entries`;
  showToast(msg, () => removeInvestEntries(copies.map((c) => c.id)));
}

/* ---------- Events ---------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="inv-"]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'inv-prev-month': investMonth = shiftMonth(investMonth, -1); render(); break;
    case 'inv-next-month': if (investMonth < thisMonth()) { investMonth = shiftMonth(investMonth, 1); render(); } break;
    case 'inv-this-month': investMonth = thisMonth(); render(); break;
    case 'inv-edit': {
      const entry = investState.entries.find((x) => x.id === el.dataset.id);
      if (entry) openInvestDialog(entry);
      break;
    }
    case 'inv-repeat': {
      const entry = investState.entries.find((x) => x.id === el.dataset.id);
      if (entry) repeatEntries([entry]);
      break;
    }
    case 'inv-repeat-all': {
      const s = monthSummary(investMonth);
      const have = new Set(s.entries.map(entryKey));
      repeatEntries(monthSummary(shiftMonth(investMonth, -1)).entries.filter((x) => !have.has(entryKey(x))));
      break;
    }
  }
});
