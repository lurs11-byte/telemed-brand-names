import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://owgefxcymcksbskjzwne.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3ypplBtKF4lmmoPKp7j-Iw_hD2E6uhL';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function esc(s){
  s = (s===undefined||s===null) ? "" : String(s);
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function showStatus(msg, kind){
  const el = document.getElementById('statusbar');
  el.textContent = msg;
  el.className = 'statusbar show' + (kind ? ' '+kind : '');
  if (kind !== 'err'){
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(()=>{ el.classList.remove('show'); }, 3500);
  }
}

var DOM_LABEL = {AVAILABLE:"Available", TAKEN:"Taken", FOR_SALE:"For sale", UNKNOWN:"?"};
var DOM_CLASS = {AVAILABLE:"dom-avail", TAKEN:"dom-taken", FOR_SALE:"dom-sale", UNKNOWN:"dom-unk"};

var state = { view:"all", search:"", sortKey:null, sortDir:1, terrFilter:null, names:[], territories:[] };

// ---------- data access ----------
async function loadAll(){
  const [{data: names, error: e1}, {data: territories, error: e2}] = await Promise.all([
    supabase.from('names').select('*, decision_history(*)').order('created_at'),
    supabase.from('territories').select('*').order('name'),
  ]);
  if (e1 || e2){
    showStatus('Failed to load from Supabase: ' + ((e1||e2).message), 'err');
    return;
  }
  state.names = names.map(n => ({
    ...n,
    history: (n.decision_history||[]).slice().sort((a,b)=> new Date(a.event_date) - new Date(b.event_date))
  }));
  state.territories = territories.map(t => t.name);
  updateDatalist();
  render();
}

function findName(id){ return state.names.find(n => n.id === id); }

async function commitField(id, field, value){
  const { error } = await supabase.from('names').update({ [field]: value }).eq('id', id);
  if (error){ showStatus('Save failed: ' + error.message, 'err'); return; }
  const rec = findName(id);
  if (rec) rec[field] = value;
}

async function commitStatus(id, newStatus){
  const rec = findName(id);
  if (!rec) return;
  const old = rec.status;
  if (old === newStatus) return;
  let reason = window.prompt('Reason for changing status ' + old + ' → ' + newStatus + ' (optional):', '');
  if (reason === null) reason = '';
  const { error: e1 } = await supabase.from('names').update({ status: newStatus }).eq('id', id);
  if (e1){ showStatus('Save failed: ' + e1.message, 'err'); return; }
  const { error: e2 } = await supabase.from('decision_history').insert({
    name_id: id, event_date: todayISO(), from_status: old, to_status: newStatus, reason, round: 'manual'
  });
  if (e2){ showStatus('History save failed: ' + e2.message, 'err'); }
  rec.status = newStatus;
  showStatus('Saved.', 'ok');
}

async function deleteName(id){
  const rec = findName(id);
  if (!rec) return;
  const typed = window.prompt(`This permanently deletes "${rec.name}" and its full history. This cannot be undone.\n\nType the name exactly to confirm: ${rec.name}`);
  if (typed !== rec.name) { if (typed !== null) showStatus('Name didn\'t match — nothing deleted.', 'info'); return; }
  const { error } = await supabase.from('names').delete().eq('id', id);
  if (error){ showStatus('Delete failed: ' + error.message, 'err'); return; }
  showStatus(`Deleted "${rec.name}".`, 'ok');
  closeDrawer();
}

async function addTerritory(name){
  name = name.trim();
  if (!name) return false;
  if (state.territories.includes(name)) return false;
  const { error } = await supabase.from('territories').insert({ name });
  if (error){ showStatus('Failed to add world: ' + error.message, 'err'); return false; }
  return true;
}

async function renameTerritory(oldName, newName){
  newName = newName.trim();
  if (!newName || newName === oldName) return;
  if (state.territories.includes(newName)) { alert('A world with that name already exists. Use merge instead.'); return; }
  const { error: e1 } = await supabase.from('territories').update({ name: newName }).eq('name', oldName);
  if (e1){ showStatus('Rename failed: ' + e1.message, 'err'); return; }
  const { error: e2 } = await supabase.from('names').update({ territory: newName }).eq('territory', oldName);
  if (e2){ showStatus('Cascade update failed: ' + e2.message, 'err'); }
}

async function mergeTerritory(fromName, toName){
  if (fromName === toName) return;
  const { error: e1 } = await supabase.from('names').update({ territory: toName }).eq('territory', fromName);
  if (e1){ showStatus('Merge failed: ' + e1.message, 'err'); return; }
  const { error: e2 } = await supabase.from('territories').delete().eq('name', fromName);
  if (e2){ showStatus('Cleanup failed: ' + e2.message, 'err'); }
}

async function deleteTerritoryIfEmpty(name){
  const count = state.names.filter(n => n.territory === name).length;
  if (count > 0) { alert('Cannot delete — this world has ' + count + ' names. Use merge instead.'); return; }
  const { error } = await supabase.from('territories').delete().eq('name', name);
  if (error){ showStatus('Delete failed: ' + error.message, 'err'); }
}

async function addNames(names, territory){
  const rows = names.map(n => n.trim()).filter(Boolean).map(name => ({
    name, status: 'MAYBE', territory: territory || null, round: 'manual',
    domain_de: 'UNKNOWN', domain_com: 'UNKNOWN', domain_eu: 'UNKNOWN',
    tm_de: 'UNKNOWN', tm_eu: 'UNKNOWN', tm_risk: 'UNKNOWN',
  }));
  if (!rows.length) return;
  const { data, error } = await supabase.from('names').insert(rows).select('id');
  if (error){ showStatus('Add failed: ' + error.message, 'err'); return; }
  const histRows = data.map(r => ({
    name_id: r.id, event_date: todayISO(), from_status: 'Created', to_status: 'MAYBE',
    reason: 'Added manually to the list', round: 'manual'
  }));
  const { error: e2 } = await supabase.from('decision_history').insert(histRows);
  if (e2){ showStatus('History save failed: ' + e2.message, 'err'); }
  showStatus(`Added ${rows.length} name(s).`, 'ok');
}

// ---------- computed ----------
function domainOverall(r){
  if (r.domain_de === 'AVAILABLE') return 'GREEN';
  if (r.domain_de === 'UNKNOWN' && r.domain_com === 'UNKNOWN' && r.domain_eu === 'UNKNOWN') return 'UNKNOWN';
  if (r.domain_com === 'AVAILABLE' || r.domain_eu === 'AVAILABLE') return 'YELLOW';
  if (r.domain_de === 'TAKEN' && r.domain_com === 'TAKEN') return 'RED';
  return 'UNKNOWN';
}

// ---------- rendering ----------
function statusOptions(current){
  return ['KEEP','MAYBE','KILL'].map(s => `<option value="${s}"${s===current?' selected':''}>${s}</option>`).join('');
}
function domBadge(status){
  status = status || 'UNKNOWN';
  return `<span class="dombadge ${DOM_CLASS[status]||'dom-unk'}">${DOM_LABEL[status]||'?'}</span>`;
}
function rowHtml(r){
  let terrOpts = state.territories.map(t => `<option value="${esc(t)}"${t===r.territory?' selected':''}>${esc(t)}</option>`).join('');
  if (r.territory && !state.territories.includes(r.territory)){
    terrOpts += `<option value="${esc(r.territory)}" selected>${esc(r.territory)}</option>`;
  }
  if (!r.territory){ terrOpts = '<option value="">—</option>' + terrOpts; }
  return `<tr data-id="${esc(r.id)}">
    <td class="c-name"><span class="ltr">${esc(r.name)}</span></td>
    <td><select class="territory-select" data-act="territory">${terrOpts}</select></td>
    <td><select class="status-select v-${r.status}" data-act="status">${statusOptions(r.status)}</select></td>
    <td><input class="score-input" type="number" step="0.1" min="0" max="10" value="${esc(r.score ?? '')}" data-act="score"></td>
    <td>${domBadge(r.domain_de)}</td>
    <td>${domBadge(r.domain_com)}</td>
    <td>${domBadge(r.domain_eu)}</td>
    <td><span class="roundbadge">${esc(r.round||'—')}</span></td>
    <td><input class="reason-input" type="text" value="${esc(r.reason||'')}" data-act="reason" placeholder="—"></td>
    <td><button type="button" class="profile-btn" data-act="open">Profile</button></td>
  </tr>`;
}
function groupHeaderHtml(label, count){
  return `<tr class="group-header"><td colspan="10">${esc(label)} · ${count}</td></tr>`;
}

function applyFilters(records){
  let out = records;
  if (state.view === 'keep') out = out.filter(r => r.status==='KEEP');
  else if (state.view === 'maybe') out = out.filter(r => r.status==='MAYBE');
  else if (state.view === 'kill') out = out.filter(r => r.status==='KILL');
  if (state.terrFilter) out = out.filter(r => r.territory === state.terrFilter);
  const q = state.search.trim().toLowerCase();
  if (q){
    out = out.filter(r => `${r.name} ${r.territory||''} ${r.reason||''} ${r.notes||''}`.toLowerCase().includes(q));
  }
  return out;
}

function sortRecords(records){
  if (state.view === 'germany'){
    return records.slice().sort((a,b) => {
      const av = a.score==null?-1:parseFloat(a.score), bv = b.score==null?-1:parseFloat(b.score);
      return bv - av;
    });
  }
  if (!state.sortKey) return records;
  const k = state.sortKey, dir = state.sortDir;
  return records.slice().sort((a,b) => {
    const av = (k==='score') ? (a.score==null?-999:parseFloat(a.score)) : (a[k]||'').toString().toLowerCase();
    const bv = (k==='score') ? (b.score==null?-999:parseFloat(b.score)) : (b[k]||'').toString().toLowerCase();
    if (av < bv) return -1*dir;
    if (av > bv) return 1*dir;
    return 0;
  });
}

function render(){
  const all = state.names;
  document.getElementById('cnt-keep').textContent = all.filter(r=>r.status==='KEEP').length;
  document.getElementById('cnt-maybe').textContent = all.filter(r=>r.status==='MAYBE').length;
  document.getElementById('cnt-kill').textContent = all.filter(r=>r.status==='KILL').length;
  document.getElementById('cnt-total').textContent = all.length;

  const filtered = applyFilters(all);
  const sorted = sortRecords(filtered);
  const tbody = document.getElementById('tbody-visible');
  const summary = document.getElementById('terr-summary');

  if (state.view === 'territory'){
    summary.style.display = 'flex';
    const counts = {};
    all.forEach(r => { if(r.territory) counts[r.territory] = (counts[r.territory]||0)+1; });
    summary.innerHTML = state.territories.filter(t=>counts[t]).map(t =>
      `<button type="button" class="terr-chip${state.terrFilter===t?' active':''}" data-terr="${esc(t)}"><b>${counts[t]}</b>${esc(t)}</button>`
    ).join('');
    const byTerr = {};
    sorted.forEach(r => { const t = r.territory || '(No world)'; (byTerr[t]=byTerr[t]||[]).push(r); });
    let html = '';
    Object.keys(byTerr).sort().forEach(t => { html += groupHeaderHtml(t, byTerr[t].length) + byTerr[t].map(rowHtml).join(''); });
    tbody.innerHTML = html || '<tr><td colspan="10" class="empty-note">No results</td></tr>';
  } else if (state.view === 'domain'){
    summary.style.display = 'none';
    const order = {GREEN:0, YELLOW:1, RED:2, UNKNOWN:3};
    const withOverall = sorted.slice().sort((a,b) => order[domainOverall(a)]-order[domainOverall(b)]);
    tbody.innerHTML = withOverall.map(rowHtml).join('') || '<tr><td colspan="10" class="empty-note">No results</td></tr>';
  } else {
    summary.style.display = 'none';
    tbody.innerHTML = sorted.map(rowHtml).join('') || '<tr><td colspan="10" class="empty-note">No results</td></tr>';
  }
  document.querySelectorAll('thead th[data-sort]').forEach(th => th.classList.toggle('sorted', th.dataset.sort === state.sortKey));

  if (drawerId){
    const r = findName(drawerId);
    if (r) fillDrawer(r);
  }
}

function updateDatalist(){
  document.getElementById('territories-dl').innerHTML = state.territories.map(t => `<option value="${esc(t)}">`).join('');
}

// ---------- drawer ----------
var drawerId = null;
function openDrawer(id){
  const r = findName(id);
  if (!r) return;
  drawerId = id;
  fillDrawer(r);
  document.getElementById('drawer').classList.add('show');
  document.getElementById('drawer-overlay').classList.add('show');
}
function fillDrawer(r){
  document.getElementById('d-name').textContent = r.name;
  document.getElementById('d-territory').textContent = r.territory || '—';
  document.getElementById('d-round').textContent = 'Round ' + (r.round||'—');
  document.getElementById('d-status').value = r.status;
  document.getElementById('d-score').value = r.score ?? '';
  document.getElementById('d-reason').value = r.reason || '';
  document.getElementById('d-pron').value = r.pronunciation || '';
  document.getElementById('d-meaning').value = r.meaning || '';
  document.getElementById('d-etym').value = r.etymology || '';
  document.getElementById('d-rationale').value = r.rationale || '';
  document.getElementById('d-weak').value = r.weaknesses || '';
  document.getElementById('d-medtrust').value = r.medtrust || '';
  document.getElementById('d-consumer').value = r.consumer || '';
  document.getElementById('d-memorability').value = r.memorability || '';
  document.getElementById('d-ownability').value = r.ownability || '';
  document.getElementById('d-multifit').value = r.multifit || '';
  document.getElementById('d-dom-de').value = r.domain_de || 'UNKNOWN';
  document.getElementById('d-dom-com').value = r.domain_com || 'UNKNOWN';
  document.getElementById('d-dom-eu').value = r.domain_eu || 'UNKNOWN';
  document.getElementById('d-dom-source').value = [r.domain_source, r.domain_checked].filter(Boolean).join(' · ');
  document.getElementById('d-tm-de').value = r.tm_de || 'UNKNOWN';
  document.getElementById('d-tm-eu').value = r.tm_eu || 'UNKNOWN';
  document.getElementById('d-tm-risk').value = r.tm_risk || 'UNKNOWN';
  document.getElementById('d-tm-notes').value = r.tm_notes || '';
  document.getElementById('d-notes').value = r.notes || '';
  document.getElementById('d-ai-rec').value = r.ai_rec || '';

  const warnWrap = document.getElementById('d-warn-wrap');
  const warnSrc = (r.notes && r.notes.includes('⚠️')) ? r.notes : (r.weaknesses && r.weaknesses.includes('⚠️')) ? r.weaknesses : null;
  if (warnSrc){ warnWrap.style.display = 'block'; document.getElementById('d-warn').textContent = warnSrc; }
  else warnWrap.style.display = 'none';

  const hist = (r.history||[]).slice().reverse();
  document.getElementById('d-history').innerHTML = hist.length ? hist.map(h => `
    <li class="hist-item"><div class="d">${esc(h.event_date)} · Round ${esc(h.round||'—')}</div>
    <b>${esc(h.from_status)} → ${esc(h.to_status)}</b>${h.reason ? ' — '+esc(h.reason) : ''}</li>
  `).join('') : '<li class="hist-item">No history yet</li>';
}
function closeDrawer(){
  document.getElementById('drawer').classList.remove('show');
  document.getElementById('drawer-overlay').classList.remove('show');
  drawerId = null;
}
function wireDrawer(){
  document.getElementById('drawer-close').onclick = closeDrawer;
  document.getElementById('drawer-overlay').onclick = closeDrawer;
  document.getElementById('d-delete').onclick = () => drawerId && deleteName(drawerId);
  document.getElementById('d-status').addEventListener('change', e => drawerId && commitStatus(drawerId, e.target.value));
  const map = [['d-score','score'], ['d-medtrust','medtrust'], ['d-consumer','consumer'],
    ['d-memorability','memorability'], ['d-ownability','ownability'], ['d-multifit','multifit'],
    ['d-tm-de','tm_de'], ['d-tm-eu','tm_eu'], ['d-ai-rec','ai_rec']];
  map.forEach(([id, field]) => document.getElementById(id).addEventListener('change', e => drawerId && commitField(drawerId, field, e.target.value)));
  ['d-dom-de','d-dom-com','d-dom-eu'].forEach((id, i) => {
    const field = ['domain_de','domain_com','domain_eu'][i];
    document.getElementById(id).addEventListener('change', async e => {
      if (!drawerId) return;
      await commitField(drawerId, field, e.target.value);
      await commitField(drawerId, 'domain_source', 'Updated manually by the team');
      await commitField(drawerId, 'domain_checked', todayISO());
    });
  });
  document.getElementById('d-tm-risk').addEventListener('change', e => drawerId && commitField(drawerId, 'tm_risk', e.target.value));
  const taMap = [['d-reason','reason'], ['d-pron','pronunciation'], ['d-meaning','meaning'], ['d-etym','etymology'],
    ['d-rationale','rationale'], ['d-weak','weaknesses'], ['d-tm-notes','tm_notes'], ['d-notes','notes']];
  taMap.forEach(([id, field]) => document.getElementById(id).addEventListener('blur', e => drawerId && commitField(drawerId, field, e.target.value)));
}

// ---------- table events ----------
function wireTable(){
  const tbody = document.getElementById('tbody-visible');
  tbody.addEventListener('change', e => {
    const t = e.target, tr = t.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id, act = t.dataset.act;
    if (act === 'status') commitStatus(id, t.value);
    else if (act === 'territory') commitField(id, 'territory', t.value || null);
    else if (act === 'score') commitField(id, 'score', t.value === '' ? null : parseFloat(t.value));
  });
  tbody.addEventListener('blur', e => {
    const t = e.target;
    if (t.dataset && t.dataset.act === 'reason'){
      const tr = t.closest('tr[data-id]');
      if (tr) commitField(tr.dataset.id, 'reason', t.value);
    }
  }, true);
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-act="open"]');
    if (!btn) return;
    const tr = btn.closest('tr[data-id]');
    if (tr) openDrawer(tr.dataset.id);
  });

  document.getElementById('viewtabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#viewtabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    state.terrFilter = null;
    const isCriteria = state.view === 'criteria';
    document.getElementById('criteria-panel').style.display = isCriteria ? 'flex' : 'none';
    document.getElementById('tablewrap').style.display = isCriteria ? 'none' : '';
    document.getElementById('search').style.visibility = isCriteria ? 'hidden' : 'visible';
    render();
  });
  document.getElementById('search').addEventListener('input', e => { state.search = e.target.value; render(); });
  document.querySelectorAll('thead th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
    render();
  }));
  document.getElementById('terr-summary').addEventListener('click', e => {
    const chip = e.target.closest('.terr-chip');
    if (!chip) return;
    const t = chip.dataset.terr;
    state.terrFilter = (state.terrFilter === t) ? null : t;
    render();
  });
}

// ---------- Add Name modal ----------
function wireAddModal(){
  const modal = document.getElementById('modal-add');
  document.getElementById('btn-add').onclick = () => {
    document.getElementById('add-names').value = '';
    document.getElementById('add-territory').value = '';
    modal.classList.add('show');
  };
  document.getElementById('add-cancel').onclick = () => modal.classList.remove('show');
  document.getElementById('add-confirm').onclick = async () => {
    const raw = document.getElementById('add-names').value;
    const terr = document.getElementById('add-territory').value.trim();
    const names = raw.split('\n').map(s => s.trim()).filter(Boolean);
    modal.classList.remove('show');
    if (names.length) await addNames(names, terr);
  };
}

// ---------- Territory manager modal ----------
function renderTerrMgr(){
  const list = document.getElementById('terr-mgr-list');
  const counts = {};
  state.names.forEach(r => { if (r.territory) counts[r.territory] = (counts[r.territory]||0)+1; });
  list.innerHTML = state.territories.map(t => {
    const opts = state.territories.filter(x=>x!==t).map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    return `<div class="terr-mgr-row" data-terr="${esc(t)}">
      <input type="text" class="terr-name" value="${esc(t)}" data-act="rename">
      <span class="cnt">${counts[t]||0}</span>
      <select data-act="mergeto" style="max-width:130px;font-size:11px;"><option value="">Merge into...</option>${opts}</select>
      <button type="button" data-act="delete" title="Delete (only if empty)">✕</button>
    </div>`;
  }).join('');
}
function wireTerrModal(){
  const modal = document.getElementById('modal-terr');
  document.getElementById('btn-territories').onclick = () => { renderTerrMgr(); modal.classList.add('show'); };
  document.getElementById('terr-close').onclick = () => modal.classList.remove('show');
  document.getElementById('terr-new-add').onclick = async () => {
    const inp = document.getElementById('terr-new-name');
    if (await addTerritory(inp.value)) { inp.value = ''; }
  };
  const list = document.getElementById('terr-mgr-list');
  list.addEventListener('change', async e => {
    const row = e.target.closest('.terr-mgr-row');
    if (!row) return;
    const oldName = row.dataset.terr;
    if (e.target.dataset.act === 'rename'){
      await renameTerritory(oldName, e.target.value);
    } else if (e.target.dataset.act === 'mergeto'){
      const target = e.target.value;
      if (target && confirm(`Merge "${oldName}" into "${target}"? All names will move, the original world will be deleted.`)){
        await mergeTerritory(oldName, target);
      } else { e.target.value = ''; }
    }
  });
  list.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act="delete"]');
    if (!btn) return;
    await deleteTerritoryIfEmpty(btn.closest('.terr-mgr-row').dataset.terr);
  });
}

// re-render territory modal live if it's open when data changes
const _render = render;

// ---------- realtime ----------
function wireRealtime(){
  const label = document.getElementById('live-label');
  const dot = document.getElementById('live-indicator');
  const channel = supabase.channel('names-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'names' }, () => loadAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'decision_history' }, () => loadAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'territories' }, () => loadAll())
    .subscribe(status => {
      if (status === 'SUBSCRIBED'){ label.textContent = 'live'; dot.style.color = 'var(--keep)'; }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'){ label.textContent = 'offline'; dot.style.color = 'var(--kill)'; }
      else { label.textContent = status.toLowerCase(); }
    });
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
  wireTable();
  wireDrawer();
  wireAddModal();
  wireTerrModal();
  wireRealtime();
  loadAll();
});
