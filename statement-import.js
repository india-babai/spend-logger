'use strict';
/*
 * Import from statement — log past spends by pasting a table.
 *
 * Flow: copy the prompt → paste it into a Claude chat with your statement
 * screenshots → copy Claude's table → paste it here → review → import.
 *
 * Accepts a markdown table (what Claude's copy button gives), tab-separated
 * rows (what copying a rendered table gives) or CSV. Optional lines
 * "STATEMENT_DATE: …" and "STATEMENT_TOTAL: …" fill in the reconcile total.
 *
 * Loaded after app.js and reuses its helpers and state.
 */

const importDialog = $('#importDialog');
let importRows = [];    // [{ date, note, amount, categoryId, include, dup, guessed }]
let importSkipped = []; // lines that looked like rows but couldn't be read
let importMeta = {};    // { statementDate, statementTotal, useTotal }

/* ---------- The prompt for Claude ---------- */

/** Category used when Claude's category doesn't match one of ours. */
function fallbackCategory() {
  return state.categories.find((c) => c.id === 'shopping')
    ?? state.categories.find((c) => c.id !== FIXED_ID)
    ?? state.categories[0];
}

/** Built from the current category names, so Claude uses exactly those. */
function buildStatementPrompt() {
  const fixedName = categoryName(FIXED_ID);
  const fallback = fallbackCategory().name;
  return [
    'I\'ve attached screenshots of my credit card statement. Extract every transaction in the exact format below so I can paste it into my spend tracker.',
    '',
    'Output rules:',
    '1. Output ONE markdown table with exactly these 4 columns, in this order:',
    '   | Date | Description | Amount | Category |',
    '2. Date: YYYY-MM-DD, using the transaction date (not the posting date). If the year isn\'t shown, infer it from the statement period.',
    '3. Description: the merchant name, cleaned up and short (40 characters max). Never use the "|" character.',
    '4. Amount: a plain number in rupees with no ₹ symbol and no commas, up to 2 decimals (e.g. 1234.50).',
    '   - Purchases, EMI instalments, fees, interest and GST: positive.',
    '   - Refunds, reversals and cashback: negative (e.g. -250).',
    '   - Leave out payments made to the card (e.g. "Payment received", "BBPS payment", "Thank you").',
    '   - Foreign-currency spends: use the INR amount charged.',
    '5. Category: exactly one of these names, spelled exactly as written:',
    ...state.categories.map((c) => `   - ${c.name}`),
    `   Use "${fixedName}" for EMIs, subscriptions and recharges. If unsure, use "${fallback}".`,
    '6. One row per transaction, in date order. Don\'t merge, skip or summarise rows.',
    '7. After the table, add these two lines (leave out a line if the value isn\'t on the statement):',
    '   STATEMENT_DATE: YYYY-MM-DD',
    '   STATEMENT_TOTAL: <total amount due, plain number>',
    '8. No other text before or after.',
    '',
    'Before answering, check that the number of rows and the sum of the Amount column match the statement.',
  ].join('\n');
}

/* ---------- Parsing ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Valid 'YYYY-MM-DD' or null (rejects things like 31 Feb). */
function makeDate(y, m, d) {
  if (y < 100) y += 2000;
  const iso = isoFrom(y, m, d);
  return iso === `${y}-${pad2(m + 1)}-${pad2(d)}` ? iso : null;
}

/** 2026-10-25, 25/10/2026, 25-10-26, 25 Oct 2026, 25-Oct-26. Slashes are read as day/month (Indian style). */
function parseDateLoose(s) {
  s = s.trim().replace(/,/g, ' ');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return makeDate(+m[1], m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return makeDate(+m[3], m[2] - 1, +m[1]);
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (month >= 0) return makeDate(+m[3], month, +m[1]);
  }
  return null;
}

/** "1,234.50", "₹1234", "-250", "250 Cr", "(250)" → number (credits negative). */
function parseAmountLoose(s) {
  let t = s.replace(/[−–]/g, '-').replace(/₹|rs\.?|inr/gi, '').replace(/[,\s*]/g, '');
  let sign = 1;
  if (/cr$/i.test(t)) { sign = -1; t = t.slice(0, -2); } else if (/dr$/i.test(t)) t = t.slice(0, -2);
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && n !== 0 ? roundMoney(sign * n) : null;
}

/** Split one CSV line, honouring "quoted, fields". */
function splitCsv(line) {
  const cells = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && quoted) { cur += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Turn a line into cells, or null if it isn't a table row. */
function lineToCells(line) {
  let cells;
  if (line.includes('|')) cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
  else if (line.includes('\t')) cells = line.split('\t');
  else if (line.split(',').length >= 3) cells = splitCsv(line);
  else return null;
  // Strip markdown emphasis/code marks around cell values.
  return cells.map((c) => c.trim().replace(/^[*_`]+|[*_`]+$/g, '').trim());
}

/** Match Claude's category text to one of ours. */
function matchCategory(text) {
  const t = (text || '').trim().toLowerCase();
  const exact = state.categories.find((c) => c.name.toLowerCase() === t);
  if (exact) return { id: exact.id, guessed: false };
  const loose = t && state.categories.find((c) => c.name.toLowerCase().includes(t) || t.includes(c.name.toLowerCase()));
  if (loose) return { id: loose.id, guessed: false };
  return { id: fallbackCategory().id, guessed: true };
}

function parseStatementText(text) {
  const rows = [];
  const skipped = [];
  const meta = {};
  // Column positions; replaced by the header row if there is one.
  let col = { date: 0, desc: 1, amount: 2, cat: 3 };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Tolerates markdown bold/code and escaped underscores (STATEMENT\_DATE).
    const metaMatch = line.replace(/[*`\\]/g, '').match(/^STATEMENT[_\s]?(DATE|TOTAL)\s*[:=]\s*(.+)$/i);
    if (metaMatch) {
      if (metaMatch[1].toUpperCase() === 'DATE') meta.statementDate = parseDateLoose(metaMatch[2]);
      else meta.statementTotal = parseAmountLoose(metaMatch[2]);
      continue;
    }

    const cells = lineToCells(line);
    if (!cells || cells.length < 3) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // markdown |---|---|

    // Header row ("Date", "Transaction Date", …): work out which column is which.
    const isHeader = cells.some((c) => /\bdate\b/i.test(c))
      && cells.some((c) => /amount|amt/i.test(c))
      && !cells.some((c) => parseDateLoose(c) || parseAmountLoose(c) != null);
    if (isHeader) {
      const find = (re, fallback) => { const i = cells.findIndex((c) => re.test(c)); return i >= 0 ? i : fallback; };
      col = {
        date: find(/date/i, 0),
        desc: find(/desc|merchant|detail|narration|particular/i, 1),
        amount: find(/amount|amt|inr|₹/i, 2),
        cat: find(/categ/i, 3),
      };
      continue;
    }

    const date = parseDateLoose(cells[col.date] || '');
    const amount = parseAmountLoose(cells[col.amount] || '');
    if (!date || amount == null) { skipped.push(line); continue; }
    const cat = matchCategory(cells[col.cat]);
    rows.push({
      date,
      note: (cells[col.desc] || '').slice(0, 80),
      amount,
      categoryId: cat.id,
      guessed: cat.guessed,
    });
  }

  // Probable duplicates: an expense already logged with the same date and amount.
  for (const r of rows) {
    r.dup = state.transactions.some((t) => t.date === r.date && Math.abs(t.amount - r.amount) < 0.01);
    r.include = !r.dup;
  }
  return { rows, skipped, meta };
}

/* ---------- Review screen ---------- */

/** Cycle the statement total belongs to: from STATEMENT_DATE, else the latest row. */
function statementCycle() {
  if (importMeta.statementDate) return cycleKeyFor(importMeta.statementDate);
  const latest = importRows.reduce((m, r) => (r.date > m ? r.date : m), '');
  return latest ? cycleKeyFor(latest) : currentKey();
}

function renderImportPreview() {
  const el = $('#importPreview');
  const pasted = $('#importText').value.trim();
  if (!importRows.length) {
    el.innerHTML = pasted
      ? `<p class="hint warn-text">No transactions found. Paste the table with its Date, Description, Amount and Category columns.</p>`
      : '';
    return;
  }

  const dupCount = importRows.filter((r) => r.dup).length;
  const guessCount = importRows.filter((r) => r.guessed).length;
  let html = `<h2 class="imp-heading">3. Review ${plural(importRows.length, 'row')}</h2>`;

  if (importSkipped.length) {
    html += `<details class="hint warn-text imp-note"><summary>${plural(importSkipped.length, 'line')} couldn’t be read and will be skipped</summary>
      ${importSkipped.map((l) => `<div class="imp-skipped">${esc(l)}</div>`).join('')}</details>`;
  }
  if (dupCount) {
    const one = dupCount === 1;
    html += `<p class="hint imp-note">${plural(dupCount, 'row')} ${one ? 'matches' : 'match'} an expense you’ve already logged
      (same date and amount), so ${one ? 'it’s' : 'they’re'} unticked.</p>`;
  }
  if (guessCount) {
    const one = guessCount === 1;
    html += `<p class="hint imp-note">${plural(guessCount, 'row')} had an unknown category, so ${one ? 'it was' : 'they were'}
      put in ${esc(fallbackCategory().name)}. Check below.</p>`;
  }
  if (importMeta.statementTotal != null) {
    html += `<label class="imp-stmt"><input type="checkbox" id="impUseTotal" ${importMeta.useTotal ? 'checked' : ''}>
      <span>Also save statement total <strong>${fmtExact(importMeta.statementTotal)}</strong>
      for the ${esc(cycleLabelYear(statementCycle()))} cycle</span></label>`;
  }

  html += importRows.map((r, i) => `
    <div class="imp-row ${r.include ? '' : 'off'}" data-index="${i}">
      <input type="checkbox" class="imp-check" data-row="${i}" ${r.include ? 'checked' : ''} aria-label="Include ${esc(r.note)}">
      <div class="imp-main">
        <div class="imp-top"><span class="imp-desc">${esc(r.note || '—')}</span>
          <span class="num ${r.amount < 0 ? 'ok-text' : ''}">${fmtExact(r.amount)}</span></div>
        <div class="imp-bottom">
          <span class="hint">${fmtWeekday.format(utcDate(r.date))} ${r.date.slice(0, 4)}</span>
          <select data-row-cat="${i}" aria-label="Category">${categoryOptions(r.categoryId)}</select>
        </div>
        ${r.dup ? '<span class="tag">Possible duplicate</span>' : ''}
        ${r.guessed ? '<span class="tag">Check category</span>' : ''}
      </div>
    </div>`).join('');

  html += `<div class="import-footer"><span id="impSummary" class="num"></span>
    <button type="button" class="btn primary" id="impGo" data-action="do-import">Import</button></div>`;

  el.innerHTML = html;
  updateImportSummary();
}

/** Footer: "12 selected · ₹8,450 · 1 cycle". Updated without re-rendering the list. */
function updateImportSummary() {
  const chosen = importRows.filter((r) => r.include);
  const cycles = new Set(chosen.map((r) => cycleKeyFor(r.date))).size;
  $('#impSummary').textContent = chosen.length
    ? `${chosen.length} selected · ${fmtExact(sumAmounts(chosen))} · ${plural(cycles, 'cycle')}`
    : 'Nothing selected';
  $('#impGo').disabled = !chosen.length;
  $('#impGo').textContent = chosen.length ? `Import ${chosen.length}` : 'Import';
}

function openImportDialog() {
  $('#promptText').value = buildStatementPrompt();
  $('#importText').value = '';
  $('#copyStatus').textContent = '';
  // Which card the statement is from; applied to every imported row.
  $('#importSource').innerHTML = sourceOptions(lastSourceId());
  importRows = [];
  importSkipped = [];
  importMeta = {};
  renderImportPreview();
  importDialog.showModal();
}

async function copyPrompt() {
  const text = buildStatementPrompt();
  try {
    await navigator.clipboard.writeText(text);
    $('#copyStatus').textContent = 'Copied ✓ Now paste it into Claude with your screenshots.';
  } catch {
    // Clipboard blocked: show the prompt selected so it can be copied by hand.
    const details = $('#promptDetails');
    details.open = true;
    $('#promptText').select();
    $('#copyStatus').textContent = 'Select the prompt below and copy it.';
  }
}

/** Add the ticked rows as expenses (and the statement total if chosen), with undo. */
function doImport() {
  const chosen = importRows.filter((r) => r.include);
  if (!chosen.length) return;
  const addedIds = [];
  const sourceId = $('#importSource').value;

  for (const r of chosen) {
    const txn = { id: uid(), amount: r.amount, categoryId: r.categoryId, sourceId, note: r.note, date: r.date, createdAt: Date.now() };
    // An imported EMI/recharge that matches a pending fixed cost (±₹1) marks it as charged,
    // so it isn't counted twice.
    if (txn.categoryId === FIXED_ID) {
      const key = cycleKeyFor(txn.date);
      const { start, end } = cycleInfo(key);
      const linked = new Set(state.transactions.filter((t) => t.fixedId && t.date >= start && t.date <= end).map((t) => t.fixedId));
      const match = fixedCostsFor(key).find((f) => !linked.has(f.id) && Math.abs(f.amount - txn.amount) <= 1);
      if (match) txn.fixedId = match.id;
    }
    state.transactions.push(txn);
    addedIds.push(txn.id);
  }

  let stmtKey = null;
  let prevStmt;
  if (importMeta.statementTotal != null && importMeta.useTotal) {
    stmtKey = statementCycle();
    prevStmt = state.statements[stmtKey];
    state.statements[stmtKey] = importMeta.statementTotal;
  }
  save();
  importDialog.close();

  // Show the imported cycle in History.
  const latest = chosen.reduce((m, r) => (r.date > m ? r.date : m), chosen[0].date);
  viewKey = stmtKey || cycleKeyFor(latest);
  if (viewKey > currentKey()) viewKey = currentKey();
  currentTab = 'history';
  render();

  showToast(`Imported ${plural(addedIds.length, 'expense')}`, () => {
    state.transactions = state.transactions.filter((t) => !addedIds.includes(t.id));
    if (stmtKey) {
      if (prevStmt == null) delete state.statements[stmtKey];
      else state.statements[stmtKey] = prevStmt;
    }
    save();
    render();
    showToast('Import undone');
  });
}

/* ---------- Events ---------- */

let parseTimer = null;
$('#importText').addEventListener('input', () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    const result = parseStatementText($('#importText').value);
    importRows = result.rows;
    importSkipped = result.skipped;
    importMeta = { ...result.meta, useTotal: result.meta.statementTotal != null };
    renderImportPreview();
  }, 250);
});

$('#importPreview').addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'impUseTotal') { importMeta.useTotal = el.checked; return; }
  if (el.dataset.row != null) {
    const row = importRows[el.dataset.row];
    row.include = el.checked;
    el.closest('.imp-row').classList.toggle('off', !el.checked);
    updateImportSummary();
  }
  if (el.dataset.rowCat != null) {
    importRows[el.dataset.rowCat].categoryId = el.value;
    importRows[el.dataset.rowCat].guessed = false;
  }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'open-import') openImportDialog();
  if (el.dataset.action === 'copy-prompt') copyPrompt();
  if (el.dataset.action === 'do-import') doImport();
});
