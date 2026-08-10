// renderer.js — GovSpring Prospecting CRM UI
// Talks to the app only through window.api (see preload.js).

let allProspects = [];
let selectedId = null;
let currentView = 'all';
let selectedIds = new Set();

const rowsEl     = document.getElementById('rows');
const emptyEl    = document.getElementById('emptyState');
const searchEl   = document.getElementById('searchBox');
const detailPane = document.getElementById('detailPane');
const bulkBar    = document.getElementById('bulkBar');

function esc(s){return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function shorten(s,n){s=s||'';return s.length>n?s.slice(0,n-1)+'…':s;}
function scoreClass(s){return (s==null)?'score-none':'score-'+s;}
function todayStr(){return new Date().toISOString().slice(0,10);}
function daysBetween(a,b){return Math.floor((new Date(b)-new Date(a))/86400000);}

// ---- Derived per-prospect state ----

// Is this prospect due for a follow-up? (sent, not replied, and cadence days have passed)
function isDue(p){
  if(p.status!=='sent') return false;
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

  emptyEl.hidden = filtered.length!==0;

  rowsEl.innerHTML = filtered.map(p=>{
    const flags=[];
    if(isOverdue(p)) flags.push('<span class="flag flag-overdue">Overdue</span>');
    if(!hasContact(p)) flags.push('<span class="flag flag-nocontact">No contact</span>');
    if(p.fit_score!=null && p.fit_score<=3 && p.status==='new') flags.push('<span class="flag flag-hot">Hot</span>');

    let fu='';
    if(p.status==='sent' && p.date_sent){
      const gap=p.followup_days||4;
      const due=daysBetween(p.date_sent,todayStr())>=gap;
      const dueInDays=gap-daysBetween(p.date_sent,todayStr());
      fu = due ? `<span class="fu-overdue">due now</span>` : `in ${dueInDays}d`;
    }

    return `<tr data-id="${p.id}" class="${p.id===selectedId?'selected':''}">
      <td class="col-check"><input type="checkbox" class="rowcheck" data-id="${p.id}" ${selectedIds.has(p.id)?'checked':''}></td>
      <td class="col-score"><span class="score-chit ${scoreClass(p.fit_score)}">${p.fit_score??'—'}</span></td>
      <td><div class="company-cell">${esc(p.company_name)}</div>${p.industry?`<div class="company-sub">${esc(shorten(p.industry,42))}</div>`:''}</td>
      <td>${esc(p.city_state)}</td>
      <td><span class="status-pill status-${p.status}">${esc(p.status)}</span></td>
      <td><span class="flags">${flags.join('')}</span></td>
      <td class="fu-cell">${fu}</td>
    </tr>`;
  }).join('');

  rowsEl.querySelectorAll('tr').forEach(tr=>{
    tr.addEventListener('click',(e)=>{ if(e.target.classList.contains('rowcheck'))return; openDetail(parseInt(tr.dataset.id,10)); });
  });
  rowsEl.querySelectorAll('.rowcheck').forEach(cb=>{
    cb.addEventListener('change',()=>{ const id=parseInt(cb.dataset.id,10); if(cb.checked)selectedIds.add(id);else selectedIds.delete(id); updateBulkBar(); });
  });
}

function updateBulkBar(){
  bulkBar.hidden = selectedIds.size===0;
  if(selectedIds.size) document.getElementById('bulkCount').textContent = `${selectedIds.size} selected`;
}

async function refreshCountsAndFilters(){
  const counts={all:0,new:0,due:0,awaiting:0,replied:0,signed:0};
  const states=new Set(), agencies=new Set(), designations=new Set();
  for(const p of allProspects){
    counts.all++;
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

function field(k,v,link){ if(!v)return''; const val=link?`<a href="${esc(v)}" target="_blank" rel="noreferrer">${esc(v)}</a>`:esc(v); return `<div class="field"><span class="field-key">${k}:</span> <span class="field-val">${val}</span></div>`; }
function litLine(l,t){ if(!t)return''; const cls=/NEEDS CHECKING/i.test(t)?'needs-check':''; return `<div class="field"><span class="field-key">${l}:</span> <span class="field-val ${cls}">${esc(t)}</span></div>`; }

async function openDetail(id){
  selectedId=id; renderList();
  const p=await window.api.getProspect(id);
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
  const activity=p.activity?JSON.parse(p.activity):[];

  document.getElementById('detailBody').innerHTML=`
    <div class="section">
      <div class="section-label">Status</div>
      <div class="field"><span class="status-pill status-${p.status}">${esc(p.status)}</span>
        ${p.date_sent?` <span class="field-key">sent ${esc(p.date_sent)}</span>`:''}
        ${p.followup_count?` <span class="field-key">· ${p.followup_count} follow-up(s)</span>`:''}</div>
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
          Follow-up gap <input type="number" id="fuDays" value="${p.followup_days||4}" min="1" max="30" style="width:52px;font:inherit;padding:3px 5px;border:1px solid var(--line);border-radius:5px;">d
        </label>
      </div>
    </div>

    ${p.final_sent?`<div class="section"><div class="section-label">Sent email</div><div class="prose" style="white-space:pre-wrap;">${esc(shorten(p.final_sent,600))}</div></div>`:''}

    ${activity.length?`<div class="section"><div class="section-label">Activity</div>${activity.slice().reverse().map(a=>`<div class="field"><span class="field-key">${esc(a.date)}:</span> <span class="field-val">${esc(a.text)}</span></div>`).join('')}</div>`:''}

    <div class="section">
      <div class="section-label">Identification</div>
      ${field('Industry',d.industry)}${field('Designations',d.designations)}${field('UEI',d.uei)}${field('CAGE',d.cage_code)}${field('Established',d.year_established)}
    </div>
    <div class="section">
      <div class="section-label">General contact <button class="btn btn-ghost btn-sm" id="editContactBtn" style="float:right;padding:2px 8px;">Edit</button></div>
      ${field('Website',c.website,true)}${field('Email',c.email)}${field('Phone',c.phone)}${field('LinkedIn',c.linkedin,true)}
    </div>
    ${contacts.length?`<div class="section"><div class="section-label">Decision-makers</div>${contacts.map(ct=>`<div class="field"><div class="field-val"><strong>${esc(ct.name||'(name not found)')}</strong> — ${esc(ct.title)}</div>${ct.email?`<div class="field-val">${esc(ct.email)}</div>`:''}${ct.linkedin?`<div class="field-val"><a href="${esc(ct.linkedin)}" target="_blank" rel="noreferrer">LinkedIn</a></div>`:''}</div>`).join('')}</div>`:''}
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
  document.getElementById('editContactBtn').addEventListener('click',()=>openEditContact(id,c));
  document.getElementById('statusSelect').addEventListener('change',async(e)=>{ if(e.target.value){ await window.api.updateProspect(id,{status:e.target.value}); loadProspects(); openDetail(id); } });
  document.getElementById('fuDays').addEventListener('change',async(e)=>{ await window.api.updateProspect(id,{followup_days:parseInt(e.target.value,10)||4}); });
  document.getElementById('deleteBtn').addEventListener('click',async()=>{ if(confirm(`Delete ${d.company_name}? This removes it entirely.`)){ await window.api.deleteProspect(id); detailPane.hidden=true; selectedId=null; loadProspects(); } });

  detailPane.hidden=false;
}

// ---- Simple prompt-style modals reusing the email modal shell ----
const emailModal=document.getElementById('emailModal');
const emailModalBody=document.getElementById('emailModalBody');
const emailModalTitle=document.getElementById('emailModalTitle');

function openLogExternal(id){
  emailModalTitle.textContent='Log outreach sent elsewhere';
  emailModal.hidden=false;
  emailModalBody.innerHTML=`
    <div class="q-hint">Paste an email, LinkedIn message, or a note about a call made outside the app. This records the outreach and starts the follow-up clock.</div>
    <div class="settings-field"><label>Channel</label>
      <select id="extChannel" class="field-input"><option value="email">Email</option><option value="linkedin">LinkedIn</option><option value="phone">Phone call</option></select></div>
    <div class="settings-field"><label>Message or note</label>
      <textarea id="extText" class="draft-area" style="min-height:180px;" placeholder="Paste the message sent, or note what was discussed on the call."></textarea></div>
    <div class="modal-actions"><button class="btn" id="extSave">Save outreach</button>
      <span class="usage-note">Marks the prospect as contacted and sets the follow-up date.</span></div>`;
  document.getElementById('extSave').addEventListener('click',async()=>{
    const channel=document.getElementById('extChannel').value;
    const text=document.getElementById('extText').value.trim();
    if(!text)return;
    await window.api.logExternal(id,{channel,text});
    emailModal.hidden=true; loadProspects(); openDetail(id);
  });
}

function openNote(id){
  emailModalTitle.textContent='Add note';
  emailModal.hidden=false;
  emailModalBody.innerHTML=`
    <div class="settings-field"><label>Note</label>
      <textarea id="noteText" class="draft-area" style="min-height:120px;" placeholder="e.g. Spoke with Gary, interested but busy until September."></textarea></div>
    <div class="modal-actions"><button class="btn" id="noteSave">Save note</button></div>`;
  document.getElementById('noteSave').addEventListener('click',async()=>{
    const text=document.getElementById('noteText').value.trim();
    if(!text)return;
    await window.api.addNote(id,text);
    emailModal.hidden=true; openDetail(id);
  });
}

function openEditContact(id,c){
  emailModalTitle.textContent='Edit contact details';
  emailModal.hidden=false;
  const f=(k,v)=>`<div class="settings-field"><label>${k}</label><input class="field-input" id="ec_${k}" value="${esc(v||'')}"></div>`;
  emailModalBody.innerHTML=`${f('website',c.website)}${f('email',c.email)}${f('phone',c.phone)}${f('linkedin',c.linkedin)}
    <div class="modal-actions"><button class="btn" id="ecSave">Save</button></div>`;
  document.getElementById('ecSave').addEventListener('click',async()=>{
    const patch={website:val('ec_website'),email:val('ec_email'),phone:val('ec_phone'),linkedin:val('ec_linkedin')};
    await window.api.editContact(id,patch);
    emailModal.hidden=true; openDetail(id);
  });
  function val(x){return document.getElementById(x).value.trim();}
}

// ---- Email generation flow ----
let flowState=null;
async function openEmailFlow(prospectId,dossier,isFollowup){
  flowState={prospectId,dossier,isFollowup,issueId:null,services:[],personalNote:null};
  emailModalTitle.textContent=isFollowup?'Draft follow-up':'Generate email';
  emailModal.hidden=false;
  const cfg=await window.api.getConfig();
  if(!cfg.hasApiKey){
    emailModalBody.innerHTML=`<div class="error-note">No Anthropic API key is set. Add it in Settings to generate drafts.</div><div class="modal-actions"><button class="btn" id="goSettings">Open Settings</button></div>`;
    document.getElementById('goSettings').addEventListener('click',()=>{emailModal.hidden=true;openSettings();});
    return;
  }
  if(isFollowup){ runGeneration(); return; }
  const q=await window.api.emailQuestions(prospectId);
  renderQuestions(q);
}

function renderQuestions(q){
  const issueOpts=q.issueOptions.map(o=>`<div class="opt" data-kind="issue" data-id="${o.id}"><div class="opt-title">${esc(o.label)}</div>${o.detail?`<div class="opt-detail">${esc(shorten(o.detail,140))}</div>`:''}</div>`).join('');
  const svcOpts=q.serviceOptions.map(o=>`<div class="opt" data-kind="service" data-id="${esc(o.id)}"><span class="opt-title">${esc(o.label)}</span><span class="opt-tags">${o.suggested?'<span class="tag tag-suggested">suggested</span>':''}${o.proven?'<span class="tag tag-proven">proven</span>':''}</span></div>`).join('');
  const personalBlock=(q.personalHooks&&q.personalHooks.length)?`<div class="q-block"><div class="q-label">Personal touch (optional)</div><div class="q-hint">Catalog hooks that may fit this prospect. Pick any to weave in, or none.</div>${q.personalHooks.map(h=>`<div class="opt" data-kind="hook" data-id="${esc(h.id)}"><div class="opt-title">${esc(h.label)}</div><div class="opt-detail">${esc(h.suggestion)}</div></div>`).join('')}</div>`:'';
  emailModalBody.innerHTML=`
    <div class="q-block"><div class="q-label">1. Which issue should the email lead with?</div><div class="q-hint">Pulled from this prospect's research.</div>${issueOpts}</div>
    <div class="q-block"><div class="q-label">2. Which services should we pitch?</div><div class="q-hint">Choose one or two. Suggested ones match their issues.</div>${svcOpts}</div>
    ${personalBlock}
    <div class="modal-actions"><button class="btn" id="genBtn" disabled>Generate draft</button><span class="usage-note">Two questions, then a draft.</span></div>`;
  emailModalBody.querySelectorAll('.opt[data-kind="issue"]').forEach(el=>el.addEventListener('click',()=>{emailModalBody.querySelectorAll('.opt[data-kind="issue"]').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');flowState.issueId=el.dataset.id;updateGen();}));
  emailModalBody.querySelectorAll('.opt[data-kind="service"]').forEach(el=>el.addEventListener('click',()=>{const id=el.dataset.id;const i=flowState.services.indexOf(id);if(i>=0){flowState.services.splice(i,1);el.classList.remove('selected');}else{if(flowState.services.length>=2)return;flowState.services.push(id);el.classList.add('selected');}updateGen();}));
  flowState.hooks=[];
  emailModalBody.querySelectorAll('.opt[data-kind="hook"]').forEach(el=>el.addEventListener('click',()=>{const id=el.dataset.id;const i=flowState.hooks.indexOf(id);if(i>=0){flowState.hooks.splice(i,1);el.classList.remove('selected');}else{flowState.hooks.push(id);el.classList.add('selected');}}));
  document.getElementById('genBtn').addEventListener('click',()=>{
    const chosen=(q.personalHooks||[]).filter(h=>flowState.hooks.includes(h.id)).map(h=>h.suggestion);
    flowState.personalNote=chosen.length?chosen.join(' '):null;
    runGeneration();
  });
}
function updateGen(){const b=document.getElementById('genBtn');if(b)b.disabled=!(flowState.issueId&&flowState.services.length>=1);}

async function runGeneration(){
  emailModalBody.innerHTML=`<div class="gen-status">Writing the draft in Marcos's voice…</div>`;
  const res=await window.api.emailGenerate(flowState.prospectId,{issueId:flowState.issueId,services:flowState.services,personalNote:flowState.personalNote,isFollowup:flowState.isFollowup});
  if(!res.ok){ emailModalBody.innerHTML=`<div class="error-note">Couldn't generate: ${esc(res.error)}</div><div class="modal-actions"><button class="btn btn-ghost" id="backBtn">Back</button></div>`; document.getElementById('backBtn').addEventListener('click',()=>openEmailFlow(flowState.prospectId,flowState.dossier,flowState.isFollowup)); return; }
  renderDraft(res.draft,res.usage);
}

function renderDraft(draft,usage){
  const tokens=usage&&usage.output_tokens?`${usage.input_tokens||0} in / ${usage.output_tokens} out`:'';
  emailModalBody.innerHTML=`
    <div class="q-hint">Review and edit. Paste the version you actually send back here and save so the app learns from your changes.</div>
    <textarea class="draft-area" id="draftArea">${esc(draft)}</textarea>
    <div class="modal-actions"><button class="btn" id="copyBtn">Copy to clipboard</button><button class="btn btn-ghost" id="regenBtn">Regenerate</button><div class="spacer"></div><span class="usage-note">${tokens}</span></div>
    <div class="modal-actions"><button class="btn" id="saveFinalBtn">${flowState.isFollowup?'Save follow-up as sent':'Save as sent'}</button><span class="usage-note">Marks sent and adds to the learning library.</span></div>`;
  document.getElementById('copyBtn').addEventListener('click',()=>{navigator.clipboard.writeText(document.getElementById('draftArea').value);const b=document.getElementById('copyBtn');b.textContent='Copied';setTimeout(()=>{if(b)b.textContent='Copy to clipboard';},1500);});
  document.getElementById('regenBtn').addEventListener('click',()=>{ if(flowState.isFollowup)runGeneration(); else openEmailFlow(flowState.prospectId,flowState.dossier,false); });
  document.getElementById('saveFinalBtn').addEventListener('click',async()=>{
    const finalText=document.getElementById('draftArea').value;
    await window.api.emailSaveFinal(flowState.prospectId,finalText,{services:flowState.services,channel:'email',isFollowup:flowState.isFollowup});
    emailModal.hidden=true; loadProspects(); openDetail(flowState.prospectId);
  });
}

document.getElementById('emailModalClose').addEventListener('click',()=>emailModal.hidden=true);

// ---- Settings ----
const settingsModal=document.getElementById('settingsModal');
const settingsBody=document.getElementById('settingsBody');
async function openSettings(){
  const cfg=await window.api.getConfig();
  settingsModal.hidden=false;
  settingsBody.innerHTML=`
    <div class="settings-field"><label>Anthropic API key</label>
      <div class="hint">Used to generate email drafts. Starts with sk-ant-. Stored only on this machine.</div>
      <input type="password" class="field-input" id="apiKeyInput" placeholder="${cfg.hasApiKey?'•••• set (ends '+esc(cfg.keyTail)+')':'sk-ant-...'}">
      <div class="key-status ${cfg.hasApiKey?'key-set':'key-unset'}">${cfg.hasApiKey?'A key is set.':'No key set yet.'}</div></div>
    <div class="settings-field"><label>Research output folder</label>
      <div class="hint">Where your research agent writes dossier JSON. The app watches this and its batch subfolders.</div>
      <div id="watchPathDisplay" class="key-status" style="word-break:break-all;margin-bottom:8px;"></div>
      <button class="btn btn-ghost btn-sm" id="chooseWatchBtn">Choose folder</button>
      <button class="btn btn-ghost btn-sm" id="resetWatchBtn">Use default</button></div>
    <div class="settings-field"><label>Default follow-up gap (days)</label>
      <input type="number" class="field-input" id="followupDaysInput" value="${cfg.defaultFollowupDays}" min="1" max="30" style="width:100px"></div>
    <div class="modal-actions"><button class="btn" id="saveSettingsBtn">Save</button></div>`;
  window.api.watchedPath().then(p=>{const el=document.getElementById('watchPathDisplay');if(el)el.textContent=p;});
  document.getElementById('chooseWatchBtn').addEventListener('click',async()=>{const r=await window.api.chooseWatched();document.getElementById('watchPathDisplay').textContent=r.path;loadProspects();});
  document.getElementById('resetWatchBtn').addEventListener('click',async()=>{const r=await window.api.resetWatched();document.getElementById('watchPathDisplay').textContent=r.path;});
  document.getElementById('saveSettingsBtn').addEventListener('click',async()=>{const key=document.getElementById('apiKeyInput').value.trim();if(key)await window.api.setApiKey(key);const days=parseInt(document.getElementById('followupDaysInput').value,10);if(days)await window.api.updateConfig({defaultFollowupDays:days});settingsModal.hidden=true;});
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

// ---- Admin: Users ----
const usersModal=document.getElementById('usersModal');
const usersBody=document.getElementById('usersBody');
async function openUsers(){
  usersModal.hidden=false;
  usersBody.innerHTML='<div class="gen-status">Loading…</div>';
  const list=await window.api.listUsers();
  renderUsers(list);
}
function renderUsers(list){
  const me=window.__currentUser;
  const rows=list.map(u=>{
    const isSelf=u.id===me.id;
    return `<tr data-id="${u.id}">
      <td><strong>${esc(u.username)}</strong>${isSelf?' <span class="field-key">(you)</span>':''}</td>
      <td><select class="tb-select roleSelect" data-id="${u.id}">
        <option value="user" ${u.role==='user'?'selected':''}>User</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
      </select></td>
      <td><span class="status-pill ${u.active?'badge-active':'badge-inactive'}">${u.active?'active':'inactive'}</span></td>
      <td>
        ${u.active
          ?`<button class="btn btn-ghost btn-sm deactivateBtn" data-id="${u.id}">Deactivate</button>`
          :`<button class="btn btn-ghost btn-sm reactivateBtn" data-id="${u.id}">Reactivate</button>`}
        <button class="btn btn-ghost btn-sm resetPwBtn" data-id="${u.id}">Reset password</button>
      </td>
    </tr>`;
  }).join('');

  usersBody.innerHTML=`
    <div class="settings-field">
      <label>Create user</label>
      <div class="hint">Password must be at least 8 characters.</div>
      <input class="field-input" id="newUserName" placeholder="Username" style="margin-bottom:8px;">
      <input class="field-input" id="newUserPw" type="password" placeholder="Password" style="margin-bottom:8px;">
      <select class="tb-select" id="newUserRole" style="margin-bottom:8px;">
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
      <div><button class="btn btn-sm" id="createUserBtn">Create</button></div>
      <div id="createUserErr" class="error-note" hidden style="margin-top:8px;"></div>
    </div>
    <div class="table-wrap" style="max-height:340px;">
      <table class="users-table">
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById('createUserBtn').addEventListener('click',async()=>{
    const username=document.getElementById('newUserName').value.trim();
    const password=document.getElementById('newUserPw').value;
    const role=document.getElementById('newUserRole').value;
    const errEl=document.getElementById('createUserErr');
    errEl.hidden=true;
    try{
      await window.api.createUser({username,password,role});
      openUsers();
    }catch(e){ errEl.textContent=e.message; errEl.hidden=false; }
  });

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
  usersBody.querySelectorAll('.resetPwBtn').forEach(b=>b.addEventListener('click',async()=>{
    const id=parseInt(b.dataset.id,10);
    const pw=window.prompt('New password (minimum 8 characters):');
    if(!pw)return;
    try{ await window.api.resetUserPassword(id,pw); alert('Password reset.'); }
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
  const [userList,actionList]=await Promise.all([window.api.listUsers(),window.api.listAuditActions()]);
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

// ---- Sidebar views, tabs, toolbar wiring ----
document.querySelectorAll('.view-item[data-view]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.view-item[data-view]').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); currentView=b.dataset.view; renderList();
}));
['filterFit','filterState','filterAgency','filterDesignation','sortBy'].forEach(id=>document.getElementById(id).addEventListener('change',renderList));
searchEl.addEventListener('input',renderList);
document.getElementById('closeDetail').addEventListener('click',()=>{detailPane.hidden=true;selectedId=null;renderList();});
document.getElementById('revealBtn').addEventListener('click',()=>window.api.revealWatched());
document.getElementById('emptyReveal').addEventListener('click',()=>window.api.revealWatched());

// bulk actions
document.getElementById('selectAll').addEventListener('change',(e)=>{
  const visible=sortList(applyToolbar(allProspects.filter(matchesView)));
  if(e.target.checked)visible.forEach(p=>selectedIds.add(p.id)); else selectedIds.clear();
  renderList(); updateBulkBar();
});
document.querySelectorAll('[data-bulk]').forEach(b=>b.addEventListener('click',async()=>{
  const action=b.dataset.bulk; const ids=[...selectedIds];
  if(!ids.length)return;
  if(action==='delete'){ if(!confirm(`Delete ${ids.length} prospect(s)?`))return; for(const id of ids)await window.api.deleteProspect(id); }
  else { for(const id of ids)await window.api.updateProspect(id,{status:action}); }
  selectedIds.clear(); updateBulkBar(); loadProspects();
}));

// live ingest
window.api.onIngested((r)=>{ if(r.outcome==='ingested'){loadProspects();toast('New prospect added from research');} else if(r.outcome==='duplicate'){toast('Skipped a duplicate');} });
function toast(msg){let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;z-index:100;opacity:0;transition:opacity .2s;';document.body.appendChild(t);}t.textContent=msg;t.style.opacity='1';clearTimeout(t._timer);t._timer=setTimeout(()=>{t.style.opacity='0';},2200);}

// Wait for the login gate to authenticate before loading any data (API calls need the session).
if (window.__authed) { applyRoleUI(); loadProspects(); }
else { document.addEventListener('authed', () => { applyRoleUI(); loadProspects(); }, { once: true }); }
