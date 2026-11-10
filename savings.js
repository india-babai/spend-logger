'use strict';
/*
 * Life Savings — dated snapshots of what everything is worth, for you and Mom.
 *
 * Each profile ("Mine", "Mom") has holdings (PPF, Mutual funds, SBI FD, …).
 * A holding can be split into parts — e.g. the individual FDs inside
 * "Indian Bank FD" — and is then worth the sum of its parts.
 * Every so often you tap "Update values" and record what each one is worth
 * on that date: a snapshot. The latest snapshot is the current picture;
 * older ones give the change since last time and the growth chart.
 *
 * Screens: '#save' = first profile, '#save/<profileId>' = another profile.
 * Loaded after app.js, invest.js and lend.js, and reuses their helpers
 * (fmt, fmtLakh, shortDate, showToast, …). Data lives under its own key.
 * No real numbers are ever shipped in this file — the repo is public.
 */

/* ---------- Data ---------- */

const SAVINGS_KEY = 'savingslogger.v1';
// Muted colours for the allocation bar, one per group (cycled).
const GROUP_COLOURS = ['#b08a3e', '#5b6bb5', '#2a9d8f', '#a0668a', '#c27c5a', '#8a94a6'];

// { version, profiles: [{ id, name,
//     holdings: [{ id, name, group, note, parts: [{ id, label, note }] }],
//     snapshots: [{ id, date, values: { [holdingId | partId]: number }, total, note }] }] }
let savingsState = loadSavings();
let savingsEditing = null;    // { profileId, snapshotId | null } while the update sheet is open
let savingsManageOpen = false; // "Edit holdings" section stays open across re-renders

/** Generic starting structure (names only, no values). Rename or replace in "Edit holdings". */
function defaultSavings() {
  const h = (pid, name, group, note = '') => ({ id: `${pid}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, group, note, parts: [] });
  return {
    version: 1,
    profiles: [
      {
        id: 'me',
        name: 'Mine',
        holdings: [
          h('me', 'PPF', 'Retirement'), h('me', 'PF', 'Retirement'),
          h('me', 'Mutual funds', 'Market'), h('me', 'Stocks', 'Market'),
          h('me', 'Emergency fund', 'Cash & deposits'), h('me', 'FD / Gold', 'Cash & deposits'),
          h('me', 'Savings balance', 'Cash & deposits'), h('me', 'LIC', 'Insurance'),
        ],
        snapshots: [],
      },
      {
        id: 'mom',
        name: 'Mom',
        holdings: [
          h('mom', 'Bank savings', 'Bank'), h('mom', 'Bank FD', 'Bank'),
          h('mom', 'Mutual funds', 'Market'), h('mom', 'Post Office', 'Post Office'),
        ],
        snapshots: [],
      },
    ],
  };
}

function loadSavings() {
  try {
    const raw = localStorage.getItem(SAVINGS_KEY);
    if (raw) return normalizeSavings(JSON.parse(raw));
  } catch (err) {
    console.error('Could not read savings data', err);
  }
  return defaultSavings();
}

function normalizeSavings(data) {
  if (!Array.isArray(data?.profiles) || !data.profiles.length) return defaultSavings();
  return {
    version: 1,
    profiles: data.profiles.filter((p) => p && p.id).map((p) => ({
      id: String(p.id),
      name: p.name || 'Savings',
      holdings: (Array.isArray(p.holdings) ? p.holdings : []).filter((h) => h && h.id).map((h) => ({
        id: String(h.id),
        name: h.name || 'Holding',
        group: h.group || '',
        note: h.note || '',
        parts: (Array.isArray(h.parts) ? h.parts : []).filter((x) => x && x.id)
          .map((x) => ({ id: String(x.id), label: x.label || 'Part', note: x.note || '' })),
      })),
      snapshots: (Array.isArray(p.snapshots) ? p.snapshots : [])
        .filter((s) => s && s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.values && typeof s.values === 'object')
        .map((s) => ({ id: String(s.id), date: s.date, values: s.values, total: Number(s.total) || 0, note: s.note || '' })),
    })),
  };
}

function saveSavings() {
  try {
    localStorage.setItem(SAVINGS_KEY, JSON.stringify(savingsState));
  } catch (err) {
    alert('Could not save — storage may be full. Export a backup now.');
    console.error(err);
  }
}

/** Used by import in app.js and by "Import savings file". */
function setSavingsState(data) {
  savingsState = normalizeSavings(data);
  saveSavings();
}

const profileById = (id) => savingsState.profiles.find((p) => p.id === id);

/** Profile in '#save/<id>', else the first one. */
function currentProfile() {
  const [base, id] = location.hash.slice(1).split('/');
  return (base === 'save' && id && profileById(decodeURIComponent(id))) || savingsState.profiles[0];
}

/* ---------- Calculations ---------- */

const byDate = (p) => [...p.snapshots].sort((a, b) => a.date.localeCompare(b.date));

/** A holding's value in a snapshot: its own value, or the sum of its parts. null = not recorded. */
function holdingValue(h, values) {
  if (h.parts.length) {
    const vals = h.parts.map((x) => values[x.id]).filter((v) => typeof v === 'number');
    return vals.length ? roundMoney(vals.reduce((s, v) => s + v, 0)) : null;
  }
  return typeof values[h.id] === 'number' ? values[h.id] : null;
}

function computeTotal(p, values) {
  return roundMoney(p.holdings.reduce((s, h) => s + (holdingValue(h, values) ?? 0), 0));
}

/** Latest and previous snapshot, and the change between them. */
function profileSummary(p) {
  const snaps = byDate(p);
  const latest = snaps.at(-1) ?? null;
  const prev = snaps.at(-2) ?? null;
  const change = latest && prev ? roundMoney(latest.total - prev.total) : null;
  return {
    snaps, latest, prev, change,
    total: latest?.total ?? 0,
    changePct: change != null && prev.total ? (change / prev.total) * 100 : null,
  };
}

/** Holdings grouped in first-seen order. */
function groupHoldings(holdings) {
  const groups = new Map();
  for (const h of holdings) {
    const g = h.group.trim() || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  return [...groups].map(([name, list]) => ({ name, holdings: list }));
}

/** "+₹12,345" / "−₹1,000" */
const signed = (n) => `${n >= 0 ? '+' : '−'}₹${inrWhole.format(Math.abs(Math.round(n)))}`;

/** Landing-page line: "Mine ₹1.98Cr · Mom ₹29.87L" */
function savingsLandingInfo() {
  const parts = savingsState.profiles
    .map((p) => ({ p, s: profileSummary(p) }))
    .filter((x) => x.s.latest)
    .map((x) => `${x.p.name} ${fmtLakh(x.s.total)}`);
  return parts.length ? parts.join(' · ') : 'No values recorded yet';
}

/* ---------- Rendering ---------- */

const fmtSnapMonth = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

function renderSavings() {
  const p = currentProfile();
  const s = profileSummary(p);
  $('#modeTitle').textContent = 'Life Savings';

  // Mine / Mom tabs, each with its latest total.
  let html = `<div class="seg-tabs" role="tablist">
    ${savingsState.profiles.map((x) => {
      const xs = profileSummary(x);
      return `<button role="tab" aria-selected="${x.id === p.id}" class="${x.id === p.id ? 'active' : ''}"
        data-action="save-tab" data-id="${esc(x.id)}">${esc(x.name)}<small class="num">${xs.latest ? fmtLakh(xs.total) : '—'}</small></button>`;
    }).join('')}
  </div>`;

  const withData = savingsState.profiles.filter((x) => x.snapshots.length);
  if (withData.length > 1) {
    const together = withData.reduce((sum, x) => sum + profileSummary(x).total, 0);
    html += `<p class="hint save-together">Together: <strong class="num">${fmt(together)}</strong></p>`;
  }

  if (!s.latest) {
    html += `<div class="card">
      <p class="empty">No values recorded for ${esc(p.name)} yet.</p>
      <button class="btn primary full" data-action="save-update">Record today’s values</button>
      <p class="hint">Holdings are set up under <strong>Edit holdings</strong> below. You can also
        import a savings file there.</p>
    </div>`;
    html += manageSection(p);
    $('#view-save').innerHTML = html;
    return;
  }

  const values = s.latest.values;
  const prevValues = s.prev?.values ?? null;
  const groups = groupHoldings(p.holdings).map((g, i) => ({
    ...g,
    colour: GROUP_COLOURS[i % GROUP_COLOURS.length],
    total: roundMoney(g.holdings.reduce((sum, h) => sum + (holdingValue(h, values) ?? 0), 0)),
    recorded: g.holdings.some((h) => holdingValue(h, values) != null), // e.g. LIC has a note but no value
  }));

  // 1. Total, change since last snapshot, allocation by group
  const changeHtml = s.change == null
    ? '<span class="muted">First snapshot</span>'
    : `<span class="${s.change >= 0 ? 'ok-text' : 'over-text'}">${s.change >= 0 ? '▲' : '▼'} ${fmt(Math.abs(s.change))}
        (${s.changePct >= 0 ? '+' : '−'}${Math.abs(s.changePct).toFixed(1)}%)</span> since ${shortDate(s.prev.date)}`;
  html += `
    <div class="card">
      <div class="card-head"><span class="stat-label">Total savings</span>
        <span class="hint">as on ${shortDate(s.latest.date)}</span></div>
      <div class="meter-amount num">${fmt(s.total)}</div>
      <div class="meter-foot">${changeHtml}</div>
      <div class="split-bar thick" aria-hidden="true">
        ${groups.map((g) => `<span class="seg" style="width:${s.total > 0 ? (Math.max(0, g.total) / s.total) * 100 : 0}%;background:${g.colour}"></span>`).join('')}
      </div>
      ${groups.filter((g) => g.total).map((g) => `<div class="legend-row"><span class="dot" style="background:${g.colour}"></span>
        <span class="grow">${esc(g.name)}</span><span class="num">${fmt(g.total)}</span>
        <span class="pct num">${s.total > 0 ? Math.round((g.total / s.total) * 100) : 0}%</span></div>`).join('')}
      ${s.latest.note ? `<p class="hint">${esc(s.latest.note)}</p>` : ''}
      <button class="btn primary full save-update-btn" data-action="save-update">Update values</button>
    </div>`;

  // 2. Holdings by group, with change since last snapshot
  for (const g of groups) {
    html += `<div class="day-head"><span><span class="dot" style="background:${g.colour}"></span> ${esc(g.name)}</span>
      <span class="num">${g.recorded ? fmtExact(g.total) : '—'}</span></div>
      <div class="card txn-group">${g.holdings.map((h) => holdingRow(h, values, prevValues)).join('')}</div>`;
  }

  // 3. Growth chart and snapshot history
  html += `<div class="card"><h2>Growth</h2>${renderSavingsChart(s.snaps)}</div>`;
  html += `<div class="day-head"><span>Snapshots · ${s.snaps.length}</span></div>
    <div class="card txn-group">
    ${[...s.snaps].reverse().map((snap, i, list) => {
      const older = list[i + 1];
      const diff = older ? roundMoney(snap.total - older.total) : null;
      const sub = [diff == null ? 'First snapshot' : `${signed(diff)} since ${shortDate(older.date)}`, snap.note].filter(Boolean).join(' · ');
      return `<button class="txn" data-action="save-edit-snap" data-id="${esc(snap.id)}">
        <span class="txn-main"><span class="txn-title">${fmtLongDate.format(utcDate(snap.date))}</span>
          <span class="txn-sub ${diff == null ? '' : diff >= 0 ? 'ok-text' : 'over-text'}">${esc(sub)}</span></span>
        <span class="txn-amt num">${fmt(snap.total)}</span><span class="txn-chev" aria-hidden="true">›</span></button>`;
    }).join('')}
    </div>
    <p class="hint list-hint">Tap a snapshot to correct or delete it.</p>`;

  html += manageSection(p);
  $('#view-save').innerHTML = html;
}

/** One holding row; holdings with parts expand to show them. */
function holdingRow(h, values, prevValues) {
  const v = holdingValue(h, values);
  const pv = prevValues ? holdingValue(h, prevValues) : null;
  const diff = v != null && pv != null ? roundMoney(v - pv) : null;
  const right = `<span class="hval num">${v == null ? '<span class="muted">—</span>' : fmt(v)}
    ${diff ? `<small class="${diff > 0 ? 'ok-text' : 'over-text'}">${signed(diff)}</small>` : ''}</span>`;
  const main = `<span class="txn-main"><span class="txn-title">${esc(h.name)}</span>
    ${h.note ? `<span class="txn-sub">${esc(h.note)}</span>` : ''}</span>`;

  if (!h.parts.length) return `<div class="hrow">${main}${right}</div>`;
  return `<details class="hrow-wrap">
    <summary class="hrow">${main}${right}<span class="txn-chev" aria-hidden="true">⌄</span></summary>
    <div class="parts">
      ${h.parts.map((x) => `<div class="part-row">
        <span class="txn-main"><span class="part-label">${esc(x.label)}</span>
          ${x.note ? `<span class="txn-sub">${esc(x.note)}</span>` : ''}</span>
        <span class="num">${typeof values[x.id] === 'number' ? fmt(values[x.id]) : '—'}</span></div>`).join('')}
    </div></details>`;
}

/** Bars of the total at each snapshot (last 10). Inline SVG, no library. */
function renderSavingsChart(snaps) {
  const data = snaps.slice(-10);
  if (data.length < 2) return '<p class="hint">The chart appears once you have two snapshots.</p>';
  const W = 340, H = 190, top = 22, bottom = 26, side = 6;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...data.map((d) => d.total)) * 1.08;
  const slot = (W - side * 2) / data.length;
  const barW = Math.min(36, slot * 0.6);
  let svg = '';
  data.forEach((d, i) => {
    const cx = side + slot * i + slot / 2;
    const h = (d.total / max) * plotH;
    const latest = i === data.length - 1 ? ' bar-selected' : '';
    svg += `<rect class="save-bar${latest}" x="${cx - barW / 2}" y="${top + plotH - h}" width="${barW}" height="${h}" rx="4">
      <title>${fmtLongDate.format(utcDate(d.date))}: ${fmt(d.total)}</title></rect>
      <text class="value-label" x="${cx}" y="${top + plotH - h - 5}" text-anchor="middle">${fmtLakh(d.total)}</text>
      <text class="axis-label" x="${cx}" y="${H - 8}" text-anchor="middle">${fmtSnapMonth.format(utcDate(d.date))}</text>`;
  });
  const first = data[0], last = data.at(-1);
  const growth = roundMoney(last.total - first.total);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Total savings at each snapshot">${svg}</svg>
    <p class="hint">${signed(growth)} from ${shortDate(first.date)} to ${shortDate(last.date)}${
      first.total ? ` (${growth >= 0 ? '+' : '−'}${Math.abs((growth / first.total) * 100).toFixed(1)}%)` : ''}.</p>`;
}

/** Collapsible "Edit holdings": rename the section, add/rename/delete holdings and parts, import. */
function manageSection(p) {
  return `
    <details class="card settings-section save-manage" ${savingsManageOpen ? 'open' : ''}>
      <summary>
        <span class="sec-text"><span class="sec-title">Edit holdings</span>
          <span class="sec-sub">${p.holdings.length} holdings in ${esc(p.name)}</span></span>
        <svg class="sec-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <div class="sec-body">
        <label class="field">Section name
          <input type="text" data-sfield="profileName" value="${esc(p.name)}" maxlength="24">
        </label>
        <p class="hint">Group holdings (e.g. “SBI”, “Market”) to see them together. Split a holding into
          parts (e.g. individual FDs) and its value becomes the sum of the parts.</p>
        ${p.holdings.map((h) => `
          <div class="edit-row hold" data-hid="${esc(h.id)}">
            <input type="text" class="span-2" data-sfield="name" value="${esc(h.name)}" aria-label="Holding name">
            <button class="del" data-action="save-del-holding" aria-label="Delete ${esc(h.name)}">✕</button>
            <input type="text" data-sfield="group" value="${esc(h.group)}" placeholder="Group" aria-label="Group">
            <input type="text" class="span-2" data-sfield="note" value="${esc(h.note)}" placeholder="Note" aria-label="Note">
            ${h.parts.map((x) => `
              <div class="part-edit span-all" data-pid="${esc(x.id)}">
                <input type="text" data-sfield="label" value="${esc(x.label)}" placeholder="Part (e.g. FD no.)" aria-label="Part name">
                <input type="text" data-sfield="pnote" value="${esc(x.note)}" placeholder="Note" aria-label="Part note">
                <button class="del" data-action="save-del-part" aria-label="Delete ${esc(x.label)}">✕</button>
              </div>`).join('')}
            <button class="btn small span-all add-part" data-action="save-add-part">+ Add part</button>
          </div>`).join('')}
        <div class="settings-actions"><button class="btn" data-action="save-add-holding">+ Add holding</button></div>
        <div class="settings-actions">
          <button class="btn small" data-action="save-import">Import savings file</button>
        </div>
        <p class="hint">A savings file replaces only Life Savings data; your other loggers aren’t touched.</p>
      </div>
    </details>`;
}

/* ---------- Update values sheet ---------- */

const savingsDialog = $('#savingsDialog');

function openSavingsDialog(snapshotId = null) {
  const p = currentProfile();
  const snap = snapshotId ? p.snapshots.find((x) => x.id === snapshotId) : null;
  const base = snap ?? profileSummary(p).latest; // pre-fill from the latest values
  const values = base?.values ?? {};
  savingsEditing = { profileId: p.id, snapshotId: snap?.id ?? null };

  $('#savingsTitle').textContent = snap ? `${p.name} · ${shortDate(snap.date)}` : `Update values · ${p.name}`;
  $('#sDate').value = snap ? snap.date : todayISO();
  $('#sNote').value = snap?.note ?? '';
  $('#sDelete').hidden = !snap;

  const input = (key) => `<input type="number" inputmode="decimal" step="0.01" data-key="${esc(key)}"
    value="${typeof values[key] === 'number' ? values[key] : ''}" placeholder="—">`;
  $('#savingsInputs').innerHTML = groupHoldings(p.holdings).map((g) => `
    <div class="upd-group">${esc(g.name)}</div>
    ${g.holdings.map((h) => (h.parts.length ? `
      <div class="upd-holding"><span>${esc(h.name)}</span><span class="num" data-htotal="${esc(h.id)}"></span></div>
      ${h.parts.map((x) => `<label class="upd-row part"><span class="upd-name">${esc(x.label)}
        ${x.note ? `<small>${esc(x.note)}</small>` : ''}</span>${input(x.id)}</label>`).join('')}`
    : `<label class="upd-row"><span class="upd-name">${esc(h.name)}${h.note ? `<small>${esc(h.note)}</small>` : ''}</span>${input(h.id)}</label>`)).join('')}`).join('');

  updateSavingsTotal();
  savingsDialog.showModal();
}

function readSavingsInputs() {
  const values = {};
  for (const el of document.querySelectorAll('#savingsInputs [data-key]')) {
    if (el.value !== '' && Number.isFinite(Number(el.value))) values[el.dataset.key] = roundMoney(Number(el.value));
  }
  return values;
}

/** Live total in the sheet footer, and per-holding totals for holdings with parts. */
function updateSavingsTotal() {
  const p = profileById(savingsEditing.profileId);
  const values = readSavingsInputs();
  $('#sTotal').textContent = `Total ${fmt(computeTotal(p, values))}`;
  for (const el of document.querySelectorAll('#savingsInputs [data-htotal]')) {
    const h = p.holdings.find((x) => x.id === el.dataset.htotal);
    el.textContent = h ? fmt(holdingValue(h, values) ?? 0) : '';
  }
}

$('#savingsInputs').addEventListener('input', updateSavingsTotal);

$('#savingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = profileById(savingsEditing.profileId);
  const values = readSavingsInputs();
  if (!Object.keys(values).length) { document.querySelector('#savingsInputs [data-key]')?.focus(); return; }
  const date = $('#sDate').value || todayISO();
  const snap = { id: savingsEditing.snapshotId || uid(), date, values, total: computeTotal(p, values), note: $('#sNote').value.trim() };

  // Editing a snapshot replaces it; a new one on a date that already has a snapshot replaces that one.
  const index = savingsEditing.snapshotId
    ? p.snapshots.findIndex((x) => x.id === savingsEditing.snapshotId)
    : p.snapshots.findIndex((x) => x.date === date);
  const replaced = index >= 0 ? p.snapshots[index] : null;
  if (replaced) p.snapshots[index] = { ...snap, id: replaced.id };
  else p.snapshots.push(snap);

  saveSavings();
  savingsDialog.close();
  render();
  showToast(`Saved ${p.name} · ${fmt(snap.total)}`, () => {
    const i = p.snapshots.findIndex((x) => x.id === (replaced?.id ?? snap.id));
    if (replaced) p.snapshots[i] = replaced;
    else p.snapshots.splice(i, 1);
    saveSavings();
    render();
  });
});

$('#sDelete').addEventListener('click', () => {
  const p = profileById(savingsEditing.profileId);
  const index = p.snapshots.findIndex((x) => x.id === savingsEditing.snapshotId);
  if (index < 0) return;
  const [removed] = p.snapshots.splice(index, 1);
  saveSavings();
  savingsDialog.close();
  render();
  showToast(`Deleted ${shortDate(removed.date)} snapshot`, () => {
    p.snapshots.push(removed);
    saveSavings();
    render();
  });
});

/* ---------- Edit holdings ---------- */

/** Inline edits save on change (no re-render, so focus isn't lost). */
$('#view-save').addEventListener('change', (e) => {
  const el = e.target;
  const field = el.dataset.sfield;
  if (!field) return;
  const p = currentProfile();
  const value = el.value.trim();

  if (field === 'profileName') {
    if (!value) { el.value = p.name; return; }
    p.name = value;
    saveSavings();
    return render();
  }
  const h = p.holdings.find((x) => x.id === el.closest('[data-hid]')?.dataset.hid);
  if (!h) return;
  const part = h.parts.find((x) => x.id === el.closest('[data-pid]')?.dataset.pid);
  if (field === 'name') { if (!value) { el.value = h.name; return; } h.name = value; }
  if (field === 'group') h.group = value;
  if (field === 'note') h.note = value;
  if (field === 'label' && part) { if (!value) { el.value = part.label; return; } part.label = value; }
  if (field === 'pnote' && part) part.note = value;
  saveSavings();
});

$('#view-save').addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('save-manage')) savingsManageOpen = e.target.open;
}, true);

function addHolding() {
  const p = currentProfile();
  const h = { id: uid(), name: 'New holding', group: p.holdings.at(-1)?.group ?? '', note: '', parts: [] };
  p.holdings.push(h);
  saveSavings();
  render();
  const input = document.querySelector(`[data-hid="${h.id}"] [data-sfield="name"]`);
  if (input) { input.focus(); input.select(); }
}

function deleteHolding(hid) {
  const p = currentProfile();
  const index = p.holdings.findIndex((x) => x.id === hid);
  if (index < 0) return;
  const [removed] = p.holdings.splice(index, 1);
  saveSavings();
  render();
  // Past snapshot totals are kept as saved; the holding just stops appearing.
  showToast(`Deleted ${removed.name}`, () => {
    p.holdings.splice(index, 0, removed);
    saveSavings();
    render();
  });
}

function addPart(hid) {
  const h = currentProfile().holdings.find((x) => x.id === hid);
  if (!h) return;
  const part = { id: uid(), label: `Part ${h.parts.length + 1}`, note: '' };
  h.parts.push(part);
  saveSavings();
  render();
  const input = document.querySelector(`[data-pid="${part.id}"] [data-sfield="label"]`);
  if (input) { input.focus(); input.select(); }
}

function deletePart(hid, pid) {
  const h = currentProfile().holdings.find((x) => x.id === hid);
  const index = h?.parts.findIndex((x) => x.id === pid) ?? -1;
  if (index < 0) return;
  const [removed] = h.parts.splice(index, 1);
  saveSavings();
  render();
  showToast(`Deleted ${removed.label}`, () => {
    h.parts.splice(index, 0, removed);
    saveSavings();
    render();
  });
}

/* ---------- Import a savings file ---------- */

// Accepts a savings-only file ({ savings: {...} }) or a full Money Log backup (which also has `savings`).
$('#savingsImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data?.savings?.profiles)) throw new Error('This file has no Life Savings data.');
    const profiles = data.savings.profiles;
    const snapCount = profiles.reduce((n, x) => n + (x.snapshots?.length ?? 0), 0);
    const ok = confirm(`Replace your Life Savings data with this file (${profiles.map((x) => x.name).join(' & ')}, `
      + `${snapCount} snapshot${snapCount === 1 ? '' : 's'})? Your other loggers aren’t touched.`);
    if (!ok) return;
    setSavingsState(data.savings);
    replaceHash('#save');
    render();
    showToast('Savings imported');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
});

/* ---------- Events ---------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="save-"]');
  if (!el) return;
  const hid = el.closest('[data-hid]')?.dataset.hid;
  switch (el.dataset.action) {
    case 'save-tab': {
      // Tabs swap in place (no extra history entry), so ‹ still goes to the landing page.
      const first = savingsState.profiles[0]?.id;
      replaceHash(el.dataset.id === first ? '#save' : `#save/${encodeURIComponent(el.dataset.id)}`);
      break;
    }
    case 'save-update': openSavingsDialog(); break;
    case 'save-edit-snap': openSavingsDialog(el.dataset.id); break;
    case 'save-add-holding': addHolding(); break;
    case 'save-del-holding': deleteHolding(hid); break;
    case 'save-add-part': addPart(hid); break;
    case 'save-del-part': deletePart(hid, el.closest('[data-pid]')?.dataset.pid); break;
    case 'save-import': $('#savingsImportFile').click(); break;
  }
});
