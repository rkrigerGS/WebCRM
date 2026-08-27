// renderer.js — GovSpring Prospecting CRM UI
// Talks to the app only through window.api (see preload.js).

let allProspects = [];
let selectedId = null;
let currentView = 'all';
let selectedIds = new Set();
let detailFullScreen = false;

const rowsEl     = document.getElementById('rows');
const emptyEl    = document.getElementById('emptyState');
const searchEl   = document.getElementById('searchBox');
const detailPane = document.getElementById('detailPane');
const bulkBar    = document.getElementById('bulkBar');
const tableWrap  = document.querySelector('.table-wrap');

const STATUS_LABELS={new:'Not contacted',sent:'Awaiting reply',replied:'Replied',signed:'Signed',dead:'Dead',dormant:'Dormant'};
function statusLabel(s){return STATUS_LABELS[s]||s;}
// Asked from four places (detail pane, reply review, dead-pile review, bulk bar); kept
// here so the wording can't drift apart again.
const DEAD_REASON_PROMPT='Why is this prospect dead? (optional — helps the backup review later)';
const DEAD_REASON_PROMPT_BULK='Why are these prospects dead? (optional — applies to all selected, helps the backup review later)';
// Quotes matter as much as angle brackets here: esc() is used inside quoted HTML
// attributes in several places, and some of those values come from outside the team — the
// From: header of an inbound email, uploaded dossier JSON — so an unescaped " would close
// the attribute and let whatever follows run as markup in a logged-in session.
function esc(s){return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
// Escaping characters does not make a URL safe: `javascript:…` passes through esc()
// untouched and runs script in this origin when clicked. Only web and mail links are
// rendered as links; anything else returns '' and the caller shows it as plain text, so
// the user still sees the value and can judge it.
function safeUrl(u){
  const raw=String(u==null?'':u).trim();
  try{ return ['http:','https:','mailto:'].includes(new URL(raw,window.location.origin).protocol)?raw:''; }
  catch{ return ''; }
}
// Every "Loading…" placeholder needs somewhere to land when the request fails, or the
// panel sits on that word forever and looks like a hang.
function errorBlock(msg){return `<div class="error-note">${esc(msg)}</div>`;}
// Subject options render as a single dropdown, not stacked cards — shared by the initial
// draft render (subjects arrive with every /generate) and the Suggest button (five more
// against the edited body). No options means no control at all, not an empty one.
function subjSelectHtml(list){return (list&&list.length)?`<select class="field-input" id="subjSelect"><option value="">Five suggestions — pick one, or write your own</option>${list.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>`:'';}
function shorten(s,n){s=s||'';return s.length>n?s.slice(0,n-1)+'…':s;}
function scoreClass(s){return (s==null)?'score-none':'score-'+s;}
function todayStr(){return new Date().toISOString().slice(0,10);}
function daysBetween(a,b){return Math.floor((new Date(b)-new Date(a))/86400000);}

// ---- Derived per-prospect state ----

// Is this prospect due for a follow-up? (sent, not replied, and cadence days have passed)
function isDue(p){
  if(p.status!=='sent') return false;
  if(p.dormant_returned) return true; // surfaces immediately on the return date, regardless of the gap math below
  if(!p.date_sent) return false;
  const gap = p.followup_days || 4;
  return daysBetween(p.date_sent, todayStr()) >= gap;
}
function isOverdue(p){
  if(!isDue(p)) return false;
  const gap = p.followup_days || 4;
  return daysBetween(p.date_sent, todayStr()) >= gap + 3;
}
function hasContact(p){
  const d = p.dossier || {};
  const c = d.contact_general || {};
  const contacts = Array.isArray(d.contacts)?d.contacts:[];
  return !!(c.email || c.phone || contacts.some(x=>x.email||x.phone));
}

// ---- View filtering ----

function matchesView(p){
  switch(currentView){
    case 'replies':  return p.awaiting_reply_review===true;
    case 'new':      return p.status==='new';
    case 'due':      return isDue(p);
    case 'awaiting': return p.status==='sent';
    case 'replied':  return p.status==='replied';
    case 'signed':   return p.status==='signed';
    default:         return true; // 'all'
  }
}

function applyToolbar(list){
  const fit = document.getElementById('filterFit').value;
  const st  = document.getElementById('filterState').value;
  const ag  = document.getElementById('filterAgency').value;
  const des = document.getElementById('filterDesignation').value;
  const q   = searchEl.value.trim().toLowerCase();

  return list.filter(p=>{
    if(fit){ const [lo,hi]=fit.split('-').map(Number); if(!(p.fit_score>=lo&&p.fit_score<=hi)) return false; }
    if(st && (p.city_state||'')!==st) return false;
    if(ag){ const a=(p.dossier&&p.dossier.current_contract&&p.dossier.current_contract.agency)||''; if(a!==ag) return false; }
    if(des && !((p.designations||'').includes(des))) return false;
    if(q){
      const hay=[p.company_name,p.city_state,p.industry,p.designations,
        (p.dossier&&JSON.stringify(p.dossier.contacts||''))].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortList(list){
  const by=document.getElementById('sortBy').value;
  const c=[...list];
  switch(by){
    case 'followup': c.sort((a,b)=>{const ad=a.date_sent||'9999',bd=b.date_sent||'9999';return ad.localeCompare(bd);}); break;
    case 'stale':    c.sort((a,b)=>{const ad=a.date_sent||'0000',bd=b.date_sent||'0000';return ad.localeCompare(bd);}); break;
    case 'added':    c.sort((a,b)=>(b.id-a.id)); break;
    case 'name':     c.sort((a,b)=>(a.company_name||'').localeCompare(b.company_name||'')); break;
    default:         c.sort((a,b)=>((a.fit_score==null)-(b.fit_score==null))||((a.fit_score||99)-(b.fit_score||99))||(a.company_name||'').localeCompare(b.company_name||'')); // fit
  }
  return c;
}

// ---- Rendering ----

function renderList(){
  const viewFiltered = allProspects.filter(matchesView);
  const filtered = sortList(applyToolbar(viewFiltered));

  // Selection is only ever meaningful for rows the user can see. Without this, selecting
  // rows in one view and then switching view or filter left them selected but invisible —
  // and "Delete 5 prospect(s)?" would permanently delete five records nobody was looking at.
  const visibleIds = new Set(filtered.map(p=>p.id));
  for(const id of [...selectedIds]) if(!visibleIds.has(id)) selectedIds.delete(id);

  emptyEl.hidden = filtered.length!==0;

  rowsEl.innerHTML = filtered.map(p=>{
    const flags=[];
    if(isOverdue(p)) flags.push('<span class="flag flag-overdue">Overdue</span>');
    if(!hasContact(p)) flags.push('<span class="flag flag-nocontact">No contact</span>');
    if(p.fit_score!=null && p.fit_score<=3 && p.status==='new') flags.push('<span class="flag flag-hot">Hot</span>');
    if(p.dormant_returned) flags.push('<span class="flag flag-dormant-return">Returned from dormant</span>');

    let fu='';
    if(p.status==='sent' && p.date_sent){
      const gap=p.followup_days||4;
      const due=daysBetween(p.date_sent,todayStr())>=gap;
      const dueInDays=gap-daysBetween(p.date_sent,todayStr());
      fu = due ? `<span class="fu-overdue">due now</span>` : `in ${dueInDays}d`;
    }

    return `<tr data-id="${p.id}" class="${p.id===selectedId?'selected':''}" tabindex="0" role="button" aria-label="Open ${esc(p.company_name||'prospect')}">
      <td class="col-check"><input type="checkbox" class="rowcheck" data-id="${p.id}" aria-label="Select ${esc(p.company_name||'prospect')}" ${selectedIds.has(p.id)?'checked':''}></td>
      <td class="col-score"><span class="score-chit ${scoreClass(p.fit_score)}">${p.fit_score??'—'}</span></td>
      <td><div class="company-cell">${esc(p.company_name)}</div>${p.industry?`<div class="company-sub">${esc(shorten(p.industry,42))}</div>`:''}</td>
      <td>${esc(p.city_state)}</td>
      <td><span class="status-pill status-${p.status}">${esc(statusLabel(p.status))}</span></td>
      <td><span class="flags">${flags.join('')}</span></td>
      <td class="fu-cell">${fu}</td>
    </tr>`;
  }).join('');

  rowsEl.querySelectorAll('tr').forEach(tr=>{
    const open=()=>{
      const id=parseInt(tr.dataset.id,10);
      const p=allProspects.find(x=>x.id===id);
      if(p&&p.awaiting_reply_review)openReplyReview(id); else activateRow(id);
    };
    tr.addEventListener('click',(e)=>{ if(e.target.classList.contains('rowcheck'))return; open(); });
    // Opening a prospect is the app's primary action and was reachable only by mouse.
    tr.addEventListener('keydown',(e)=>{
      if(e.target.classList.contains('rowcheck'))return; // let Space toggle the checkbox
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); open(); }
    });
  });
  rowsEl.querySelectorAll('.rowcheck').forEach(cb=>{
    cb.addEventListener('change',()=>{ const id=parseInt(cb.dataset.id,10); if(cb.checked)selectedIds.add(id);else selectedIds.delete(id); updateBulkBar(); });
  });
  updateBulkBar();
}

function updateBulkBar(){
  bulkBar.hidden = selectedIds.size===0;
  if(selectedIds.size) document.getElementById('bulkCount').textContent = `${selectedIds.size} selected`;
  // Keep the header checkbox honest: it used to stay ticked after a bulk action cleared
  // the selection, and stay unticked after every visible row had been ticked by hand.
  const all=document.getElementById('selectAll');
  if(all){
    const boxes=rowsEl.querySelectorAll('.rowcheck');
    all.checked = boxes.length>0 && selectedIds.size===boxes.length;
    all.indeterminate = selectedIds.size>0 && selectedIds.size<boxes.length;
  }
}

async function refreshCountsAndFilters(){
  const counts={all:0,new:0,due:0,awaiting:0,replied:0,signed:0,replies:0};
  const states=new Set(), agencies=new Set(), designations=new Set();
  for(const p of allProspects){
    counts.all++;
    if(p.awaiting_reply_review)counts.replies++;
    if(p.status==='new')counts.new++;
    if(isDue(p))counts.due++;
    if(p.status==='sent')counts.awaiting++;
    if(p.status==='replied')counts.replied++;
    if(p.status==='signed')counts.signed++;
    if(p.city_state)states.add(p.city_state);
    const ag=(p.dossier&&p.dossier.current_contract&&p.dossier.current_contract.agency);
    if(ag)agencies.add(ag);
    (p.designations||'').split(/[,;]/).map(s=>s.trim()).filter(Boolean).forEach(d=>designations.add(d));
  }
  for(const k of Object.keys(counts)){ const el=document.getElementById('count-'+k); if(el)el.textContent=counts[k]; }
  fillSelect('filterState',[...states].sort());
  fillSelect('filterAgency',[...agencies].sort());
  fillSelect('filterDesignation',[...designations].sort());

  const strip=document.getElementById('pipelineStrip');
  strip.innerHTML=`<div class="pl-stat"><span class="pl-num">${counts.all}</span><span class="pl-label">total</span></div>
    <div class="pl-stat"><span class="pl-num">${counts.awaiting}</span><span class="pl-label">sent</span></div>
    <div class="pl-stat"><span class="pl-num">${counts.signed}</span><span class="pl-label">signed</span></div>`;
}

function fillSelect(id,values){
  const sel=document.getElementById(id);
  const cur=sel.value;
  sel.innerHTML='<option value="">Any</option>'+values.map(v=>`<option value="${esc(v)}">${esc(shorten(v,28))}</option>`).join('');
  if(values.includes(cur))sel.value=cur;
}

async function loadProspects(){
  allProspects=await window.api.listProspects();
  // enrich each with its dossier for filtering (list endpoint returns topline; fetch dossiers lazily is heavy,
  // so we ask the main process for full rows including dossier via getProspect only when needed).
  await refreshCountsAndFilters();
  renderList();
}

// ---- Detail pane ----

function field(k,v,link){ if(!v)return''; const href=link?safeUrl(v):''; const val=href?`<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(v)}</a>`:esc(v); return `<div class="field"><span class="field-key">${k}:</span> <span class="field-val">${val}</span></div>`; }
function litLine(l,t){ if(!t)return''; const cls=/NEEDS CHECKING/i.test(t)?'needs-check':''; return `<div class="field"><span class="field-key">${l}:</span> <span class="field-val ${cls}">${esc(t)}</span></div>`; }

// Corrupt persisted activity JSON must render as an empty log, not throw and blank the pane.
function parseActivity(raw){ try{ const a=JSON.parse(raw||'[]'); return Array.isArray(a)?a:[]; }catch{ return []; } }

// Build the unified per-prospect activity log from the stored activity array. Every entry
// becomes a typed, clickable row: outreach (editable — its message can be added/corrected and
// learned from), status (a standalone status change), or note (manual notes and the auto
// notes a send writes). Outreach entries carry {id, channel, message} on newer records; legacy
// ones only have the "Outreach via X: …" text, so recover from that and target by array index
// ("idx:N") until an edit assigns a real id. Newest first.
function buildLogEntries(activity){
  const arr=Array.isArray(activity)?activity:parseActivity(activity);
  const cap=s=>String(s||'').charAt(0).toUpperCase()+String(s||'').slice(1);
  const oneLine=s=>String(s||'').replace(/\s+/g,' ').trim();
  const entries=[];
  arr.forEach((a,idx)=>{
    if(!a)return;
    const entryId=a.id?a.id:('idx:'+idx);
    let channel=a.channel, message=a.message;
    if((!channel||message==null) && a.text && a.text.startsWith('Outreach via ')){
      // Legacy shape: recover channel + message. [\s\S] not . — pasted emails are multi-line,
      // and . would stop at the first newline, dropping the body.
      const m=a.text.match(/^Outreach via (\w+): ([\s\S]*)$/);
      if(m){ channel=channel||m[1]; if(message==null)message=m[2]; }
    }
    if(channel && message!=null){
      const line=oneLine(message);
      entries.push({date:a.date,type:'outreach',channel,message:String(message),entryId,
        preview:cap(channel)+' · '+line.slice(0,80)+(line.length>80?'…':'')});
      return;
    }
    if(a.kind==='status'){
      const lbl=statusLabel(a.status||'');
      entries.push({date:a.date,type:'status',entryId,
        text:a.text||('Status changed to '+(lbl||a.status||'')),
        preview:'Status → '+(lbl||a.status||'')});
      return;
    }
    const t=oneLine(a.text);
    entries.push({date:a.date,type:'note',entryId,text:String(a.text||''),
      preview:t.slice(0,90)+(t.length>90?'…':'')});
  });
  return entries.reverse();
}

// Two rows clicked in quick succession race their fetches: without the sequence check, the
// slower (first) response could land last and paint the WRONG prospect under the highlight
// of the second. Only the latest openDetail call is allowed to touch the pane.
let detailSeq=0;
function setFullScreen(on){
  detailFullScreen=on;
  detailPane.classList.toggle('detail-fullscreen',on);
  if(tableWrap)tableWrap.hidden=on;
}
// User clicked a row. Re-clicking the already-open prospect toggles full-screen; any other
// row opens normally. Kept separate from openDetail() so the many programmatic
// openDetail(id) refresh calls (after a status change, note, logged outreach, etc.) re-render
// the pane in place without flipping full-screen or being swallowed by the toggle branch.
function activateRow(id){
  if(selectedId===id && !detailPane.hidden){ setFullScreen(!detailFullScreen); return; }
  openDetail(id);
}
async function openDetail(id){
  const seq=++detailSeq;
  // Opening a different prospect drops full-screen; refreshing the current one preserves it.
  if(id!==selectedId) setFullScreen(false);
  selectedId=id; renderList();
  let p;
  // If the row is gone (deleted by someone else) or the request fails, close the pane
  // instead of leaving the previous prospect's details on screen under a new highlight.
  try{ p=await window.api.getProspect(id); }
  catch(e){
    if(seq!==detailSeq)return;
    detailPane.hidden=true; selectedId=null; renderList(); toast('Could not open this prospect: '+e.message,6000); loadProspects(); return;
  }
  if(seq!==detailSeq)return;
  if(!p)return;
  const d=p.dossier||{};
  const hasApproved=!!(p.final_sent);

  document.getElementById('dScore').textContent = d.fit_score?`Fit score ${d.fit_score.score}`:'';
  document.getElementById('dName').textContent = d.company_name||p.company_name;
  document.getElementById('dSub').textContent = [p.city_state,d.size_class].filter(Boolean).join('  ·  ');

  const c=d.contact_general||{};
  const contacts=Array.isArray(d.contacts)?d.contacts:[];
  const contract=d.current_contract||{};
  const lit=d.prior_litigation||{};
  const issues=Array.isArray(d.issue_spotting)?d.issue_spotting:[];
  const logEntries=buildLogEntries(p.activity);

  document.getElementById('detailBody').innerHTML=`
    <div class="section">
      <div class="section-label">Status</div>
      ${p.added_by?`<div class="field"><span class="field-key">Added by ${esc(p.added_by)}${p.added_at?` on ${esc(new Date(p.added_at).toLocaleDateString())}`:''}</span></div>`:''}
      <div class="field"><span class="status-pill status-${p.status}">${esc(statusLabel(p.status))}</span>
        ${p.date_sent?` <span class="field-key">sent ${esc(p.date_sent)}</span>`:''}
        ${p.followup_count?` <span class="field-key">· ${esc(String(p.followup_count))} follow-up(s)</span>`:''}</div>
      <div class="detail-actions" style="margin-top:10px;">
        <button class="btn btn-sm" id="generateBtn">Generate email</button>
        <button class="btn btn-sm ${hasApproved?'':'btn-ghost'}" id="followupBtn" ${hasApproved?'':'disabled title="Needs a sent email first"'}>Draft follow-up</button>
      </div>
      <div class="detail-actions" style="margin-top:6px;">
        <button class="btn btn-ghost btn-sm" id="logExternalBtn">Log outreach sent elsewhere</button>
        <button class="btn btn-ghost btn-sm" id="noteBtn">Add note</button>
      </div>
      <div class="detail-actions" style="margin-top:6px;">
        <select id="statusSelect" class="tb-select" style="font-size:12px;">
          <option value="">Change status…</option>
          <option value="new">New</option>
          <option value="sent">Sent</option>
          <option value="replied">Replied</option>
          <option value="signed">Signed</option>
          <option value="dead">Dead</option>
        </select>
        <label style="font-size:12px;color:var(--text-soft);display:flex;align-items:center;gap:5px;">
          Follow-up gap <input type="number" id="fuDays" value="${esc(String(p.followup_days||4))}" min="1" max="30" style="width:52px;font:inherit;padding:3px 5px;border:1px solid var(--line);border-radius:var(--radius-sm);">d
        </label>
      </div>
    </div>

    ${p.final_sent?`<div class="section"><div class="section-label">Sent email</div><div class="prose" style="white-space:pre-wrap;">${esc(shorten(p.final_sent,600))}</div></div>`:''}

    <div class="section"><div class="section-label">Activity log</div>${logEntries.length?logEntries.map(e=>`<div class="field log-entry" data-entry-id="${esc(e.entryId)}" data-type="${e.type}" title="${e.type==='outreach'?'Click to view or edit the message':'Click to view'}" style="font-size:12px;cursor:pointer;display:flex;gap:8px;align-items:baseline;"><span class="field-key" style="white-space:nowrap;">${esc(e.date||'')}</span><span class="field-val">${esc(e.preview)}</span></div>`).join(''):`<div class="field" style="color:var(--text-faint);font-size:12px;">Nothing logged yet.</div>`}</div>

    <div class="section">
      <div class="section-label">Identification</div>
      ${field('Industry',d.industry)}${field('Designations',d.designations)}${field('UEI',d.uei)}${field('CAGE',d.cage_code)}${field('Established',d.year_established)}
    </div>
    <div class="section">
      <div class="section-label">General contact <button class="btn btn-ghost btn-sm" id="editContactBtn" style="float:right;padding:2px 8px;">Edit</button></div>
      ${field('Website',c.website,true)}${field('Email',c.email)}${field('Phone',c.phone)}${field('LinkedIn',c.linkedin,true)}
    </div>
    ${contacts.length?`<div class="section"><div class="section-label">Decision-makers</div>${contacts.map(ct=>`<div class="field"><div class="field-val"><strong>${esc(ct.name||'(name not found)')}</strong> — ${esc(ct.title)}</div>${ct.email?`<div class="field-val">${esc(ct.email)}</div>`:''}${safeUrl(ct.linkedin)?`<div class="field-val"><a href="${esc(safeUrl(ct.linkedin))}" target="_blank" rel="noreferrer">LinkedIn</a></div>`:(ct.linkedin?`<div class="field-val">${esc(ct.linkedin)}</div>`:'')}</div>`).join('')}</div>`:''}
    <div class="section">
      <div class="section-label">Current contract</div>
      ${field('Agency',contract.agency)}${field('Award ID',contract.award_id)}${field('Amount',contract.award_amount)}${field('NAICS',contract.naics)}${field('PSC',contract.psc)}
      ${contract.work_details?`<div class="prose">${esc(contract.work_details)}</div>`:''}
    </div>
    <div class="section">
      <div class="section-label">Prior litigation</div>
      ${litLine('Bid protests',lit.bid_protests)}${litLine('Claims',lit.claims)}${litLine('Other',lit.other)}
    </div>
    ${d.sales_notes?`<div class="section"><div class="section-label">Sales notes</div><div class="prose">${esc(d.sales_notes)}</div></div>`:''}
    ${issues.length?`<div class="section"><div class="section-label">Issue spotting</div>${issues.map(i=>`<div class="issue"><div class="issue-title">${esc(i.title)}</div><div class="issue-exp">${esc(i.explanation)}</div>${i.citation?`<div class="issue-cite">${esc(i.citation)}</div>`:''}</div>`).join('')}</div>`:''}
    <div class="section">
      <div class="section-label">Danger zone</div>
      <button class="btn btn-danger btn-sm" id="deleteBtn">Delete prospect</button>
    </div>`;

  // wire detail actions
  document.getElementById('generateBtn').addEventListener('click',()=>openEmailFlow(id,d,false));
  const fb=document.getElementById('followupBtn'); if(hasApproved) fb.addEventListener('click',()=>openEmailFlow(id,d,true));
  document.getElementById('logExternalBtn').addEventListener('click',()=>openLogExternal(id));
  document.getElementById('noteBtn').addEventListener('click',()=>openNote(id));
  document.getElementById('detailBody').querySelectorAll('.log-entry').forEach(el=>{
    el.addEventListener('click',()=>{
      const e=logEntries.find(x=>String(x.entryId)===String(el.dataset.entryId));
      if(!e)return;
      if(e.type==='outreach')openOutreachEdit(id,e); else openLogEntryView(e);
    });
  });
  document.getElementById('editContactBtn').addEventListener('click',()=>openEditContact(id,c));
  document.getElementById('statusSelect').addEventListener('change',async(e)=>{
    const newStatus=e.target.value;
    if(!newStatus)return;
    const prevStatus=p.status;
    if(newStatus==='dead'){
      const reason=window.prompt(DEAD_REASON_PROMPT);
      if(reason&&reason.trim()){
        try{ await window.api.addNote(id,reason.trim()); }
        catch(err){ toast('The reason note could not be saved: '+err.message,6000); }
      }
    }
    // A failed save used to leave the new status sitting in the dropdown as if it had
    // taken, so the next person to look at the row saw a status the server never had.
    try{ await window.api.updateProspect(id,{status:newStatus}); }
    catch(err){ e.target.value=prevStatus; toast('Status not changed: '+err.message,6000); return; }
    loadProspects(); openDetail(id);
    toastUndo(`${d.company_name||p.company_name} moved to ${statusLabel(newStatus)}`,async()=>{
      try{ await window.api.updateProspect(id,{status:prevStatus}); }
      catch(err){ toast('Could not undo: '+err.message,6000); return; }
      loadProspects(); openDetail(id);
    });
  });
  document.getElementById('fuDays').addEventListener('change',async(e)=>{
    const prev=p.followup_days||4;
    try{ await window.api.updateProspect(id,{followup_days:parseInt(e.target.value,10)||4}); }
    catch(err){ e.target.value=prev; toast('Follow-up gap not saved: '+err.message,6000); }
  });
  document.getElementById('deleteBtn').addEventListener('click',async()=>{
    if(!confirm(`Delete ${d.company_name||p.company_name||'this prospect'}? This removes it entirely.`))return;
    try{ await window.api.deleteProspect(id); }
    catch(err){ toast('Not deleted: '+err.message,6000); return; }
    // setFullScreen(false) matters here: deleting while full-screen hid the pane but left the
    // list hidden too, leaving an empty window with no way back except a reload.
    setFullScreen(false); detailPane.hidden=true; selectedId=null; loadProspects();
  });

  detailPane.hidden=false;
}

// ---- Simple prompt-style modals reusing the email modal shell ----
const emailModal=document.getElementById('emailModal');
const emailModalBody=document.getElementById('emailModalBody');
const emailModalTitle=document.getElementById('emailModalTitle');

function openLogExternal(id){
  emailModalTitle.textContent='Log outreach sent elsewhere';
  emailModal.hidden=false;
  // Match the app's America/New_York convention (server uses todayNY); a plain
  // toISOString() would roll to tomorrow's date on any evening in ET. max caps the picker
  // at today since this field is for recording outreach that already happened.
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  emailModalBody.innerHTML=`
    <div class="q-hint">Paste an email, LinkedIn message, or a note about a call made outside the app. This records the outreach and starts the follow-up clock.</div>
    <div class="settings-field"><label>Date</label>
      <input type="date" id="extDate" class="field-input" value="${today}" max="${today}"></div>
    <div class="settings-field"><label>Channel</label>
      <select id="extChannel" class="field-input"><option value="email">Email</option><option value="linkedin">LinkedIn</option><option value="phone">Phone call</option></select></div>
    <div class="settings-field"><label>Message or note</label>
      <textarea id="extText" class="draft-area" style="min-height:180px;" placeholder="Paste the message sent, or note what was discussed on the call."></textarea></div>
    <div class="modal-actions"><button class="btn" id="extSave">Save outreach</button>
      <span class="usage-note">Logs the outreach, sets the status to ${esc(statusLabel('sent'))}, and starts the follow-up clock.</span></div>`;
  document.getElementById('extSave').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    const channel=document.getElementById('extChannel').value;
    const text=document.getElementById('extText').value.trim();
    const loggedAt=document.getElementById('extDate').value;
    if(!text)return;
    btn.disabled=true;
    try{ await window.api.logExternal(id,{channel,text,loggedAt}); }
    catch(err){ btn.disabled=false; toast('Outreach not logged: '+err.message,6000); return; }
    emailModal.hidden=true; loadProspects(); openDetail(id);
  });
}

// Open a logged outreach to view or fill in the full message that was actually sent. For
// email, saving can feed Marcos's voice library so the drafting prompt learns from a real
// email that originally went out from Gmail rather than through the app.
function openOutreachEdit(id,o){
  const isEmail=o.channel==='email';
  emailModalTitle.textContent='Outreach details';
  emailModal.hidden=false;
  emailModalBody.innerHTML=`
    <div class="q-hint">${esc(o.date)} · <span style="text-transform:capitalize;">${esc(o.channel)}</span>. Add or correct the message that was actually sent${isEmail?", so it's recorded and Marcos's voice library can learn from it":''}.</div>
    <div class="settings-field"><label>Message</label>
      <textarea id="oeText" class="draft-area" style="min-height:220px;" placeholder="Paste the full message that was sent.">${esc(o.message)}</textarea></div>
    ${isEmail?`<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:2px 0 12px;"><input type="checkbox" id="oeLearn" checked> Save to Marcos's voice library (learn from this email)</label>`:''}
    <div class="modal-actions"><button class="btn" id="oeSave">Save message</button></div>`;
  document.getElementById('oeSave').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    const text=document.getElementById('oeText').value.trim();
    if(!text){toast('Message cannot be empty',4000);return;}
    const saveToLibrary=isEmail&&document.getElementById('oeLearn').checked;
    btn.disabled=true;
    try{ await window.api.editOutreach(id,o.entryId,{text,saveToLibrary}); }
    catch(err){ btn.disabled=false; toast('Not saved: '+err.message,6000); return; }
    emailModal.hidden=true; loadProspects(); openDetail(id);
    toast(saveToLibrary?'Message saved and added to the voice library':'Message saved',4000);
  });
}

// Read-only view for a non-outreach log entry (a note, a send record, or a standalone status
// change). Outreach entries go to openOutreachEdit instead, since those are editable.
function openLogEntryView(e){
  emailModalTitle.textContent=e.type==='status'?'Status change':'Log entry';
  emailModal.hidden=false;
  // Status entries show the friendly label ("Status → Awaiting reply") to match the log row,
  // rather than the raw stored status text; notes/sends show their full text verbatim.
  const body=e.type==='status'?(e.preview||e.text||''):(e.text||e.preview||'');
  emailModalBody.innerHTML=`
    <div class="q-hint">${esc(e.date||'')}</div>
    <div class="prose" style="white-space:pre-wrap;">${esc(body)}</div>
    <div class="modal-actions"><button class="btn" id="leClose">Close</button></div>`;
  document.getElementById('leClose').addEventListener('click',()=>{emailModal.hidden=true;});
}

function openNote(id){
  emailModalTitle.textContent='Add note';
  emailModal.hidden=false;
  emailModalBody.innerHTML=`
    <div class="settings-field"><label>Note</label>
      <textarea id="noteText" class="draft-area" style="min-height:120px;" placeholder="e.g. Spoke with Gary, interested but busy until September."></textarea></div>
    <div class="modal-actions"><button class="btn" id="noteSave">Save note</button></div>`;
  document.getElementById('noteSave').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    const text=document.getElementById('noteText').value.trim();
    if(!text)return;
    btn.disabled=true;
    try{ await window.api.addNote(id,text); }
    catch(err){ btn.disabled=false; toast('Note not saved: '+err.message,6000); return; }
    emailModal.hidden=true; openDetail(id);
  });
}

function openEditContact(id,c){
  emailModalTitle.textContent='Edit contact details';
  emailModal.hidden=false;
  const f=(k,v)=>`<div class="settings-field"><label>${k}</label><input class="field-input" id="ec_${k}" value="${esc(v||'')}"></div>`;
  emailModalBody.innerHTML=`${f('website',c.website)}${f('email',c.email)}${f('phone',c.phone)}${f('linkedin',c.linkedin)}
    <div class="modal-actions"><button class="btn" id="ecSave">Save</button></div>`;
  document.getElementById('ecSave').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    btn.disabled=true;
    const patch={website:val('ec_website'),email:val('ec_email'),phone:val('ec_phone'),linkedin:val('ec_linkedin')};
    try{ await window.api.editContact(id,patch); }
    catch(err){ btn.disabled=false; toast('Contact not saved: '+err.message,6000); return; }
    emailModal.hidden=true; openDetail(id);
  });
  function val(x){return document.getElementById(x).value.trim();}
}

// ---- Backup: dead-pile review ----
// Last chance to recover a dead prospect before a backup makes it historical (see
// server.js's /api/admin/backup/*). Reuses the emailModal shell, widened for this one flow
// via the existing .modal-wide class rather than adding new markup to index.html.
async function startBackupFlow(){
  let deadList;
  // A failed dead-pile lookup used to make the Download backup button do nothing at all.
  // The review is a courtesy step; the backup itself is the point, so fall through to it.
  try{ deadList=await window.api.getDeadPile(); }
  catch(e){ toast('Could not load the dead-prospect review ('+e.message+') — downloading the backup anyway',6000); triggerBackupDownload(); return; }
  if(!deadList.length){ triggerBackupDownload(); return; }
  openDeadPileReview(deadList);
}
function triggerBackupDownload(){
  settingsModal.hidden=true;
  // The dead-pile review borrows the email modal and widens it; leaving it open (and wide)
  // after the download meant the next flow to use that modal opened at the wrong size.
  emailModal.hidden=true;
  const shell=emailModal.querySelector('.modal');
  if(shell)shell.classList.remove('modal-wide');
  window.location.href='/api/admin/backup/download';
}
function openDeadPileReview(list){
  emailModalTitle.textContent='Dead prospect review';
  // Settings must close first. Both modals are fixed, inset:0, z-index:50, and the Settings
  // backdrop comes later in the DOM — so leaving it open painted it on top of this review and
  // swallowed every click, making the manual backup unreachable whenever a prospect was dead.
  settingsModal.hidden=true;
  emailModal.hidden=false;
  emailModal.querySelector('.modal').classList.add('modal-wide');
  const decided=new Set();
  function renderRows(){
    emailModalBody.innerHTML=`
      <div class="q-hint">Last chance to recover a dead prospect before this backup makes it historical. Restore any that shouldn't be dead — everything else stays dead by default.</div>
      ${list.map(p=>`
        <div class="opt" style="cursor:default;display:flex;align-items:center;justify-content:space-between;gap:14px;${decided.has(p.id)?'opacity:0.45;':''}">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="score-chit ${scoreClass(p.fit_score)}">${p.fit_score??'—'}</span>
              <span class="opt-title">${esc(p.company_name)}</span>
            </div>
            <div class="opt-detail">${p.markedBy?`Marked dead by ${esc(p.markedBy)} on ${esc(new Date(p.markedAt).toLocaleDateString())}`:'Marked dead — who/when unknown'}</div>
            <div class="opt-detail">${p.reason?`Reason: ${esc(p.reason)}`:'No reason recorded'}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-sm restoreBtn" data-id="${p.id}" ${decided.has(p.id)?'disabled':''}>Restore</button>
            <button class="btn btn-ghost btn-sm keepDeadBtn" data-id="${p.id}" ${decided.has(p.id)?'disabled':''}>Keep dead</button>
          </div>
        </div>`).join('')}
      <div class="modal-actions"><button class="btn" id="proceedBackupBtn">Download backup</button>
        <span class="usage-note">${decided.size}/${list.length} reviewed</span></div>`;
    emailModalBody.querySelectorAll('.restoreBtn').forEach(btn=>btn.addEventListener('click',async()=>{
      const id=parseInt(btn.dataset.id,10);
      const row=list.find(x=>x.id===id);
      await window.api.updateProspect(id,{status:row.restoreStatus});
      decided.add(id); renderRows(); loadProspects();
      toastUndo(`${row.company_name} moved to ${statusLabel(row.restoreStatus)}`,async()=>{
        await window.api.updateProspect(id,{status:'dead'});
        loadProspects();
      });
    }));
    emailModalBody.querySelectorAll('.keepDeadBtn').forEach(btn=>btn.addEventListener('click',()=>{
      decided.add(parseInt(btn.dataset.id,10)); renderRows();
    }));
    document.getElementById('proceedBackupBtn').addEventListener('click',triggerBackupDownload);
  }
  renderRows();
}

// ---- Replies ----
const replyModal=document.getElementById('replyModal');
const replyModalBody=document.getElementById('replyModalBody');
const replyModalTitle=document.getElementById('replyModalTitle');
document.getElementById('replyModalClose').addEventListener('click',()=>replyModal.hidden=true);

function parseEmailAddress(raw){ const m=(raw||'').match(/<([^>]+)>/); return m?m[1]:(raw||'').trim(); }

// Same stale-response protection as openDetail: only the most recent open call may render.
let replySeq=0;
async function openReplyReview(id){
  const seq=++replySeq;
  replyModal.hidden=false;
  replyModalBody.innerHTML='<div class="gen-status">Loading…</div>';
  let p;
  try{ p=await window.api.getProspect(id); }
  catch(e){ if(seq!==replySeq)return; replyModalBody.innerHTML=errorBlock('Could not load this prospect: '+e.message); return; }
  if(seq!==replySeq)return;
  if(!p){replyModal.hidden=true;return;}
  const d=p.dossier||{};
  const isAdmin=window.__currentUser&&window.__currentUser.role==='admin';
  const [ctx,templates]=await Promise.all([
    window.api.getReplyContext(id).catch(e=>({replyText:'',error:e.message})),
    window.api.getReplyTemplates(id).catch(()=>[])
  ]);
  if(seq!==replySeq)return;
  replyModalTitle.textContent=`${d.company_name||p.company_name} — Reply`;
  const activity=parseActivity(p.activity);
  const defaultTo=parseEmailAddress(p.last_reply_from);
  const defaultSubject=`Re: ${d.company_name||p.company_name}`;

  const historyHtml=activity.length
    ?activity.map(a=>`<div class="field"><span class="field-key">${esc(a.date)}${a.kind?` · ${esc(a.kind)}`:''}:</span> <span class="field-val">${esc(a.text)}</span></div>`).join('')
    :'<div class="field-key">No prior activity logged.</div>';

  const templatesHtml=templates.length
    ?templates.map(t=>`<div class="opt" data-tid="${t.id}"><div class="opt-detail">${esc(t.text)}</div></div>`).join('')
    :'<div class="q-hint">No saved reply phrases yet — send and save a few replies to build this up.</div>';

  replyModalBody.innerHTML=`
    <div class="section">
      <div class="section-label">Prospect history</div>
      <div class="field"><span class="score-chit ${scoreClass(p.fit_score)}">${p.fit_score??'—'}</span> <span class="field-val"><strong>${esc(d.company_name||p.company_name)}</strong></span> <span class="field-key">${esc(p.city_state||'')}</span></div>
      ${historyHtml}
    </div>
    <div class="section">
      <div class="section-label">Their reply${p.last_reply_at?` — ${esc(new Date(p.last_reply_at).toLocaleString())}`:''}</div>
      <div class="field-key">${esc(p.last_reply_from||'Unknown sender')}</div>
      <div class="prose" style="white-space:pre-wrap;margin-top:6px;">${ctx.error?`<span style="color:var(--red)">Could not load the full reply: ${esc(ctx.error)}</span>`:esc(ctx.replyText||p.last_reply_snippet||'(no content)')}</div>
    </div>
    <div class="section">
      <div class="section-label">Quick-select reply phrases</div>
      <div class="q-hint">From past approved replies, with [name]/[company] filled in where known. Click to add to the draft below.</div>
      ${templatesHtml}
    </div>
    <div class="section">
      <div class="section-label">Draft response</div>
      <textarea class="draft-area" id="replyDraftArea" style="min-height:160px;" placeholder="Click phrases above, or type an instruction below and let Claude draft it."></textarea>
      <div class="settings-field" style="margin-top:10px;"><label>Instruction for Claude (optional)</label>
        <input class="field-input" id="replyInstruction" maxlength="280" placeholder="e.g. reply saying we'd like to schedule a call next week">
        <div class="modal-actions"><button class="btn btn-sm" id="replyGenBtn">Draft with Claude</button><span class="usage-note" id="replyInstructionCount">0/280</span></div>
      </div>
      <div class="settings-field"><label>To</label><input class="field-input" id="replyTo" value="${esc(defaultTo)}"></div>
      <div class="settings-field"><label>Subject</label><input class="field-input" id="replySubject" value="${esc(defaultSubject)}"></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;"><input type="checkbox" id="replySaveToLibrary" checked> Save this reply to the reply learning library</label>
      <div id="replySendErr" class="error-note" hidden></div>
      <div class="modal-actions"><button class="btn" id="replySendBtn">Send response</button></div>
    </div>
    <div class="section">
      <div class="section-label">Or, move this prospect</div>
      <div class="detail-actions">
        <button class="btn btn-ghost btn-sm" id="replyMarkRepliedBtn">Mark replied / interested</button>
        ${isAdmin?`<button class="btn btn-ghost btn-sm" id="replyMarkDormantBtn">Mark dormant</button>`:''}
        <button class="btn btn-ghost btn-sm" id="replyMarkDeadBtn">Mark dead</button>
      </div>
    </div>`;

  replyModalBody.querySelectorAll('.opt[data-tid]').forEach(el=>el.addEventListener('click',()=>{
    const ta=document.getElementById('replyDraftArea');
    ta.value=(ta.value?ta.value.trim()+' ':'')+el.querySelector('.opt-detail').textContent;
  }));
  const instrEl=document.getElementById('replyInstruction');
  instrEl.addEventListener('input',()=>{document.getElementById('replyInstructionCount').textContent=`${instrEl.value.length}/280`;});
  document.getElementById('replyGenBtn').addEventListener('click',async()=>{
    const btn2=document.getElementById('replyGenBtn');
    const orig=btn2.textContent; btn2.disabled=true; btn2.textContent='Drafting…';
    try{
      const res=await window.api.generateReply(id,{instruction:instrEl.value.trim(),seedDraft:document.getElementById('replyDraftArea').value.trim(),replyText:ctx.replyText||p.last_reply_snippet||''});
      if(res.ok)document.getElementById('replyDraftArea').value=res.draft;
      else alert('Could not draft: '+res.error);
    }catch(e){alert(e.message);}
    btn2.disabled=false; btn2.textContent=orig;
  });
  document.getElementById('replySendBtn').addEventListener('click',async()=>{
    const finalText=document.getElementById('replyDraftArea').value;
    const to=document.getElementById('replyTo').value.trim();
    const subject=document.getElementById('replySubject').value.trim();
    const saveToLibrary=document.getElementById('replySaveToLibrary').checked;
    const errEl=document.getElementById('replySendErr'); errEl.hidden=true;
    if(!to||!subject||!finalText.trim()){errEl.textContent='A recipient, subject, and draft are required.';errEl.hidden=false;return;}
    const sendBtn=document.getElementById('replySendBtn'); const origLabel=sendBtn.textContent;
    sendBtn.disabled=true; sendBtn.textContent='Sending…';
    try{
      await window.api.sendReply(id,{finalText,to,subject,saveToLibrary});
      replyModal.hidden=true; loadProspects();
      toast(`Reply sent to ${d.company_name||p.company_name}`);
    }catch(e){
      sendBtn.disabled=false; sendBtn.textContent=origLabel;
      if(e.exclusion){ renderExclusionBlock(errEl,e.exclusion,id,()=>document.getElementById('replySendBtn').click()); return; }
      errEl.textContent=e.message; errEl.hidden=false;
    }
  });
  document.getElementById('replyMarkRepliedBtn').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    btn.disabled=true;
    const prevStatus=p.status;
    // Guarded like the detail pane's status change: a failed save must not close the modal
    // as if the move had taken.
    try{ await window.api.updateProspect(id,{status:'replied'}); }
    catch(err){ btn.disabled=false; toast('Status not changed: '+err.message,6000); return; }
    replyModal.hidden=true; loadProspects();
    toastUndo(`${d.company_name||p.company_name} moved to ${statusLabel('replied')}`,async()=>{
      try{ await window.api.updateProspect(id,{status:prevStatus}); }
      catch(err){ toast('Could not undo: '+err.message,6000); return; }
      loadProspects();
    });
  });
  const dormantBtn=document.getElementById('replyMarkDormantBtn');
  if(dormantBtn)dormantBtn.addEventListener('click',async()=>{
    const returnDate=window.prompt('Return date (YYYY-MM-DD):');
    if(!returnDate)return;
    try{
      await window.api.setDormant(id,returnDate);
      replyModal.hidden=true; loadProspects();
      toastUndo(`${d.company_name||p.company_name} moved to ${statusLabel('dormant')}`,async()=>{
        try{ await window.api.updateProspect(id,{status:p.status}); }
        catch(err){ toast('Could not undo: '+err.message,6000); return; }
        loadProspects();
      });
    }catch(e){alert(e.message);}
  });
  document.getElementById('replyMarkDeadBtn').addEventListener('click',async(e)=>{
    const btn=e.currentTarget;
    if(btn.disabled)return;
    btn.disabled=true;
    const reason=window.prompt(DEAD_REASON_PROMPT);
    if(reason&&reason.trim()){
      try{ await window.api.addNote(id,reason.trim()); }
      catch(err){ toast('The reason note could not be saved: '+err.message,6000); }
    }
    const prevStatus=p.status;
    try{ await window.api.updateProspect(id,{status:'dead'}); }
    catch(err){ btn.disabled=false; toast('Status not changed: '+err.message,6000); return; }
    replyModal.hidden=true; loadProspects();
    toastUndo(`${d.company_name||p.company_name} moved to ${statusLabel('dead')}`,async()=>{
      try{ await window.api.updateProspect(id,{status:prevStatus}); }
      catch(err){ toast('Could not undo: '+err.message,6000); return; }
      loadProspects();
    });
  });
}

// ---- Email generation flow ----
let flowState=null;
async function openEmailFlow(prospectId,dossier,isFollowup){
  flowState={prospectId,dossier,isFollowup,issueId:null,services:[],personalNote:null,slots:[],selectedSlots:[]};
  emailModalTitle.textContent=isFollowup?'Draft follow-up':'Generate email';
  emailModal.hidden=false;
  let cfg;
  try{ cfg=await window.api.getConfig(); }
  catch(e){ emailModalBody.innerHTML=errorBlock('Could not load settings: '+e.message); return; }
  if(!cfg.hasApiKey){
    emailModalBody.innerHTML=`<div class="error-note">No Anthropic API key is set. Add it in Settings to generate drafts.</div><div class="modal-actions"><button class="btn" id="goSettings">Open Settings</button></div>`;
    document.getElementById('goSettings').addEventListener('click',()=>{emailModal.hidden=true;openSettings();});
    return;
  }
  if(isFollowup){ runGeneration(); return; }
  const [q,avail]=await Promise.all([window.api.emailQuestions(prospectId),window.api.calendarAvailability().catch(()=>({connected:false,failed:true,slots:[]}))]);
  flowState.slots=avail.connected?avail.slots:[];
  flowState.calendarConnected=avail.connected;
  // A real lookup failure must not read as "Calendar isn't set up" — that sent an admin to
  // Settings to fix something that was already configured. Carries the ref when there is one.
  flowState.calendarFailed=!!avail.failed;
  flowState.calendarRef=avail.ref||'';
  renderQuestions(q);
}

function renderQuestions(q){
  const issueOpts=q.issueOptions.map(o=>`<div class="opt" data-kind="issue" data-id="${o.id}"><div class="opt-title">${esc(o.label)}</div>${o.detail?`<div class="opt-detail">${esc(shorten(o.detail,140))}</div>`:''}</div>`).join('');
  const svcOpts=q.serviceOptions.map(o=>`<div class="opt" data-kind="service" data-id="${esc(o.id)}"><span class="opt-title">${esc(o.label)}</span><span class="opt-tags">${o.suggested?'<span class="tag tag-suggested">suggested</span>':''}${o.proven?'<span class="tag tag-proven">proven</span>':''}</span></div>`).join('');
  const personalBlock=(q.personalHooks&&q.personalHooks.length)?`<div class="q-block"><div class="q-label">Personal touch (optional)</div><div class="q-hint">Catalog hooks that may fit this prospect. Pick any to weave in, or none.</div>${q.personalHooks.map(h=>`<div class="opt" data-kind="hook" data-id="${esc(h.id)}"><div class="opt-title">${esc(h.label)}</div><div class="opt-detail">${esc(h.suggestion)}</div></div>`).join('')}</div>`:'';
  const slotsBlock=flowState.calendarConnected
    ?(flowState.slots.length
      ?`<div class="q-block"><div class="q-label">Offer specific open times (optional)</div><div class="q-hint">Half-hour openings on Marcos's calendar over the next two business days. Pick up to 5; each one becomes a one-click booking button in the email that creates a calendar invite with a Google Meet link.</div>${flowState.slots.map(s=>`<div class="opt" data-kind="slot" data-iso="${esc(s.startISO)}"><span class="opt-title">${esc(s.label)}</span></div>`).join('')}</div>`
      :`<div class="q-block"><div class="q-hint">No open business-hours slots found in the next two business days on Marcos's calendar.</div></div>`)
    :(flowState.calendarFailed
      ?`<div class="q-block"><div class="q-hint">Could not read Marcos's calendar just now, so specific open times aren't available for this draft.${flowState.calendarRef?` Reference code: ${esc(flowState.calendarRef)}.`:''} The draft will use the usual "available next week" wording.</div></div>`
      :`<div class="q-block"><div class="q-hint">Connect Google Calendar in Settings to offer specific open times here.</div></div>`);
  emailModalBody.innerHTML=`
    <div class="q-block"><div class="q-label">1. Which issue should the email lead with?</div><div class="q-hint">Pulled from this prospect's research.</div>${issueOpts}</div>
    <div class="q-block"><div class="q-label">2. Which services should we pitch?</div><div class="q-hint">Choose one or two. Suggested ones match their issues.</div>${svcOpts}</div>
    ${personalBlock}
    ${slotsBlock}
    <div class="modal-actions"><button class="btn" id="genBtn" disabled>Generate draft</button><span class="usage-note">Two questions, then a draft.</span></div>`;
  emailModalBody.querySelectorAll('.opt[data-kind="issue"]').forEach(el=>el.addEventListener('click',()=>{emailModalBody.querySelectorAll('.opt[data-kind="issue"]').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');flowState.issueId=el.dataset.id;updateGen();}));
  emailModalBody.querySelectorAll('.opt[data-kind="service"]').forEach(el=>el.addEventListener('click',()=>{const id=el.dataset.id;const i=flowState.services.indexOf(id);if(i>=0){flowState.services.splice(i,1);el.classList.remove('selected');}else{if(flowState.services.length>=2)return;flowState.services.push(id);el.classList.add('selected');}updateGen();}));
  flowState.hooks=[];
  emailModalBody.querySelectorAll('.opt[data-kind="hook"]').forEach(el=>el.addEventListener('click',()=>{const id=el.dataset.id;const i=flowState.hooks.indexOf(id);if(i>=0){flowState.hooks.splice(i,1);el.classList.remove('selected');}else{flowState.hooks.push(id);el.classList.add('selected');}}));
  emailModalBody.querySelectorAll('.opt[data-kind="slot"]').forEach(el=>el.addEventListener('click',()=>{
    const iso=el.dataset.iso;const i=flowState.selectedSlots.indexOf(iso);
    if(i>=0){flowState.selectedSlots.splice(i,1);el.classList.remove('selected');}
    else{if(flowState.selectedSlots.length>=5)return;flowState.selectedSlots.push(iso);el.classList.add('selected');}
  }));
  document.getElementById('genBtn').addEventListener('click',()=>{
    const chosen=(q.personalHooks||[]).filter(h=>flowState.hooks.includes(h.id)).map(h=>h.suggestion);
    flowState.personalNote=chosen.length?chosen.join(' '):null;
    runGeneration();
  });
}
function updateGen(){const b=document.getElementById('genBtn');if(b)b.disabled=!(flowState.issueId&&flowState.services.length>=1);}

async function runGeneration(){
  emailModalBody.innerHTML=`<div class="gen-status">Writing the draft in Marcos's voice…</div>`;
  let res;
  const chosenSlots=(flowState.selectedSlots||[]).map(iso=>{const s=(flowState.slots||[]).find(x=>x.startISO===iso);return s?s.label:null;}).filter(Boolean);
  try{ res=await window.api.emailGenerate(flowState.prospectId,{issueId:flowState.issueId,services:flowState.services,personalNote:flowState.personalNote,isFollowup:flowState.isFollowup,chosenSlots}); }
  catch(e){
    emailModalBody.innerHTML=errorBlock("Couldn't generate: "+e.message)+`<div class="modal-actions"><button class="btn btn-ghost" id="backBtn">Back</button></div>`;
    document.getElementById('backBtn').addEventListener('click',()=>openEmailFlow(flowState.prospectId,flowState.dossier,flowState.isFollowup));
    return;
  }
  // res.ref is the server-side reference code for this failure — shown so it can be reported.
  if(!res.ok){ emailModalBody.innerHTML=`<div class="error-note">Couldn't generate: ${esc(res.error)}${res.ref?` (ref ${esc(res.ref)})`:''}</div><div class="modal-actions"><button class="btn btn-ghost" id="backBtn">Back</button></div>`; document.getElementById('backBtn').addEventListener('click',()=>openEmailFlow(flowState.prospectId,flowState.dossier,flowState.isFollowup)); return; }
  // subjects may be empty — a model that ignored the response fence — and that's a normal
  // degrade to "no suggestions", not an error; the draft step must still render fine.
  flowState.subjects=res.subjects||[];
  renderDraft(res.draft,res.usage);
}

// Best-guess recipient: the first contact with an email, else the general contact email.
function guessRecipientEmail(d){
  const contacts=Array.isArray(d.contacts)?d.contacts:[];
  const withEmail=contacts.find(c=>c.email);
  if(withEmail)return withEmail.email;
  return (d.contact_general&&d.contact_general.email)||'';
}

async function renderDraft(draft,usage){
  const tokens=usage&&usage.output_tokens?`${usage.input_tokens||0} in / ${usage.output_tokens} out`:'';
  const [gmailStatus,ccable,cfg]=await Promise.all([
    window.api.getGmailStatus().catch(()=>({connected:false})),
    window.api.listCcableUsers().catch(()=>[]),
    window.api.getConfig().catch(()=>({}))
  ]);
  const company=flowState.dossier.company_name||'';
  const defaultSubject=flowState.isFollowup?`Re: ${company}`:company;
  const defaultTo=guessRecipientEmail(flowState.dossier);
  const ccOptions=ccable.length
    ?ccable.map(u=>`<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:400;"><input type="checkbox" class="ccCheck" value="${esc(u.email)}"> ${esc(u.username)} (${esc(u.email)})</label>`).join('')
    :`<div class="hint">No other users have an email on file to CC.</div>`;

  // Booking-link section: only when the SA picked open times in the questions step.
  // Participants default from the admin-set list (config.meetingParticipantIds) and can
  // be deselected per email; Marcos organizes the event so he is always on it.
  const offeredSlots=(flowState.selectedSlots||[]).map(iso=>(flowState.slots||[]).find(s=>s.startISO===iso)).filter(Boolean);
  const defaultPartIds=cfg.meetingParticipantIds||[];
  // Honest hint: only point at the dropdown when it actually exists. subjSelectHtml
  // renders nothing when the list is empty (model skipped the fence, or the filter
  // dropped everything), so the initial hint must degrade the same way the Suggest
  // button's error-note already does, instead of describing a control that isn't there.
  const hasSubjOptions=!!(flowState.subjects&&flowState.subjects.length);
  const subjHintClass=hasSubjOptions?'hint':'error-note';
  const subjHintText=hasSubjOptions
    ?`Five options arrive with the draft, written to read as a real person's email, not a blast — pick one below, then edit it however you like. Suggest asks for five new ones once you've edited the body.`
    :`No usable subject suggestions came back with this draft. Write your own below, or press Suggest to ask for five more once you've edited the body.`;
  let bookingSection='';
  if(offeredSlots.length){
    const partOptions=ccable.length
      ?ccable.map(u=>`<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:400;"><input type="checkbox" class="meetPartCheck" value="${esc(u.email)}" ${defaultPartIds.includes(u.id)?'checked':''}> ${esc(u.username)} (${esc(u.email)})</label>`).join('')
      :`<div class="hint">No other users have an email on file to add.</div>`;
    bookingSection=`
    <div class="settings-field"><label>Bookable times in this email</label>
      <div class="hint">One-click booking buttons for ${offeredSlots.map(s=>esc(s.label)).join('; ')} will be added below the signature. Booking creates a calendar invite with a Google Meet link.</div></div>
    <div class="settings-field"><label>Meeting participants (besides Marcos and the prospect)</label>${partOptions}</div>
    ${gmailStatus.calendarWrite?'':'<div class="error-note">Booking links need Google Calendar write access. An admin should disconnect and reconnect Gmail in Settings first, or the send will be rejected.</div>'}`;
  }

  emailModalBody.innerHTML=`
    <div class="q-hint">Review and edit. Paste the version you actually send back here and save so the app learns from your changes.</div>
    <textarea class="draft-area" id="draftArea">${esc(draft)}</textarea>
    <div class="modal-actions"><button class="btn" id="copyBtn">Copy to clipboard</button><button class="btn btn-ghost" id="regenBtn">Regenerate</button><div class="spacer"></div><span class="usage-note">${tokens}</span></div>
    <div class="settings-field"><label>To</label><input class="field-input" id="sendTo" value="${esc(defaultTo)}" placeholder="recipient@example.com"></div>
    <div class="settings-field"><label>Subject</label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input class="field-input" id="sendSubject" value="${esc(defaultSubject)}" style="flex:1;">
        <button class="btn btn-ghost" id="suggestSubjBtn" type="button">Suggest</button>
      </div>
      <div class="${subjHintClass}">${subjHintText}</div>
      <div id="subjErr" class="error-note" hidden></div>
      <div id="subjOptions">${subjSelectHtml(flowState.subjects)}</div>
    </div>
    <div class="settings-field"><label>CC (optional)</label>${ccOptions}</div>
    ${bookingSection}
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:14px;"><input type="checkbox" id="saveToLibraryCheck" checked> Save this email to the learning library</label>
    ${gmailStatus.connected?'':'<div class="error-note">Gmail is not connected. Ask an admin to connect it in Settings before sending.</div>'}
    <div id="sendErr" class="error-note" hidden></div>
    <div class="modal-actions"><button class="btn" id="saveFinalBtn" ${gmailStatus.connected?'':'disabled'}>${flowState.isFollowup?'Send follow-up':'Send email'}</button><span class="usage-note">Sends via Gmail, marks sent, and adds to the learning library.</span></div>`;
  document.getElementById('copyBtn').addEventListener('click',()=>{navigator.clipboard.writeText(document.getElementById('draftArea').value);const b=document.getElementById('copyBtn');b.textContent='Copied';setTimeout(()=>{if(b)b.textContent='Copy to clipboard';},1500);});
  document.getElementById('regenBtn').addEventListener('click',()=>{ if(flowState.isFollowup)runGeneration(); else openEmailFlow(flowState.prospectId,flowState.dossier,false); });
  // Which generated option the SA clicked, if any. Sent with the email so the server can
  // tell a suggestion taken as-is from one the SA rewrote — the rewrite is the correction
  // worth learning from. Cleared to '' when they type a subject with no option picked.
  let pickedSubject='';
  const subjOptions=document.getElementById('subjOptions');
  // (Re)binds the change listener on whichever <select> currently lives inside #subjOptions —
  // needed after every innerHTML swap, since replacing the markup drops old listeners.
  const bindSubjSelect=()=>{
    const sel=document.getElementById('subjSelect');
    if(!sel)return;
    sel.addEventListener('change',()=>{ pickedSubject=sel.value; if(sel.value)document.getElementById('sendSubject').value=sel.value; });
  };
  bindSubjSelect();
  document.getElementById('suggestSubjBtn').addEventListener('click',async()=>{
    const btn=document.getElementById('suggestSubjBtn');
    const errEl=document.getElementById('subjErr');
    errEl.hidden=true;
    const emailText=document.getElementById('draftArea').value.trim();
    if(!emailText){ errEl.textContent='Write or generate the email first, then ask for subject lines.'; errEl.hidden=false; return; }
    const label=btn.textContent;
    btn.disabled=true; btn.textContent='Thinking…';
    try{
      const r=await window.api.suggestSubjects(flowState.prospectId,{emailText,services:flowState.services||[]});
      if(!r.ok){ errEl.textContent=r.error+(r.ref?' (ref '+r.ref+')':''); errEl.hidden=false; return; }
      if(!r.subjects.length){
        // Every option was dropped by the deliverability filter. Saying so plainly beats
        // showing an empty box, and re-asking usually produces usable lines.
        errEl.textContent='None of the suggestions passed the spam-safety checks. Try again, or write your own.';
        errEl.hidden=false; return;
      }
      subjOptions.innerHTML=subjSelectHtml(r.subjects);
      bindSubjSelect();
    }catch(e){ errEl.textContent=e.message; errEl.hidden=false; }
    finally{ btn.disabled=false; btn.textContent=label; }
  });

  document.getElementById('saveFinalBtn').addEventListener('click',async()=>{
    const finalText=document.getElementById('draftArea').value;
    const to=document.getElementById('sendTo').value.trim();
    const subject=document.getElementById('sendSubject').value.trim();
    const cc=[...emailModalBody.querySelectorAll('.ccCheck:checked')].map(el=>el.value);
    const errEl=document.getElementById('sendErr');
    errEl.hidden=true;
    if(!to||!subject){ errEl.textContent='A recipient and subject are required.'; errEl.hidden=false; return; }
    const btn=document.getElementById('saveFinalBtn');
    const originalLabel=btn.textContent;
    btn.disabled=true; btn.textContent='Sending…';
    try{
      const saveToLibrary=document.getElementById('saveToLibraryCheck').checked;
      const bookingSlots=offeredSlots.map(s=>({startISO:s.startISO,endISO:s.endISO,label:s.label}));
      const meetingParticipants=[...emailModalBody.querySelectorAll('.meetPartCheck:checked')].map(el=>el.value);
      const finalMeta={services:flowState.services,channel:'email',isFollowup:flowState.isFollowup,to,subject,cc,saveToLibrary,bookingSlots,meetingParticipants};
      // Absent stays absent: an unpicked subject must omit the key rather than send ''.
      if(pickedSubject)finalMeta.suggestedSubject=pickedSubject;
      await window.api.emailSaveFinal(flowState.prospectId,finalText,finalMeta);
      emailModal.hidden=true; loadProspects(); openDetail(flowState.prospectId);
    }catch(e){
      btn.disabled=false; btn.textContent=originalLabel;
      if(e.exclusion){ renderExclusionBlock(errEl,e.exclusion,flowState.prospectId,()=>document.getElementById('saveFinalBtn').click()); return; }
      errEl.textContent=e.message; errEl.hidden=false;
    }
  });
}

document.getElementById('emailModalClose').addEventListener('click',()=>{emailModal.hidden=true;emailModal.querySelector('.modal').classList.remove('modal-wide');});

// ---- Settings ----
const settingsModal=document.getElementById('settingsModal');
const settingsBody=document.getElementById('settingsBody');
async function openSettings(){
  let cfg;
  try{ cfg=await window.api.getConfig(); }
  catch(e){ toast('Could not open Settings: '+e.message,6000); return; }
  const isAdmin=window.__currentUser&&window.__currentUser.role==='admin';
  let gmailStatus={connected:false,email:'',hasCreds:false};
  let digestCandidates=[];
  if(isAdmin){
    try{ gmailStatus=await window.api.getGmailAdminStatus(); }catch{}
    try{ digestCandidates=(await window.api.listUsers()).filter(u=>u.active&&u.email); }catch{}
  }

  settingsModal.hidden=false;
  // Everything in this modal is an app-wide setting — the shared API key, the folder the
  // server watches, the default follow-up gap. The server rejects these writes from a
  // non-admin, so non-admins get a short explanation instead of controls that would fail.
  settingsBody.innerHTML=`
    ${isAdmin?`
    <div class="settings-field"><label>Anthropic API key</label>
      <div class="hint">Used to generate email drafts. Starts with sk-ant-. Stored only on this machine.</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="password" class="field-input" id="apiKeyInput" placeholder="${cfg.hasApiKey?'•••• set (ends '+esc(cfg.keyTail)+')':'sk-ant-...'}" style="flex:1;">
        <button type="button" class="btn btn-ghost btn-sm" id="apiKeyPeek" aria-label="Show password briefly" style="flex-shrink:0;">Show</button>
      </div>
      <div class="key-status ${cfg.hasApiKey?'key-set':'key-unset'}">${cfg.hasApiKey?'A key is set.':'No key set yet.'}</div></div>
    <div class="settings-field"><label>Research output folder</label>
      <div class="hint">Where your research agent writes dossier JSON. The app watches this and its batch subfolders.</div>
      <div id="watchPathDisplay" class="key-status" style="word-break:break-all;margin-bottom:8px;"></div>
      <button class="btn btn-ghost btn-sm" id="chooseWatchBtn">Choose folder</button>
      <button class="btn btn-ghost btn-sm" id="resetWatchBtn">Use default</button></div>
    <div class="settings-field"><label>Default follow-up gap (days)</label>
      <input type="number" class="field-input" id="followupDaysInput" value="${cfg.defaultFollowupDays}" min="1" max="30" style="width:100px"></div>`:`
    <div class="settings-field"><label>Settings</label>
      <div class="hint">These settings apply to everyone using this CRM, so only an admin can change them. Ask an admin if something here needs adjusting.</div>
      <div class="key-status ${cfg.hasApiKey?'key-set':'key-unset'}">${cfg.hasApiKey?'Email drafting is set up and ready.':'No Anthropic API key is set yet — drafting is unavailable until an admin adds one.'}</div>
      <div class="key-status">Default follow-up gap: ${esc(String(cfg.defaultFollowupDays))} days</div></div>`}
    ${isAdmin?`
    <div class="settings-field"><label>Gmail connection</label>
      <div class="hint">Outreach emails send from this account, regardless of who is logged in.</div>
      <div class="key-status ${gmailStatus.connected?'key-set':'key-unset'}">${gmailStatus.connected?`Connected as ${esc(gmailStatus.email)}.`:'Not connected.'}</div>
      <div style="margin-top:8px;">
        ${gmailStatus.connected
          ?`<button class="btn btn-ghost btn-sm" id="gmailDisconnectBtn">Disconnect</button>`
          :`<button class="btn btn-sm" id="gmailConnectBtn" ${gmailStatus.hasCreds?'':'disabled title="Add a Google Client ID and Secret below first"'}>Connect Gmail</button>`}
      </div>
      <div class="key-status ${gmailStatus.calendarWrite?'key-set':'key-unset'}" style="margin-top:8px;">
        ${gmailStatus.calendarWrite
          ?'Calendar: connected — open times and one-click booking links can be offered in drafts.'
          :(gmailStatus.calendarConnected
            ?'Calendar: read-only access. Disconnect and reconnect Gmail to enable one-click booking links in emails (same account, no separate login).'
            :(gmailStatus.connected
              ?'Calendar: not yet granted. Disconnect and reconnect Gmail to add Calendar access (same account, no separate login).'
              :'Calendar: connects together with Gmail above.'))}
      </div></div>
    <div class="settings-field"><label>Google OAuth client</label>
      <div class="hint">From Google Cloud Console &rarr; APIs &amp; Services &rarr; Credentials. Needed once, before connecting.</div>
      <input class="field-input" id="googleClientIdInput" placeholder="${gmailStatus.hasCreds?'Client ID set (leave blank to keep it)':'Client ID'}" style="margin-bottom:8px;">
      <div style="display:flex;gap:6px;align-items:center;">
        <input class="field-input" id="googleClientSecretInput" type="password" placeholder="${gmailStatus.hasCreds?'•••• Client Secret set (leave blank to keep it)':'Client Secret'}" style="flex:1;">
        <button type="button" class="btn btn-ghost btn-sm" id="googleSecretPeek" aria-label="Show password briefly" style="flex-shrink:0;">Show</button>
      </div>
      <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" id="saveGoogleCredsBtn">Save Google credentials</button></div></div>
    <div class="settings-field"><label>Backup</label>
      <div class="hint">Downloads a zip of all app data — prospects, accounts, catalogs, audit log, config — except your Anthropic API key and Google Client Secret, which never leave the server.</div>
      <button class="btn btn-sm" id="downloadBackupBtn">Download backup</button></div>
    <div class="settings-field"><label>Scheduled automatic backup</label>
      <div class="hint">${gmailStatus.connected?'Emails a backup zip to marcos@govspringlegal.com on this schedule.':'Connect Gmail above to enable scheduled backups.'}</div>
      <select id="backupFreqSelect" class="tb-select" ${gmailStatus.connected?'':'disabled title="Connect Gmail above first"'}>
        <option value="off" ${cfg.backupFrequency==='off'?'selected':''}>Off</option>
        <option value="daily" ${cfg.backupFrequency==='daily'?'selected':''}>Daily</option>
        <option value="3days" ${cfg.backupFrequency==='3days'?'selected':''}>Every 3 days</option>
        <option value="weekly" ${cfg.backupFrequency==='weekly'?'selected':''}>Weekly</option>
      </select>
      ${cfg.lastBackupAt?`<div class="key-status key-set">Last automatic backup: ${esc(new Date(cfg.lastBackupAt).toLocaleString())}</div>`:''}</div>
    <div class="settings-field"><label>Weekly digest</label>
      <div class="hint">${gmailStatus.connected?'Sends every Monday at 6am ET to marcos@govspringlegal.com and anyone checked below.':'Connect Gmail above to enable the weekly digest.'}</div>
      <div class="key-status">Always sent to: marcos@govspringlegal.com</div>
      ${digestCandidates.length?digestCandidates.map(u=>`<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-weight:400;"><input type="checkbox" class="digestRecipCheck" value="${u.id}" ${(cfg.digestRecipientIds||[]).includes(u.id)?'checked':''}> ${esc(u.username)} (${esc(u.email)})</label>`).join(''):'<div class="hint">No other active users have an email on file.</div>'}
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
        <button class="btn btn-ghost btn-sm" id="saveDigestRecipBtn">Save recipients</button>
        <button class="btn btn-sm" id="sendDigestNowBtn" ${gmailStatus.connected?'':'disabled title="Connect Gmail first"'}>Send digest now</button>
      </div>
      ${cfg.lastDigestWeekKey?`<div class="key-status key-set" style="margin-top:6px;">Last digest week: ${esc(cfg.lastDigestWeekKey)}</div>`:''}</div>
    <div class="settings-field"><label>Default meeting participants</label>
      <div class="hint">Pre-checked on every email that offers bookable times; the sender can deselect them per email. Marcos is always on the meeting as organizer.</div>
      ${digestCandidates.length?digestCandidates.map(u=>`<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-weight:400;"><input type="checkbox" class="meetPartDefaultCheck" value="${u.id}" ${(cfg.meetingParticipantIds||[]).includes(u.id)?'checked':''}> ${esc(u.username)} (${esc(u.email)})</label>`).join(''):'<div class="hint">No other active users have an email on file.</div>'}
      <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" id="saveMeetPartBtn">Save participants</button></div></div>
    `:''}
    <div class="modal-actions"><button class="btn" id="saveSettingsBtn">${isAdmin?'Save':'Close'}</button></div>`;
  const keyPeek=document.getElementById('apiKeyPeek');
  if(keyPeek)wirePeekToggle(keyPeek,document.getElementById('apiKeyInput'));
  const secretPeek=document.getElementById('googleSecretPeek');
  if(secretPeek)wirePeekToggle(secretPeek,document.getElementById('googleClientSecretInput'));
  if(isAdmin){
    window.api.watchedPath().then(p=>{const el=document.getElementById('watchPathDisplay');if(el)el.textContent=p;}).catch(()=>{});
    document.getElementById('chooseWatchBtn').addEventListener('click',async()=>{const r=await window.api.chooseWatched();document.getElementById('watchPathDisplay').textContent=r.path;loadProspects();});
    document.getElementById('resetWatchBtn').addEventListener('click',async()=>{const r=await window.api.resetWatched();document.getElementById('watchPathDisplay').textContent=r.path;});
  }
  document.getElementById('saveSettingsBtn').addEventListener('click',async()=>{
    const keyEl=document.getElementById('apiKeyInput');
    const daysEl=document.getElementById('followupDaysInput');
    if(keyEl&&keyEl.value.trim())await window.api.setApiKey(keyEl.value.trim());
    const days=daysEl?parseInt(daysEl.value,10):NaN;
    if(days)await window.api.updateConfig({defaultFollowupDays:days});
    settingsModal.hidden=true;
  });

  if(isAdmin){
    const connectBtn=document.getElementById('gmailConnectBtn');
    if(connectBtn)connectBtn.addEventListener('click',()=>{ window.location.href='/api/admin/gmail/connect'; });
    const disconnectBtn=document.getElementById('gmailDisconnectBtn');
    if(disconnectBtn)disconnectBtn.addEventListener('click',async()=>{
      if(!confirm('Disconnect Gmail? Outreach emails cannot be sent until reconnected.'))return;
      await window.api.disconnectGmail(); openSettings();
    });
    document.getElementById('saveGoogleCredsBtn').addEventListener('click',async()=>{
      const clientId=document.getElementById('googleClientIdInput').value.trim();
      const clientSecret=document.getElementById('googleClientSecretInput').value.trim();
      if(!clientId&&!clientSecret)return;
      await window.api.saveGoogleCreds(clientId,clientSecret);
      openSettings();
    });
    document.getElementById('downloadBackupBtn').addEventListener('click',startBackupFlow);
    document.getElementById('backupFreqSelect').addEventListener('change',async(e)=>{
      try{ await window.api.saveBackupSchedule(e.target.value); }
      catch(err){ alert(err.message); }
      openSettings();
    });
    document.getElementById('saveDigestRecipBtn').addEventListener('click',async()=>{
      const ids=[...settingsBody.querySelectorAll('.digestRecipCheck:checked')].map(el=>parseInt(el.value,10));
      try{ await window.api.saveDigestRecipients(ids); toast('Digest recipients saved.'); }
      catch(err){ alert(err.message); }
    });
    document.getElementById('saveMeetPartBtn').addEventListener('click',async()=>{
      const ids=[...settingsBody.querySelectorAll('.meetPartDefaultCheck:checked')].map(el=>parseInt(el.value,10));
      try{ await window.api.saveMeetingParticipants(ids); toast('Default meeting participants saved.'); }
      catch(err){ alert(err.message); }
    });
    document.getElementById('sendDigestNowBtn').addEventListener('click',async()=>{
      const btn=document.getElementById('sendDigestNowBtn');
      const orig=btn.textContent; btn.disabled=true; btn.textContent='Sending…';
      try{ const r=await window.api.sendDigestNow(); toast(`Digest sent to ${r.to}`); }
      catch(err){ alert(err.message); }
      btn.disabled=false; btn.textContent=orig;
    });
  }
}
document.getElementById('settingsBtn').addEventListener('click',openSettings);
document.getElementById('settingsClose').addEventListener('click',()=>settingsModal.hidden=true);
document.getElementById('logoutBtn').addEventListener('click',async()=>{ await window.api.authLogout(); location.reload(); });

// ---- Admin: role-gated nav ----
function applyRoleUI(){
  const isAdmin = window.__currentUser && window.__currentUser.role==='admin';
  const sec = document.getElementById('adminSection');
  if (sec) sec.hidden = !isAdmin;
}

// Wires a persistent show/hide toggle button next to a password input: click flips
// between masked and plain text, and the button's own label/aria-label track state.
function wirePasswordToggle(toggleBtn,input){
  toggleBtn.addEventListener('click',()=>{
    const showing=input.type==='text';
    input.type=showing?'password':'text';
    toggleBtn.textContent=showing?'Show':'Hide';
    toggleBtn.setAttribute('aria-label',showing?'Show password':'Hide password');
  });
}

// For secret/API-key fields (Anthropic key, Google Client Secret): a momentary peek
// rather than a persistent toggle — reveals just long enough to check the format, then
// auto-hides. Clicking again while already revealed just restarts the timer.
function wirePeekToggle(btn,input,ms=1500){
  let timer=null;
  btn.addEventListener('click',()=>{
    input.type='text';
    clearTimeout(timer);
    timer=setTimeout(()=>{ input.type='password'; },ms);
  });
}

// ---- Admin: Users ----
const usersModal=document.getElementById('usersModal');
const usersBody=document.getElementById('usersBody');
let resetPwId=null; // id of the user row currently showing the inline reset-password form, or null
async function openUsers(){
  usersModal.hidden=false;
  usersBody.innerHTML='<div class="gen-status">Loading…</div>';
  let list;
  try{ list=await window.api.listUsers(); }
  catch(e){ usersBody.innerHTML=errorBlock('Could not load the user list: '+e.message); return; }
  resetPwId=null;
  renderUsers(list);
}
function renderUsers(list){
  const me=window.__currentUser;
  const rows=list.map(u=>{
    const isSelf=u.id===me.id;
    const actions=resetPwId===u.id
      ?`<div style="display:flex;gap:6px;align-items:center;">
          <input class="field-input" id="resetPwInput" type="password" placeholder="New password" style="flex:1;font-size:12.5px;padding:5px 8px;">
          <button type="button" class="btn btn-ghost btn-sm resetPwToggleBtn" aria-label="Show password" style="flex-shrink:0;">Show</button>
          <button class="btn btn-sm resetPwSaveBtn" data-id="${u.id}" style="flex-shrink:0;">Save</button>
          <button class="btn btn-ghost btn-sm resetPwCancelBtn" style="flex-shrink:0;">Cancel</button>
        </div>`
      :`${u.pending
          // Deactivate is offered on pending rows too: an invite sent to the wrong address
          // used to have no off switch at all until the person accepted it.
          ?`<button class="btn btn-sm resendInviteBtn" data-id="${u.id}">Resend invite</button>
             ${u.active
               ?`<button class="btn btn-ghost btn-sm deactivateBtn" data-id="${u.id}">Deactivate</button>`
               :`<button class="btn btn-ghost btn-sm reactivateBtn" data-id="${u.id}">Reactivate</button>`}`
          :`${u.active
              ?`<button class="btn btn-ghost btn-sm deactivateBtn" data-id="${u.id}">Deactivate</button>`
              :`<button class="btn btn-ghost btn-sm reactivateBtn" data-id="${u.id}">Reactivate</button>`}
            <button class="btn btn-ghost btn-sm resetPwBtn" data-id="${u.id}">Reset password</button>`}`;
    const pendingBadge=u.pending
      ?`<span class="status-pill badge-inactive" title="${u.inviteExpiresAt?'Expires '+esc(new Date(u.inviteExpiresAt).toLocaleString()):''}">invite pending</span>`
      :`<span class="status-pill ${u.active?'badge-active':'badge-inactive'}">${u.active?'active':'inactive'}</span>`;
    return `<tr data-id="${u.id}">
      <td><strong>${esc(u.username)}</strong>${isSelf?' <span class="field-key">(you)</span>':''}</td>
      <td><input class="field-input emailInput" data-id="${u.id}" value="${esc(u.email||'')}" placeholder="required" style="font-size:12.5px;padding:5px 8px;"></td>
      <td><select class="tb-select roleSelect" data-id="${u.id}">
        <option value="user" ${u.role==='user'?'selected':''}>User</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
      </select></td>
      <td>${pendingBadge}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  usersBody.innerHTML=`
    <div class="settings-field">
      <label>Create user</label>
      <div class="hint">An invitation email is sent automatically with a one-time link (expires in 48 hours) for this person to set their own password. Email is required.</div>
      <input class="field-input" id="newUserName" placeholder="Username" style="margin-bottom:8px;">
      <input class="field-input" id="newUserEmail" placeholder="Email (required)" style="margin-bottom:8px;">
      <select class="tb-select" id="newUserRole" style="margin-bottom:8px;">
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
      <div><button class="btn btn-sm" id="createUserBtn">Create and send invite</button></div>
      <div id="createUserErr" class="error-note" hidden style="margin-top:8px;"></div>
    </div>
    <div class="table-wrap" style="max-height:340px;">
      <table class="users-table">
        <thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById('createUserBtn').addEventListener('click',async(ev)=>{
    const btn=ev.currentTarget;
    if(btn.disabled)return; // a double-click here creates two accounts and two invite emails
    const username=document.getElementById('newUserName').value.trim();
    const role=document.getElementById('newUserRole').value;
    const email=document.getElementById('newUserEmail').value.trim();
    const errEl=document.getElementById('createUserErr');
    errEl.hidden=true;
    if(!email){ errEl.textContent='Email is required.'; errEl.hidden=false; return; }
    btn.disabled=true;
    try{
      const u=await window.api.createUser({username,role,email});
      if(!u.inviteEmailSent) toast(u.inviteEmailError||'Invite email could not be sent.');
      openUsers();
    }catch(e){ btn.disabled=false; errEl.textContent=e.message; errEl.hidden=false; }
  });
  usersBody.querySelectorAll('.resendInviteBtn').forEach(b=>b.addEventListener('click',async()=>{
    const id=parseInt(b.dataset.id,10);
    try{
      const u=await window.api.resendInvite(id);
      toast(u.inviteEmailSent?'Invite resent.':(u.inviteEmailError||'Invite email could not be sent.'));
    }catch(e){ alert(e.message); }
    openUsers();
  }));

  usersBody.querySelectorAll('.emailInput').forEach(inp=>inp.addEventListener('change',async(e)=>{
    const id=parseInt(e.target.dataset.id,10);
    try{ await window.api.setUserEmail(id,e.target.value.trim()); }
    catch(err){ alert(err.message); openUsers(); }
  }));

  usersBody.querySelectorAll('.roleSelect').forEach(sel=>sel.addEventListener('change',async(e)=>{
    const id=parseInt(e.target.dataset.id,10);
    try{ await window.api.changeUserRole(id,e.target.value); }
    catch(err){ alert(err.message); }
    openUsers();
  }));
  usersBody.querySelectorAll('.deactivateBtn').forEach(b=>b.addEventListener('click',async()=>{
    const id=parseInt(b.dataset.id,10);
    try{ await window.api.deactivateUser(id); }
    catch(err){ alert(err.message); }
    openUsers();
  }));
  usersBody.querySelectorAll('.reactivateBtn').forEach(b=>b.addEventListener('click',async()=>{
    await window.api.reactivateUser(parseInt(b.dataset.id,10));
    openUsers();
  }));
  usersBody.querySelectorAll('.resetPwBtn').forEach(b=>b.addEventListener('click',()=>{
    resetPwId=parseInt(b.dataset.id,10);
    renderUsers(list);
  }));
  usersBody.querySelectorAll('.resetPwCancelBtn').forEach(b=>b.addEventListener('click',()=>{
    resetPwId=null;
    renderUsers(list);
  }));
  const resetToggle=usersBody.querySelector('.resetPwToggleBtn');
  if(resetToggle) wirePasswordToggle(resetToggle,document.getElementById('resetPwInput'));
  usersBody.querySelectorAll('.resetPwSaveBtn').forEach(b=>b.addEventListener('click',async()=>{
    const id=parseInt(b.dataset.id,10);
    const pw=document.getElementById('resetPwInput').value;
    try{ await window.api.resetUserPassword(id,pw); resetPwId=null; openUsers(); }
    catch(err){ alert(err.message); }
  }));
}
document.getElementById('usersBtn').addEventListener('click',openUsers);
document.getElementById('usersClose').addEventListener('click',()=>usersModal.hidden=true);

// ---- Admin: Audit log ----
const auditModal=document.getElementById('auditModal');
const auditBody=document.getElementById('auditBody');
async function openAuditLog(){
  auditModal.hidden=false;
  auditBody.innerHTML='<div class="gen-status">Loading…</div>';
  let userList,actionList;
  try{ [userList,actionList]=await Promise.all([window.api.listUsers(),window.api.listAuditActions()]); }
  catch(e){ auditBody.innerHTML=errorBlock('Could not load the audit log: '+e.message); return; }
  auditBody.innerHTML=`
    <div class="toolbar" style="padding:0 0 14px;background:transparent;border:none;">
      <div class="toolbar-group"><label class="tb-label">User</label>
        <select id="auditFilterUser" class="tb-select"><option value="">Any</option>
          ${userList.map(u=>`<option value="${u.id}">${esc(u.username)}</option>`).join('')}</select></div>
      <div class="toolbar-group"><label class="tb-label">Action</label>
        <select id="auditFilterAction" class="tb-select"><option value="">Any</option>
          ${actionList.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></div>
      <div class="toolbar-group"><label class="tb-label">When</label>
        <select id="auditFilterRange" class="tb-select">
          <option value="">All time</option>
          <option value="day">Past day</option>
          <option value="week">Past week</option>
          <option value="month">Past month</option>
        </select></div>
    </div>
    <div class="table-wrap" style="max-height:420px;">
      <table class="audit-table">
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Prospect</th><th>Detail</th></tr></thead>
        <tbody id="auditRows"></tbody>
      </table>
    </div>`;
  const refresh=async()=>{
    const filters={
      userId:document.getElementById('auditFilterUser').value,
      action:document.getElementById('auditFilterAction').value,
      range:document.getElementById('auditFilterRange').value
    };
    const entries=await window.api.listAudit(filters);
    renderAuditRows(entries);
  };
  ['auditFilterUser','auditFilterAction','auditFilterRange'].forEach(id=>document.getElementById(id).addEventListener('change',refresh));
  refresh();
}
function renderAuditRows(entries){
  const rows=document.getElementById('auditRows');
  if(!entries.length){ rows.innerHTML=`<tr><td colspan="5" class="fu-cell">No matching audit entries.</td></tr>`; return; }
  rows.innerHTML=entries.map(e=>{
    const p=allProspects.find(x=>x.id===e.prospectId);
    const when=new Date(e.at).toLocaleString();
    return `<tr>
      <td class="fu-cell">${esc(when)}</td>
      <td>${esc(e.username)}</td>
      <td class="fu-cell">${esc(e.action)}</td>
      <td>${p?esc(p.company_name):'—'}</td>
      <td class="fu-cell">${esc(e.detail)}</td>
    </tr>`;
  }).join('');
}
document.getElementById('auditBtn').addEventListener('click',openAuditLog);
document.getElementById('auditClose').addEventListener('click',()=>auditModal.hidden=true);

// ---- Add prospects (upload dossier JSONs from any device) ----
document.getElementById('addProspectsBtn').addEventListener('click',openUpload);
function openUpload(){
  emailModalTitle.textContent='Add prospects';
  emailModal.hidden=false;
  emailModalBody.innerHTML=`
    <div class="q-hint">Upload dossier JSON files. Drop them below or pick files. Each is added to the shared database and appears for everyone. Duplicates (same UEI) are skipped automatically.</div>
    <div id="dropZone" style="border:2px dashed var(--line);border-radius:10px;padding:34px;text-align:center;color:var(--text-soft);cursor:pointer;margin-bottom:12px;">
      <div style="font-size:14px;margin-bottom:6px;">Drop dossier JSON files here</div>
      <div style="font-size:12px;color:var(--text-faint);">or click to choose files</div>
    </div>
    <input type="file" id="fileInput" accept=".json,application/json" multiple style="display:none;">
    <div id="uploadResult" class="q-hint"></div>`;
  const dz=document.getElementById('dropZone');
  const fi=document.getElementById('fileInput');
  dz.addEventListener('click',()=>fi.click());
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='var(--gold-deep)';dz.style.background='var(--gold-soft)';});
  dz.addEventListener('dragleave',()=>{dz.style.borderColor='var(--line)';dz.style.background='';});
  dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='var(--line)';dz.style.background='';handleFiles(e.dataTransfer.files);});
  fi.addEventListener('change',()=>handleFiles(fi.files));
}
async function handleFiles(fileList){
  const files=[...fileList].filter(f=>f.name.toLowerCase().endsWith('.json'));
  const result=document.getElementById('uploadResult');
  if(!files.length){result.innerHTML='<span style="color:var(--red)">No JSON files selected.</span>';return;}
  result.textContent=`Reading ${files.length} file(s)…`;
  const dossiers=[];
  const parseErrors=[];
  for(const f of files){
    try{ const text=await f.text(); dossiers.push({filename:f.name,dossier:JSON.parse(text)}); }
    catch(e){ parseErrors.push(f.name); }
  }
  if(!dossiers.length){result.innerHTML=`<span style="color:var(--red)">Could not parse any files. Are they valid JSON?</span>`;return;}
  result.textContent=`Uploading ${dossiers.length} dossier(s)…`;
  try{
    const r=await window.api.uploadDossiers(dossiers);
    let msg=`Added ${r.ingested}. `;
    if(r.duplicate)msg+=`${r.duplicate} already in CRM (skipped). `;
    if(r.excluded)msg+=`${r.excluded} excluded. `;
    if(parseErrors.length)msg+=`${parseErrors.length} unreadable. `;
    if(r.errors&&r.errors.length)msg+=`${r.errors.length} failed. `;
    result.innerHTML=`<span style="color:var(--green)">${esc(msg)}</span>`;
    loadProspects();
  }catch(e){ result.innerHTML=`<span style="color:var(--red)">Upload failed: ${esc(e.message)}</span>`; }
}

// ---- Sidebar views, toolbar wiring ----
const viewTitleEl=document.getElementById('viewTitle');
document.querySelectorAll('.view-item[data-view]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.view-item[data-view]').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); currentView=b.dataset.view;
  if(viewTitleEl)viewTitleEl.textContent=b.querySelector('.view-label').textContent;
  // A full-screen prospect hides the list entirely, so switching views behind it would do
  // nothing visible. Close it and return to the list showing the view that was clicked.
  if(detailFullScreen){ setFullScreen(false); detailPane.hidden=true; selectedId=null; }
  renderList();
}));

// ---- Reorderable views (sidebar "Views" section) ----
// Order is a personal display preference, not app data — kept in localStorage per browser
// rather than synced through the server, same trust boundary as sort/filter choices.
const VIEW_ORDER_KEY='viewOrder';
(function initViewReorder(){
  const container=document.querySelector('.sidebar-section'); // first section = Views
  const items=[...container.querySelectorAll('.view-item[data-view]')];
  let saved;
  try{ saved=JSON.parse(localStorage.getItem(VIEW_ORDER_KEY)||'null'); }catch{ saved=null; }
  if(Array.isArray(saved)){
    const byView=new Map(items.map(el=>[el.dataset.view,el]));
    const heading=container.querySelector('.sidebar-heading');
    for(const v of saved){ const el=byView.get(v); if(el){ container.appendChild(el); byView.delete(v); } }
    for(const el of byView.values()) container.appendChild(el); // any view not in the saved order goes last
    if(heading)container.insertBefore(heading,container.firstChild);
  }
  items.forEach(el=>{
    el.draggable=true;
    el.addEventListener('dragstart',(e)=>{ e.dataTransfer.setData('text/plain',el.dataset.view); el.classList.add('dragging'); });
    // Saved on dragend, not on drop. dragover already moved the element, but 'drop' only
    // fires when the pointer is released over a target that called preventDefault — i.e. over
    // another view item. Releasing on the "Views" heading, in the gap below the list, outside
    // the sidebar, or cancelling with Escape skipped the save entirely, leaving the new order
    // on screen but the old one in localStorage, so it silently reverted on the next reload.
    // dragend always fires, however the drag ended.
    el.addEventListener('dragend',()=>{
      el.classList.remove('dragging');
      const order=[...container.querySelectorAll('.view-item[data-view]')].map(x=>x.dataset.view);
      localStorage.setItem(VIEW_ORDER_KEY,JSON.stringify(order));
    });
    el.addEventListener('dragover',(e)=>{
      e.preventDefault();
      const dragging=container.querySelector('.view-item.dragging');
      if(!dragging||dragging===el)return;
      const rect=el.getBoundingClientRect();
      const before=(e.clientY-rect.top)<rect.height/2;
      container.insertBefore(dragging,before?el:el.nextSibling);
    });
    el.addEventListener('drop',(e)=>e.preventDefault()); // keep the browser from treating the payload as a navigation
  });
})();
['filterFit','filterState','filterAgency','filterDesignation','sortBy'].forEach(id=>document.getElementById(id).addEventListener('change',renderList));
searchEl.addEventListener('input',renderList);
document.getElementById('closeDetail').addEventListener('click',()=>{setFullScreen(false);detailPane.hidden=true;selectedId=null;renderList();});
document.getElementById('revealBtn').addEventListener('click',()=>window.api.revealWatched());
document.getElementById('emptyReveal').addEventListener('click',()=>window.api.revealWatched());

// bulk actions
document.getElementById('selectAll').addEventListener('change',(e)=>{
  const visible=sortList(applyToolbar(allProspects.filter(matchesView)));
  if(e.target.checked)visible.forEach(p=>selectedIds.add(p.id)); else selectedIds.clear();
  renderList(); updateBulkBar();
});
// Each row is its own request, so a failure part-way through used to abandon the loop with
// no message at all: some prospects changed, some didn't, the bulk bar still said
// "20 selected", and the screen still showed the old values. Now every row is attempted,
// and whatever failed is named on screen.
document.querySelectorAll('[data-bulk]').forEach(b=>b.addEventListener('click',async()=>{
  if(b.disabled)return;
  const action=b.dataset.bulk; const ids=[...selectedIds];
  if(!ids.length)return;
  const nameOf=(id)=>{ const p=allProspects.find(x=>x.id===id); return (p&&p.company_name)||`#${id}`; };
  // Returns the ids that failed, each with the reason, so the caller can both report them
  // and tell which rows actually changed.
  const runAll=async(fn,list)=>{
    const failed=[];
    for(const id of (list||ids)){ try{ await fn(id); }catch(e){ failed.push({id,why:`${nameOf(id)} (${e.message})`}); } }
    return failed;
  };
  const describe=(failed)=>failed.map(f=>f.why).join('; ');
  b.disabled=true;
  try{
    if(action==='delete'){
      if(!confirm(`Delete ${ids.length} prospect(s)?`))return;
      const failed=await runAll(id=>window.api.deleteProspect(id));
      // If the open prospect was one of the deleted, close the pane — otherwise it kept
      // showing a record that no longer exists, and acting on it 404'd.
      if(selectedId!=null&&ids.includes(selectedId)){ setFullScreen(false); detailPane.hidden=true; selectedId=null; }
      selectedIds.clear(); updateBulkBar(); loadProspects();
      if(failed.length)toast(`${failed.length} of ${ids.length} could not be deleted: ${describe(failed)}`,7000);
      return;
    }
    const prevStatuses={};
    allProspects.filter(p=>ids.includes(p.id)).forEach(p=>{prevStatuses[p.id]=p.status;});
    if(action==='dead'){
      const reason=window.prompt(DEAD_REASON_PROMPT_BULK);
      if(reason&&reason.trim()){
        const noteFailed=await runAll(id=>window.api.addNote(id,reason.trim()));
        if(noteFailed.length)toast(`The reason note could not be saved on ${noteFailed.length} prospect(s)`,5000);
      }
    }
    const failed=await runAll(id=>window.api.updateProspect(id,{status:action}));
    const changed=ids.filter(id=>!failed.some(f=>f.id===id));
    selectedIds.clear(); updateBulkBar(); loadProspects();
    if(failed.length)toast(`${failed.length} of ${ids.length} could not be updated: ${describe(failed)}`,7000);
    if(changed.length){
      toastUndo(`${changed.length} prospect(s) moved to ${statusLabel(action)}`,async()=>{
        const undoFailed=await runAll(id=>window.api.updateProspect(id,{status:prevStatuses[id]}),changed);
        loadProspects();
        if(undoFailed.length)toast(`${undoFailed.length} could not be reverted: ${describe(undoFailed)}`,7000);
      });
    }
  } finally { b.disabled=false; }
}));

// live ingest
window.api.onIngested((r)=>{ if(r.outcome==='ingested'){loadProspects();toast('New prospect added from research');} else if(r.outcome==='duplicate'){toast('Skipped a duplicate');} else if(r.outcome==='excluded'){toast(`Research file ${r.file?`"${r.file}" `:''}was skipped — that company is on the do-not-contact list`,7000);} });
window.api.onReply((r)=>{ loadProspects(); if(r.company_name)toast(`New reply from ${r.company_name}`); });
window.api.onBooked((r)=>{ loadProspects(); toast(`${r.company_name||'A prospect'} booked a meeting: ${r.label||''}`,8000); });
// Background connection/generation failures (Gmail polling, digest, backup, OAuth) surfaced
// with a short reference code — admin-only, since fixing these means opening Settings.
// Only admin sessions are sent this event (the server filters it), so no role check is needed
// here — the earlier client-side check was never access control, just display gating.
window.api.onIssue((r)=>{ toast(`${r.message} (ref ${r.ref})`,10000); });
// A research file that never made it in. Held longer than a normal toast: this one needs acting on.
window.api.onIngestFailed((r)=>{ toast(`Research file "${r.file}" was not imported — ${r.reason}`,7000); });
// pointer-events:none matters as much as the fade: a faded-out toast is still a box
// sitting over the bottom of the screen, and without it, clicks in that strip landed on an
// invisible toast instead of the page underneath.
function toast(msg,ms=2200){let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.id='toast';t.setAttribute('role','status');t.setAttribute('aria-live','polite');t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--on-dark);padding:10px 18px;border-radius:var(--radius-full);font-size:13px;font-weight:500;z-index:100;box-shadow:var(--shadow-lg);opacity:0;pointer-events:none;transition:opacity var(--duration-base) var(--ease);';document.body.appendChild(t);}t.textContent=msg;t.style.opacity='1';clearTimeout(t._timer);t._timer=setTimeout(()=>{t.style.opacity='0';},ms);}

// A bottom-right toast with an Undo button, for status/view changes: shows what happened
// and gives a few seconds to catch a mistake and reverse it before it's gone.
function toastUndo(msg,onUndo,ms=6000){
  let t=document.getElementById('toastUndo');
  if(!t){
    t=document.createElement('div');
    t.id='toastUndo';
    t.style.cssText='position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--on-dark);padding:10px 12px 10px 16px;border-radius:var(--radius-lg);font-size:13px;font-weight:500;z-index:100;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow-lg);opacity:0;transition:opacity var(--duration-base) var(--ease);';
    document.body.appendChild(t);
  }
  clearTimeout(t._timer);
  t.innerHTML=`<span>${esc(msg)}</span><button class="btn btn-sm" id="toastUndoBtn" style="flex-shrink:0;">Undo</button>`;
  t.style.opacity='1';
  t.style.pointerEvents='auto';
  const dismiss=()=>{ t.style.opacity='0'; t.style.pointerEvents='none'; clearTimeout(t._timer); };
  document.getElementById('toastUndoBtn').addEventListener('click',async()=>{
    dismiss();
    await onUndo();
  });
  // Faded out but still clickable, this Undo button used to stay armed indefinitely: a
  // stray click on that corner minutes later silently reverted the last status change.
  t._timer=setTimeout(dismiss,ms);
}

// Shown in place of a plain error when a send is blocked by the do-not-contact list (see
// server.js's blockIfExcluded — used by both the outreach and reply send routes). Any
// user can mark the prospect dead and move on; only an admin can remove the matched rule
// and retry the same send via onRetry.
function renderExclusionBlock(container,exclusion,prospectId,onRetry){
  const isAdmin=window.__currentUser&&window.__currentUser.role==='admin';
  container.hidden=false;
  container.innerHTML=`
    <div>This company is on the do-not-contact list (matched ${esc(exclusion.match_type)}: "${esc(exclusion.value)}"). Sending is blocked.</div>
    <div class="modal-actions" style="margin-top:8px;">
      ${isAdmin?`<button class="btn btn-sm" id="removeExclusionBtn">Remove from exclusions and send</button>`:''}
      <button class="btn btn-ghost btn-sm" id="exclusionMarkDeadBtn">Mark dead and move on</button>
    </div>`;
  const removeBtn=document.getElementById('removeExclusionBtn');
  if(removeBtn)removeBtn.addEventListener('click',async()=>{
    try{ await window.api.removeExclusion(exclusion.match_type,exclusion.value); toast('Exclusion removed.'); onRetry(); }
    catch(err){ alert(err.message); }
  });
  document.getElementById('exclusionMarkDeadBtn').addEventListener('click',async()=>{
    const reason=window.prompt(DEAD_REASON_PROMPT);
    if(reason&&reason.trim())await window.api.addNote(prospectId,reason.trim());
    await window.api.updateProspect(prospectId,{status:'dead'});
    emailModal.hidden=true; replyModal.hidden=true; loadProspects();
    toast('Marked dead.');
  });
}

// After the Gmail OAuth redirect lands back on the app (see server.js's
// /api/admin/gmail/callback), surface the result and clean the URL.
function checkGmailRedirect(){
  const params=new URLSearchParams(location.search);
  const g=params.get('gmail');
  if(!g)return;
  if(g==='connected'){ toast('Gmail connected.'); openSettings(); }
  else if(g==='error'){ const ref=params.get('ref'); toast(`Could not connect Gmail. Check the Client ID/Secret and try again.${ref?` (ref ${ref})`:''}`,8000); openSettings(); }
  history.replaceState(null,'',location.pathname);
}

// Escape closes the topmost open modal through its own Close button, so the exact same
// cleanup runs as a mouse close (e.g. emailModalClose also strips the modal-wide class).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const closeIds = ['replyModalClose', 'emailModalClose', 'settingsClose', 'usersClose', 'auditClose'];
  for (const id of closeIds) {
    const btn = document.getElementById(id);
    if (btn && !btn.closest('.modal-backdrop').hidden) { btn.click(); return; }
  }
});

// Keep Tab inside the topmost open modal. Without this, tabbing past the last control
// lands on the page underneath — invisible behind the backdrop but still activatable
// with Enter, so a keyboard user could unknowingly click a hidden button.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const openModal = [...document.querySelectorAll('.modal-backdrop')].find(m => !m.hidden);
  if (!openModal) return;
  const focusables = [...openModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  const inside = openModal.contains(document.activeElement);
  if (!inside) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Wait for the login gate to authenticate before loading any data (API calls need the session).
if (window.__authed) { applyRoleUI(); loadProspects(); checkGmailRedirect(); }
else { document.addEventListener('authed', () => { applyRoleUI(); loadProspects(); checkGmailRedirect(); }, { once: true }); }
