'use strict';
/*
 * Lending Tracker — who owes you money, and how it has moved over time.
 *
 * Each entry is one movement of money with one person:
 *   gave      you lent / paid them        → their balance goes up
 *   received  they paid you back          → their balance goes down
 * Balance > 0: they owe you. Balance < 0: you owe them. 0: settled.
 *
 * Repayments are matched to the oldest unpaid amounts first. That gives
 * "outstanding since", and lets an optional "expected back by" date on a
 * loan flag the person as overdue once that date has passed.
 *
 * Screens: '#lend' = list of people, '#lend/<personId>' = one person.
 * Loaded after app.js and reuses its helpers ($, esc, uid, fmt, fmtExact,
 * roundMoney, sumAmounts, showToast, render, todayISO, dayNumber, …).
 * Data lives under its own localStorage key.
 */

/* ---------- Data ---------- */

const LEND_KEY = 'lendlogger.v1';

// { version, people: [{ id, name, createdAt }],
//   entries: [{ id, personId, type: 'gave' | 'received', amount, date, dueDate?, note, createdAt }] }
let lendState = loadLend();
let lendEditingId = null;        // entry open in the sheet (null = new)

function loadLend() {
  try {
    const raw = localStorage.getItem(LEND_KEY);
    if (raw) return normalizeLend(JSON.parse(raw));
  } catch (err) {
    console.error('Could not read lending data', err);
  }
  return normalizeLend({});
}

function normalizeLend(data) {
  return {
    version: 1,
    people: (Array.isArray(data?.people) ? data.people : []).filter((p) => p && p.id && p.name),
    entries: (Array.isArray(data?.entries) ? data.entries : [])
      .filter((e) => e && e.personId && (e.type === 'gave' || e.type === 'received') && e.amount > 0),
  };
}

function saveLend() {
  try {
    localStorage.setItem(LEND_KEY, JSON.stringify(lendState));
  } catch (err) {
    alert('Could not save — storage may be full. Export a backup now.');
    console.error(err);
  }
}

/** Used by import in app.js. */
function setLendState(data) {
  lendState = normalizeLend(data);
  saveLend();
}

const personById = (id) => lendState.people.find((p) => p.id === id);

/** The person in '#lend/<id>', or null on the list screen. */
function lendPersonFromHash() {
  const [base, id] = location.hash.slice(1).split('/');
  return base === 'lend' && id ? personById(decodeURIComponent(id)) ?? null : null;
}

/* ---------- Formatting ---------- */

const peopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const daysAgo = (iso) => dayNumber(todayISO()) - dayNumber(iso);

/** "12 Oct", or "12 Oct 2025" when not this year. */
function shortDate(iso) {
  const label = fmtDayMonth.format(utcDate(iso));
  return iso.slice(0, 4) === todayISO().slice(0, 4) ? label : `${label} ${iso.slice(0, 4)}`;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/* ---------- Calculations ---------- */

/** Everything about one person: running balance per entry, totals, dates, status. */
function ledger(personId) {
  const list = lendState.entries
    .filter((e) => e.personId === personId)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  const today = todayISO();

  let balance = 0;
  let credit = 0;   // received beyond what was owed (you owe them)
  const open = [];  // unpaid parts of what you gave, oldest first
  const rows = [];

  for (const e of list) {
    if (e.type === 'gave') {
      balance += e.amount;
      const used = Math.min(credit, e.amount); // first cancels anything you owed them
      credit -= used;
      if (e.amount - used > 0.004) open.push({ entry: e, remaining: e.amount - used });
    } else {
      balance -= e.amount;
      let left = e.amount; // pays off the oldest amounts first
      while (left > 0.004 && open.length) {
        const o = open[0];
        const paid = Math.min(o.remaining, left);
        o.remaining -= paid;
        left -= paid;
        if (o.remaining <= 0.004) open.shift();
      }
      credit += left;
    }
    rows.push({ ...e, balance: roundMoney(balance) });
  }

  balance = roundMoney(balance);
  const dues = open.map((o) => o.entry.dueDate).filter(Boolean).sort();
  return {
    rows,
    count: list.length,
    gave: sumAmounts(list.filter((e) => e.type === 'gave')),
    received: sumAmounts(list.filter((e) => e.type === 'received')),
    balance,
    since: balance > 0 && open.length ? open[0].entry.date : null,  // oldest unpaid amount
    firstOverdue: balance > 0 ? dues.find((d) => d < today) ?? null : null,
    nextDue: balance > 0 ? dues.find((d) => d >= today) ?? null : null,
    lastDate: list.at(-1)?.date ?? null,
  };
}

/** Label + colour class for a person's state. */
function lendStatus(l) {
  if (!l.count) return { key: 'none', label: 'No entries yet', cls: 'muted' };
  if (l.balance > 0) {
    return l.firstOverdue
      ? { key: 'overdue', label: 'Overdue', cls: 'over-text' }
      : { key: 'owes', label: 'Owes you', cls: 'warn-text' };
  }
  if (l.balance < 0) return { key: 'iowe', label: 'You owe', cls: 'lend-text' };
  return { key: 'settled', label: 'Settled', cls: 'ok-text' };
}

function lendOverview() {
  const people = lendState.people.map((p) => ({ p, l: ledger(p.id) }));
  const owed = people.filter((x) => x.l.balance > 0);
  const iOwe = people.filter((x) => x.l.balance < 0);
  return {
    people,
    owed,
    iOwe,
    outstanding: roundMoney(owed.reduce((s, x) => s + x.l.balance, 0)),
    iOweTotal: roundMoney(-iOwe.reduce((s, x) => s + x.l.balance, 0)),
    overdueCount: owed.filter((x) => x.l.firstOverdue).length,
    gaveTotal: sumAmounts(lendState.entries.filter((e) => e.type === 'gave')),
    receivedTotal: sumAmounts(lendState.entries.filter((e) => e.type === 'received')),
  };
}

/** One-line summary for the landing page. */
function lendLandingInfo() {
  const o = lendOverview();
  if (!o.people.length) return 'Nobody owes you anything yet';
  if (!o.owed.length) return o.iOwe.length ? `You owe ${fmt(o.iOweTotal)}` : 'All settled';
  return `${fmt(o.outstanding)} owed to you by ${peopleCount(o.owed.length)}`
    + (o.overdueCount ? ` · ${o.overdueCount} overdue` : '');
}

/* ---------- Rendering ---------- */

function renderLend() {
  const person = lendPersonFromHash();
  $('#modeTitle').textContent = person ? 'All people' : 'Lending Tracker';
  $('#view-lend').innerHTML = person ? personScreen(person) : listScreen();
}

/** One person in the list. */
function personRow({ p, l }) {
  const st = lendStatus(l);
  let sub;
  if (st.key === 'overdue') sub = `Overdue since ${shortDate(l.firstOverdue)}`;
  else if (st.key === 'owes') sub = `Since ${shortDate(l.since)} · ${plural(daysAgo(l.since), 'day')}`;
  else if (st.key === 'iowe') sub = `You owe them · last ${shortDate(l.lastDate)}`;
  else if (st.key === 'settled') sub = `Settled · last ${shortDate(l.lastDate)}`;
  else sub = 'No entries yet';
  return `<a class="txn person-row" href="#lend/${encodeURIComponent(p.id)}" data-name="${esc(p.name.toLowerCase())}">
    <span class="avatar ${st.key}">${esc(initials(p.name))}</span>
    <span class="txn-main"><span class="txn-title">${esc(p.name)}</span><span class="txn-sub">${esc(sub)}</span></span>
    <span class="txn-amt num ${st.cls}">${l.balance ? fmtExact(Math.abs(l.balance)) : ''}</span>
    <span class="txn-chev" aria-hidden="true">›</span></a>`;
}

function listScreen() {
  const o = lendOverview();
  let html = `
    <div class="card">
      <div class="card-head">
        <span class="stat-label">Owed to you</span>
        ${o.overdueCount ? `<span class="pill pill-over">${o.overdueCount} overdue</span>` : ''}
      </div>
      <div class="meter-amount num">${fmt(o.outstanding)}</div>
      <div class="meter-foot">${o.owed.length ? `${peopleCount(o.owed.length)} ${o.owed.length === 1 ? 'owes' : 'owe'} you` : 'Nobody owes you right now'}${
        o.iOwe.length ? ` · you owe ${fmt(o.iOweTotal)} to ${peopleCount(o.iOwe.length)}` : ''}</div>
      <div class="lend-totals">
        <div><span class="stat-label">Given in total</span><strong class="num">${fmt(o.gaveTotal)}</strong></div>
        <div><span class="stat-label">Received back</span><strong class="num">${fmt(o.receivedTotal)}</strong></div>
      </div>
    </div>`;

  if (!o.people.length) {
    return html + `<div class="card empty">No one here yet.<br>
      Tap <strong>+ Record</strong> to log money you’ve lent, with the person’s name.</div>`;
  }

  if (o.people.length > 5) {
    html += `<input type="search" id="lendSearch" class="lend-search" placeholder="Search people" autocomplete="off">`;
  }

  // Overdue first, then biggest balance.
  const owes = o.owed.sort((a, b) => Boolean(b.l.firstOverdue) - Boolean(a.l.firstOverdue) || b.l.balance - a.l.balance);
  const iOwe = o.iOwe.sort((a, b) => a.l.balance - b.l.balance);
  const settled = o.people.filter((x) => x.l.balance === 0)
    .sort((a, b) => (b.l.lastDate || '').localeCompare(a.l.lastDate || ''));

  const group = (title, list, total) => (list.length ? `
    <div class="day-head"><span>${title}</span><span class="num">${total ?? ''}</span></div>
    <div class="card txn-group">${list.map(personRow).join('')}</div>` : '');

  html += group('Owe you', owes, fmtExact(o.outstanding));
  html += group('You owe', iOwe, fmtExact(o.iOweTotal));
  if (settled.length) {
    html += `<details class="settled-group" ${owes.length || iOwe.length ? '' : 'open'}>
      <summary class="day-head"><span>Settled (${settled.length})</span><span class="txn-chev">⌄</span></summary>
      <div class="card txn-group">${settled.map(personRow).join('')}</div></details>`;
  }
  html += `<p class="hint list-hint">Tap a person to see their history and record money.</p>`;
  return html;
}

function personScreen(p) {
  const l = ledger(p.id);
  const st = lendStatus(l);
  const amount = Math.abs(l.balance);
  const line = l.balance > 0 ? `${esc(p.name)} owes you`
    : l.balance < 0 ? `You owe ${esc(p.name)}`
      : l.count ? 'All settled up' : 'Nothing recorded yet';

  let html = `
    <div class="card">
      <div class="person-top">
        <span class="avatar big ${st.key}">${esc(initials(p.name))}</span>
        <div class="person-id"><h2 class="person-name">${esc(p.name)}</h2>
          <span class="pill status-${st.key}">${st.label}</span></div>
      </div>
      <div class="meter-amount num ${st.cls}">${fmt(amount)}</div>
      <div class="meter-foot">${line}</div>
      <div class="lend-actions">
        <button class="btn primary big" data-action="lend-gave">I gave</button>
        <button class="btn big" data-action="lend-received">I received</button>
      </div>
      ${l.balance ? `<button class="btn full" data-action="lend-settle">Settle up · ${fmtExact(amount)}</button>` : ''}
    </div>`;

  if (l.count) {
    html += `<div class="card stat-list">
      <div class="stat"><span class="stat-label">Given in total</span><span class="stat-value num">${fmtExact(l.gave)}</span></div>
      <div class="stat"><span class="stat-label">Received back</span><span class="stat-value num">${fmtExact(l.received)}</span></div>
      ${l.since ? `<div class="stat"><span class="stat-label">Outstanding since</span>
        <span class="stat-value num">${shortDate(l.since)}<small>${plural(daysAgo(l.since), 'day')} ago</small></span></div>` : ''}
      ${l.firstOverdue ? `<div class="stat"><span class="stat-label">Was expected back by</span>
        <span class="stat-value num over-text">${shortDate(l.firstOverdue)}<small>${plural(daysAgo(l.firstOverdue), 'day')} overdue</small></span></div>` : ''}
      ${!l.firstOverdue && l.nextDue ? `<div class="stat"><span class="stat-label">Expected back by</span>
        <span class="stat-value num">${shortDate(l.nextDue)}</span></div>` : ''}
    </div>`;

    // History, newest first, with the balance after each entry.
    html += `<div class="day-head"><span>History · ${l.count} ${l.count === 1 ? 'entry' : 'entries'}</span></div>
      <div class="card txn-group">
      ${[...l.rows].reverse().map((e) => {
        const gave = e.type === 'gave';
        const sub = [shortDate(e.date), e.dueDate && gave ? `back by ${shortDate(e.dueDate)}` : '', e.note].filter(Boolean).join(' · ');
        const bal = e.balance > 0 ? `owes ${fmtExact(e.balance)}` : e.balance < 0 ? `you owe ${fmtExact(-e.balance)}` : 'settled';
        return `<button class="txn" data-action="lend-edit" data-id="${esc(e.id)}">
          <span class="flow ${gave ? 'out' : 'in'}" aria-hidden="true">${gave ? '↑' : '↓'}</span>
          <span class="txn-main"><span class="txn-title">${gave ? 'Gave' : 'Received'} ${fmtExact(e.amount)}</span>
            <span class="txn-sub">${esc(sub)}</span></span>
          <span class="txn-bal num">${bal}</span>
          <span class="txn-chev" aria-hidden="true">›</span></button>`;
      }).join('')}
      </div>
      <p class="hint list-hint">Tap an entry to edit or delete it.</p>`;
  }

  html += `<div class="settings-actions person-manage">
      <button class="btn small" data-action="lend-rename">Rename</button>
      <button class="btn small danger" data-action="lend-delete-person">Delete person</button>
    </div>`;
  return html;
}

/* ---------- Record / edit sheet ---------- */

const lendDialog = $('#lendDialog');
const NEW_PERSON = '__new';

function lendType() {
  return document.querySelector('input[name="lendType"]:checked')?.value || 'gave';
}

/** Show "new person" name only when needed, and "expected back by" only for money given. */
function updateLendFields() {
  $('#lNewWrap').hidden = $('#lPerson').value !== NEW_PERSON;
  $('#lDueWrap').hidden = lendType() !== 'gave';
}

function openLendDialog({ id = null, type = 'gave', personId, amount = '', date, dueDate = '', note = '' } = {}) {
  lendEditingId = id;
  $('#lendTitle').textContent = id ? 'Edit entry' : 'Record money';
  document.querySelector(`input[name="lendType"][value="${type}"]`).checked = true;

  // Default person: the one on screen, else the one used most recently.
  const lastPerson = [...lendState.entries].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.personId;
  const chosen = personId || lendPersonFromHash()?.id || lastPerson || NEW_PERSON;
  const people = [...lendState.people].sort((a, b) => a.name.localeCompare(b.name));
  $('#lPerson').innerHTML = people.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === chosen ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + `<option value="${NEW_PERSON}" ${chosen === NEW_PERSON || !people.length ? 'selected' : ''}>＋ New person…</option>`;

  $('#lNewName').value = '';
  $('#lAmount').value = amount;
  $('#lDate').value = date || todayISO();
  $('#lDue').value = dueDate || '';
  $('#lNote').value = note;
  $('#lDelete').hidden = !id;
  updateLendFields();
  lendDialog.showModal();
}

$('#lendForm').addEventListener('change', (e) => {
  if (e.target.name === 'lendType' || e.target.id === 'lPerson') updateLendFields();
  if (e.target.id === 'lPerson' && e.target.value === NEW_PERSON) $('#lNewName').focus();
});

$('#lendForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = roundMoney(Number($('#lAmount').value));
  if (!(amount > 0)) { $('#lAmount').focus(); return; }

  // Person: an existing one, or a new one (reusing a same-named person if there is one).
  let personId = $('#lPerson').value;
  let createdPerson = null;
  if (personId === NEW_PERSON) {
    const name = $('#lNewName').value.trim();
    if (!name) { $('#lNewName').focus(); return; }
    const existing = lendState.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) personId = existing.id;
    else {
      createdPerson = { id: uid(), name, createdAt: Date.now() };
      lendState.people.push(createdPerson);
      personId = createdPerson.id;
    }
  }

  const type = lendType();
  const data = {
    personId,
    type,
    amount,
    date: $('#lDate').value || todayISO(),
    dueDate: type === 'gave' && $('#lDue').value ? $('#lDue').value : null,
    note: $('#lNote').value.trim(),
  };

  if (lendEditingId) {
    const entry = lendState.entries.find((x) => x.id === lendEditingId);
    if (entry) Object.assign(entry, data);
    saveLend();
    lendDialog.close();
    render();
    showToast('Saved');
    return;
  }

  const entry = { id: uid(), ...data, createdAt: Date.now() };
  lendState.entries.push(entry);
  saveLend();
  lendDialog.close();
  render();
  const who = personById(personId)?.name ?? '';
  showToast(`${type === 'gave' ? 'Gave' : 'Received'} ${fmtExact(amount)} · ${who}`, () => {
    lendState.entries = lendState.entries.filter((x) => x.id !== entry.id);
    if (createdPerson) lendState.people = lendState.people.filter((p) => p.id !== createdPerson.id);
    saveLend();
    if (createdPerson && lendPersonFromHash() === null && location.hash.startsWith('#lend/')) replaceHash('#lend');
    render();
    showToast('Removed');
  });
});

$('#lDelete').addEventListener('click', () => {
  const index = lendState.entries.findIndex((x) => x.id === lendEditingId);
  if (index < 0) return;
  const [removed] = lendState.entries.splice(index, 1);
  saveLend();
  lendDialog.close();
  render();
  showToast(`Deleted ${fmtExact(removed.amount)} entry`, () => {
    lendState.entries.push(removed);
    saveLend();
    render();
  });
});

lendDialog.addEventListener('click', (e) => {
  if (e.target === lendDialog) lendDialog.close();
});

/* ---------- Person actions ---------- */

function settleUp() {
  const p = lendPersonFromHash();
  if (!p) return;
  const { balance } = ledger(p.id);
  if (!balance) return;
  openLendDialog(balance > 0
    ? { type: 'received', personId: p.id, amount: balance, note: 'Settled up' }
    : { type: 'gave', personId: p.id, amount: -balance, note: 'Paid back' });
}

function renamePerson() {
  const p = lendPersonFromHash();
  if (!p) return;
  const name = prompt('Name', p.name)?.trim();
  if (!name || name === p.name) return;
  p.name = name;
  saveLend();
  render();
}

function deletePerson() {
  const p = lendPersonFromHash();
  if (!p) return;
  const entries = lendState.entries.filter((e) => e.personId === p.id);
  const ok = confirm(entries.length
    ? `Delete ${p.name} and their ${entries.length === 1 ? 'entry' : `${entries.length} entries`}?`
    : `Delete ${p.name}?`);
  if (!ok) return;
  lendState.people = lendState.people.filter((x) => x.id !== p.id);
  lendState.entries = lendState.entries.filter((e) => e.personId !== p.id);
  saveLend();
  replaceHash('#lend');
  showToast(`Deleted ${p.name}`, () => {
    lendState.people.push(p);
    lendState.entries.push(...entries);
    saveLend();
    render();
  });
}

/** "‹ All people" on a person's screen. Returns false on the list (app.js then goes to the landing page). */
function lendBack() {
  if (!location.hash.startsWith('#lend/')) return false;
  goBackTo((h) => h === '#lend', '#lend'); // app.js
  return true;
}

/* ---------- Events ---------- */

// Live search on the people list (hides rows; no re-render so the keyboard stays up).
$('#view-lend').addEventListener('input', (e) => {
  if (e.target.id !== 'lendSearch') return;
  const q = e.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll('#view-lend .person-row')) {
    row.hidden = Boolean(q) && !row.dataset.name.includes(q);
  }
  for (const d of document.querySelectorAll('#view-lend .settled-group')) if (q) d.open = true;
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="lend-"]');
  if (!el) return;
  const p = lendPersonFromHash();
  switch (el.dataset.action) {
    case 'lend-gave': openLendDialog({ type: 'gave', personId: p?.id }); break;
    case 'lend-received': openLendDialog({ type: 'received', personId: p?.id }); break;
    case 'lend-settle': settleUp(); break;
    case 'lend-edit': {
      const entry = lendState.entries.find((x) => x.id === el.dataset.id);
      if (entry) openLendDialog(entry);
      break;
    }
    case 'lend-rename': renamePerson(); break;
    case 'lend-delete-person': deletePerson(); break;
  }
});
