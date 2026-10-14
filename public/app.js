'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value || 0).toLocaleString('zh-TW', {maximumFractionDigits: 0});
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(new Date());
let state = null, page = 'overview', employeeId = null, tab = 'basic', csrf = '', currentForm = null, busy = false;
const pages = {overview:'待辦總覽',employees:'員工檔案',insurance:'保險異動',salary:'薪資歷史',leave:'特休紀錄',documents:'文件配對',settings:'連線與匯入'};
const categoryNames = {identity:'身分證',bank:'存摺',license:'駕照'};
const employee = id => state.employees.find(e => e.id === id);
const employeeName = id => employee(id)?.name || id;
const active = emp => (!emp.arrivalDate || emp.arrivalDate <= today()) && (!emp.departureDate || emp.departureDate >= today());
function notify(text, error=false){$('message').textContent=text;$('message').classList.toggle('error',error);$('message').hidden=!text;}
async function request(path, body){
  const res=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-HR-CSRF':csrf}:{},body:body?JSON.stringify(body):undefined});
  let data;try{data=await res.json();}catch{throw Error('NAS沒有回傳資料，請重新載入並確認公司網路');}
  if(!res.ok)throw Error(data.error||'操作失敗');return data;
}
async function load(){state=await request('/api/state');csrf=state.csrf;render();}
async function action(path, body, success){
  if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const result=await request(path,body);await load();notify(result.warnings?.length?success+'\n'+result.warnings.join('\n'):success);return result;}
  catch(e){notify(e.message,true);throw e;}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);const sync=document.querySelector('[data-sync]');if(sync)sync.disabled=!state.settings.gasConfigured;}
}
function heading(title,subtitle='',buttons=''){return `<div class="page-head"><div><h1>${esc(title)}</h1><p class="muted">${esc(subtitle)}</p></div><div class="actions">${buttons}</div></div>`;}
const empty = (title,detail='') => `<div class="empty"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
const badge = (text,warn=false) => `<span class="badge${warn?' warn':''}">${esc(text)}</span>`;
function table(headers,rows){return rows.length?`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('尚無紀錄','新增或從打卡試算表匯入後顯示');}
function who(id){return `<button class="employee-link" data-employee="${esc(id)}">${esc(employeeName(id))}</button><div class="muted">${esc(id)}</div>`;}
const button = (text,form,emp='') => `<button data-form="${form}" data-id="${esc(emp)}">${esc(text)}</button>`;
function overview(){
  const pending=state.documents.filter(d=>d.available&&!d.employeeId),salaryPending=state.salaries.filter(s=>s.status==='待核對');
  const tasks=[];
  state.employees.filter(active).forEach(e=>{
    const insurance=state.records.filter(r=>r.employeeId===e.id&&r.kind==='insurance');
    if(!insurance.some(r=>r.type==='勞保'&&r.action==='加保'))tasks.push([e.id,'待登記勞保加保','以實際生效日期登記，不能只用到職日推定']);
    if(!insurance.some(r=>r.type==='健保'&&r.action==='加保'))tasks.push([e.id,'待登記健保加保','請確認實際加保及眷屬資料']);
    const docs=state.documents.filter(d=>d.employeeId===e.id&&d.available);
    for(const category of ['identity','bank'])if(!docs.some(d=>d.category===category))tasks.push([e.id,categoryNames[category]+'尚未配對','先掃描NAS資料夾，再確認檔名對應的員工']);
  });
  return heading('人事待辦總覽',today()+'｜資料與文件保存在NAS',button('新增員工','employee'))+`<div class="stats"><div class="stat"><span>在職員工</span><strong>${state.employees.filter(active).length}</strong></div><div class="stat"><span>文件待配對</span><strong>${pending.length}</strong></div><div class="stat"><span>薪資版本待核對</span><strong>${salaryPending.length}</strong></div><div class="stat"><span>人事待辦</span><strong>${tasks.length}</strong></div></div><div class="split"><section class="panel"><h2>待處理事項</h2>${tasks.length?tasks.slice(0,20).map(t=>`<div class="task"><span class="task-dot">待</span><div>${who(t[0])}<strong>・${esc(t[1])}</strong><p class="muted">${esc(t[2])}</p></div></div>`).join(''):empty('目前沒有待處理事項',state.employees.length?'資料可隨時在員工檔案更新':'先新增員工，或到「連線與匯入」同步打卡名單')}</section><section class="panel"><h2>系統狀態</h2><ul class="status-list"><li>員工與人事紀錄：NAS資料庫</li><li>NAS文件：${Object.values(state.settings.documentRoots).every(Boolean)?'三個資料夾皆可讀取':'資料夾尚未全部設定'}</li><li>打卡連動：${state.settings.gasConfigured?'已設定，可手動同步':'尚未設定，可先匯入JSON或新增員工'}</li><li>最後匯入：${esc(state.lastImport?.time||'尚未匯入')}</li></ul><div class="notice">已核定及已付款薪資保留原版本。特休以核給與使用紀錄管理，不會自動當成月休。</div><button class="quiet" data-page="settings">查看設定及操作紀錄</button></section></div>`;
}
function employees(){
  return heading('員工檔案','一位員工，一份完整人事紀錄',button('新增員工','employee'))+`<div class="toolbar"><input id="employee-search" aria-label="搜尋員工" placeholder="搜尋姓名、編號或部門"><select id="employee-filter" aria-label="員工狀態"><option value="all">全部人員</option><option value="active">在職</option><option value="other">離職／尚未到職</option></select></div><section class="panel" id="employee-table">${employeeTable()}</section>`;
}
function employeeTable(query='',filter='all'){
  const records=state.employees.filter(e=>(e.id+' '+e.name+' '+e.department).toLowerCase().includes(query.toLowerCase())&&(filter==='all'||(filter==='active'?active(e):!active(e))));
  return table(['員工','部門／職务','到職日','聘僱型態','狀態'],records.map(e=>`<tr><td>${who(e.id)}</td><td>${esc(e.department||'—')}<div class="muted">${esc(e.job||'')}</div></td><td>${esc(e.arrivalDate||'尚未填寫')}</td><td>${esc(e.employmentType||'—')}</td><td>${badge(active(e)?'在職':e.departureDate&&e.departureDate<today()?'離職':'尚未到職',!active(e))}</td></tr>`));
}
function recordTable(kind,id){
  const records=state.records.filter(r=>r.kind===kind&&(!id||r.employeeId===id));
  if(kind==='insurance')return table(['員工','實際生效日','種類／異動','級距金額','確認','備註'],records.map(r=>`<tr><td>${who(r.employeeId)}</td><td>${esc(r.date)}</td><td>${esc(r.type)}・${esc(r.action)}</td><td>${money(r.amount)}</td><td>${badge(r.verified?'已確認':'待確認',!r.verified)}</td><td>${esc(r.notes)}</td></tr>`));
  if(kind==='leave')return table(['員工','日期','特休期間','異動','時數','備註'],records.map(r=>`<tr><td>${who(r.employeeId)}</td><td>${esc(r.date)}</td><td>${esc(r.period)}</td><td>${esc(r.action)}</td><td>${r.action==='已休'||r.action==='結清'?'−':r.hours>=0?'+':''}${esc(r.hours)} H</td><td>${esc(r.notes)}</td></tr>`));
  return table(['生效日','異動項目','說明'],records.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.notes)}</td></tr>`));
}
function salaryTable(id){
  const records=state.salaries.filter(r=>!id||r.employeeId===id);
  return table(['員工','月份／版本','工時','實發','狀態','來源','處理'],records.map(r=>`<tr><td>${who(r.employeeId)}</td><td>${esc(r.month)}<div class="muted">版本 ${r.version}</div></td><td>${esc(r.workHours||0)} H</td><td class="money">$ ${money(r.netPay)}</td><td>${badge(r.status,r.status==='待核對')}</td><td>${esc(r.source)}</td><td>${r.status==='待核對'?`<button class="small" data-salary="${r.id}" data-status="已核定">核定</button>`:r.status==='已核定'?`<button class="small quiet" data-salary="${r.id}" data-status="已付款">記錄付款</button>`:'保留原版本'}<div class="muted">${esc(r.notes||'')}</div></td></tr>`));
}
function documentCard(e,category){
  const docs=state.documents.filter(d=>d.employeeId===e.id&&d.category===category);
  return `<article class="document-card"><h3>${categoryNames[category]}</h3>${docs.length?docs.map(d=>`<div><span class="muted">${esc(d.filename)}</span><br>${d.available?`<button class="quiet small" data-preview="${d.id}">開啟${categoryNames[category]}</button>`:badge('原檔不存在，請重新掃描',true)}</div>`).join(''):badge('未配對',true)}</article>`;
}
function employeeView(){
  const e=employee(employeeId);if(!e){employeeId=null;return employees();}
  const tabs={basic:'基本資料',insurance:'勞健保',documents:'證件文件',salary:'每月薪資',leave:'特休',attendance:'打卡紀錄',change:'人事異動'};
  let body='';
  if(tab==='basic'){
    const fields={'員工編號':e.id,'部門':e.department,'職務':e.job,'聘僱型態':e.employmentType,'到職日':e.arrivalDate,'離職日':e.departureDate,'電話':e.phone,'緊急聯絡人':e.emergencyContact,'紙本原件位置':e.paperLocation,'LINE綁定':e.lineBound,'備註':e.notes};
    body=`<section class="panel"><div class="page-head"><h2>基本資料</h2>${button('編輯資料','employee',e.id)}</div><div class="fields">${Object.entries(fields).map(([k,v])=>`<div><div class="field-label">${esc(k)}</div><div class="field-value">${esc(v||'—')}</div></div>`).join('')}</div></section>`;
  }else if(tab==='documents')body=`<section class="panel"><h2>NAS原始文件</h2><div class="document-grid">${Object.keys(categoryNames).map(c=>documentCard(e,c)).join('')}</div><div class="notice">檔案不搬動、不設公開連結。文件配對後直接開啟預覽；駕照效期等資料可在「人事異動」登記。</div><button class="quiet" data-page="documents">文件掃描及配對</button></section>`;
  else if(tab==='salary')body=`<section class="panel"><div class="page-head"><h2>薪資版本</h2>${button('登錄薪資','salary',e.id)}</div>${salaryTable(e.id)}</section>`;
  else if(tab==='attendance'){
    const rows=state.attendance.filter(r=>r.employeeId===e.id).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
    body=`<section class="panel"><h2>來源打卡紀錄</h2><div class="notice">此頁只讀取同步的原始上下班紀錄；缺卡配對與薪資計算仍由現有打卡系統處理。</div>${table(['日期','時間','類型','狀態','備註'],rows.slice(0,200).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.time)}</td><td>${esc(r.type)}</td><td>${esc(r.status||'—')}</td><td>${esc(r.notes)}</td></tr>`))}</section>`;
  }else{
    const title=tab==='insurance'?'勞保、健保與勞退異動':tab==='leave'?'特休時數帳本':'人事異動歷史';
    const leaveRecords=state.records.filter(r=>r.employeeId===e.id&&r.kind==='leave');const balance=leaveRecords.reduce((n,r)=>n+r.hours*(r.action==='已休'||r.action==='結清'?-1:1),0);
    body=`<section class="panel"><div class="page-head"><h2>${title}</h2>${button('新增紀錄',tab,e.id)}</div>${tab==='leave'?`<div class="notice">各期合計餘額 ${Math.round(balance*100)/100} 小時。核給、已休及結清分期記錄；本版不自動給假，也不回寫薪資扣款。</div>`:''}${recordTable(tab,e.id)}</section>`;
  }
  return `<button class="quiet back" data-page="employees">← 員工名單</button><div class="person"><div class="avatar">${esc(e.name.slice(0,1))}</div><div><h1>${esc(e.name)} <span class="muted">${esc(e.id)}</span></h1><div class="muted">${esc(e.department)}・${esc(e.employmentType)}・${active(e)?'在職':'離職／尚未到職'}</div></div></div><div class="tabs" role="tablist" aria-label="員工資料">${Object.entries(tabs).map(([k,v])=>`<button role="tab" aria-selected="${tab===k}" class="${tab===k?'active':''}" data-tab="${k}">${v}</button>`).join('')}</div>${body}`;
}
function documents(){
  return heading('文件配對','依檔名建議人選，確認後才綁定；原NAS資料夾不變','<button data-scan>掃描NAS資料夾</button>')+`<section class="panel">${table(['種類／檔名','狀態','綁定／建議人員','操作'],state.documents.map(d=>`<tr><td>${categoryNames[d.category]}<div class="muted">${esc(d.filename)}</div></td><td>${badge(!d.available?'原檔不存在':d.employeeId?'已確認':'待配對',!d.available||!d.employeeId)}</td><td>${d.employeeId?who(d.employeeId):`<div class="muted">${d.suggestions.length===1?'建議：'+esc(employeeName(d.suggestions[0])):d.suggestions.length?'同名人員，請人工選擇':'未找到相同姓名，請人工選擇'}</div>`}</td><td>${d.available?`<div class="file-row"><button class="quiet small" data-bind="${d.id}">${d.employeeId?'重新配對':'確認配對'}</button>${d.employeeId?`<button class="small" data-preview="${d.id}">預覽</button>`:''}</div>`:''}</td></tr>`))}</section>`;
}
function settings(){
  return heading('連線與匯入','資料不會上傳GitHub；設定在NAS環境檔保存')+`<div class="split"><section class="panel"><h2>NAS資料夾</h2>${Object.entries(categoryNames).map(([k,v])=>`<div class="task"><div><strong>${v}</strong></div>${badge(state.settings.documentRoots[k]?'可讀取':'尚未連接',!state.settings.documentRoots[k])}</div>`).join('')}<div class="notice">在NAS的.env填入原資料夾路徑，再重建容器。文件為唯讀掛載，人資系統不會刪除、搬動原檔。</div><button data-scan>掃描文件</button></section><section class="panel"><h2>現有打卡系統</h2><p>${badge(state.settings.gasConfigured?'串接已設定':'尚未設定',!state.settings.gasConfigured)}</p><p class="muted">${esc(state.lastImport?.time||'尚未同步')}<br>員工資料、原始打卡及試算表內已計算的薪資版本。</p><div class="actions"><button data-sync ${state.settings.gasConfigured?'':'disabled'}>同步打卡資料</button><button class="quiet" id="import-button">匯入JSON檔</button><input id="import-file" type="file" accept="application/json,.json" hidden></div><div class="notice">串接只讀，不改原Webhook，也不重新計算薪資。特休與保險資料尚未回寫既有薪資程式。</div>${state.lastImport?.warnings?.length?`<p class="muted">上次匯入提醒：${esc(state.lastImport.warnings.join('；'))}</p>`:''}</section></div><section class="panel"><h2>最近操作紀錄</h2><div class="notice">目前為共同使用模式，只記錄來源IP、時間及動作，不能識別個別人員。</div>${table(['時間','來源IP','操作','對象'],state.audit.map(r=>`<tr><td>${esc(r.created)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td></tr>`))}</section>`;
}
function render(){
  $('navigation').innerHTML=Object.entries(pages).map(([k,v])=>`<button class="${page===k?'active':''}" data-page="${k}" aria-current="${page===k?'page':'false'}">${v}</button>`).join('');
  const renderers={overview,employees,documents,settings,insurance:()=>heading('保險異動','實際加退保日期及投保級距分開記錄',button('新增保險紀錄','insurance'))+`<section class="panel">${recordTable('insurance')}</section>`,salary:()=>heading('薪資歷史','保留每次匯入版本；核定及付款只變更狀態，不改金額',button('登錄薪資','salary'))+`<section class="panel">${salaryTable()}</section>`,leave:()=>heading('特休紀錄','以時數及各期帳本記錄，不與月休8天混用',button('新增特休紀錄','leave'))+`<section class="panel">${recordTable('leave')}</section>`};
  $('content').innerHTML=page==='employees'&&employeeId?employeeView():renderers[page]();
}
function employeeOptions(value=''){return `<option value="">選擇員工</option>`+state.employees.map(e=>`<option value="${esc(e.id)}" ${e.id===value?'selected':''}>${esc(e.id+' '+e.name+'・'+e.department)}</option>`).join('');}
function field(label,name,value='',type='text',required=false,wide=false){return `<label class="${wide?'wide':''}">${esc(label)}${type==='textarea'?`<textarea name="${name}" ${required?'required':''}>${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''}>`}</label>`;}
function select(label,name,options,value=''){return `<label>${esc(label)}<select name="${name}" required>${options.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;}
function openForm(kind,id='',extra=null){
  currentForm={kind,id,extra};$('form-error').textContent='';let fields='';
  if(kind==='employee'){
    const e=id?employee(id):{};$('dialog-title').textContent=id?'編輯員工檔案':'新增員工';
    fields=field('員工編號','id',e.id||'','text',true)+field('姓名','name',e.name||'','text',true)+field('部門','department',e.department)+field('職務','job',e.job)+select('聘僱型態','employmentType',['正職','時薪','兼職'],e.employmentType)+field('到職日','arrivalDate',e.arrivalDate,'date')+field('離職日','departureDate',e.departureDate,'date')+field('電話','phone',e.phone)+field('緊急聯絡人／電話','emergencyContact',e.emergencyContact)+field('紙本原件位置','paperLocation',e.paperLocation)+field('備註','notes',e.notes,'textarea',false,true);
  }else if(kind==='bind'){
    const doc=state.documents.find(d=>d.id===extra);$('dialog-title').textContent='確認文件配對';fields=`<div class="wide"><strong>${esc(categoryNames[doc.category]+'・'+doc.filename)}</strong><p class="muted">請確認檔案確實屬於這位員工。</p></div><label class="wide">員工<select name="employeeId" required>${employeeOptions(doc.employeeId||(doc.suggestions.length===1?doc.suggestions[0]:''))}</select></label>`;
  }else{
    $('dialog-title').textContent={insurance:'新增保險異動',leave:'新增特休紀錄',salary:'登錄薪資版本',change:'新增人事異動'}[kind];
    fields=`<label>員工<select name="employeeId" required>${employeeOptions(id)}</select></label>`;
    if(kind==='salary')fields+=field('薪資月份','month',today().slice(0,7),'month',true)+field('實發金額','netPay','','number',true)+field('工作時數','workHours',0,'number');
    else{
      fields+=field('實際生效日','date',today(),'date',true);
      if(kind==='insurance')fields+=select('種類','type',['勞保','健保','勞退'])+select('異動','action',['加保','退保','級距異動','眷屬異動','提繳異動'])+field('投保級距金額／提繳金額','amount',0,'number')+field('眷屬人數','dependentCount',0,'number')+select('已人工確認','verified',['尚未確認','已確認']);
      if(kind==='leave')fields+=field('特休期間（例2026週年）','period','','text',true)+select('異動','action',['核給','已休','調整','結清'])+field('時數（例半天4小時）','hours','','number',true);
      if(kind==='change')fields+=field('異動項目（例調薪／證件效期）','type','','text',true);
    }
    fields+=field('說明／依據','notes','','textarea',false,true);
  }
  $('form-fields').innerHTML=`<div class="form-grid">${fields}</div>`;
  $('form-fields').querySelectorAll('input[type="number"]').forEach(e=>e.step='any');
  if(kind==='employee'&&id)$('form-fields').querySelector('[name=id]').readOnly=true;
  $('form-dialog').showModal();
}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||busy)return;
  if(!state&&b.id!=='refresh'){notify('請先重新整理，恢復公司網路連線。',true);return;}
  try{
    if(b.dataset.page){page=b.dataset.page;employeeId=null;tab='basic';render();}
    else if(b.dataset.employee){page='employees';employeeId=b.dataset.employee;tab='basic';render();}
    else if(b.dataset.tab){tab=b.dataset.tab;render();}
    else if(b.dataset.form)openForm(b.dataset.form,b.dataset.id);
    else if(b.dataset.bind)openForm('bind','',b.dataset.bind);
    else if(b.hasAttribute('data-scan'))await action('/api/documents/scan',{},'NAS文件掃描完成，請到文件配對確認。');
    else if(b.hasAttribute('data-sync'))await action('/api/sync',{},'打卡資料已同步；原試算表未修改。');
    else if(b.dataset.salary){if(confirm(`確認將此薪資版本標記為「${b.dataset.status}」？金額會保留，狀態不可倒退。`))await action('/api/salary/status',{id:b.dataset.salary,status:b.dataset.status},'薪資狀態已記錄。');}
    else if(b.dataset.preview){
      const doc=state.documents.find(d=>d.id===b.dataset.preview);$('preview-title').textContent=categoryNames[doc.category]+'・'+doc.filename;
      const url='/api/document?id='+encodeURIComponent(doc.id);$('preview-content').replaceChildren();
      const view=document.createElement(doc.filename.toLowerCase().endsWith('.pdf')?'iframe':'img');view.src=url;
      if(view.tagName==='IFRAME')view.title='文件預覽';else view.alt=doc.filename;
      $('preview-content').append(view);$('preview-dialog').showModal();
    }
    else if(b.id==='refresh'){await load();notify('資料已重新載入。');}
    else if(b.id==='import-button')$('import-file').click();
  }catch{/* Action already displays errors. */}
});
document.addEventListener('input',event=>{if(event.target.id==='employee-search')$('employee-table').innerHTML=employeeTable(event.target.value,$('employee-filter').value);});
document.addEventListener('change',async event=>{
  if(event.target.id==='employee-filter')$('employee-table').innerHTML=employeeTable($('employee-search').value,event.target.value);
  if(event.target.id==='import-file'){
    const file=event.target.files[0];if(!file)return;
    try{if(file.size>20*1024*1024)throw Error('匯入檔案不可超過20MB');const data=JSON.parse(await file.text());await action('/api/import',data,'資料已匯入；未修改原打卡系統。');}
    catch(e){notify(e.message,true);}finally{event.target.value='';}
  }
});
$('edit-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;const body=Object.fromEntries(new FormData(event.target));
  const form=currentForm;let endpoint;
  if(form.kind==='employee'){endpoint='/api/employee';const old=form.id?employee(form.id):null;if(old){body.revision=old.revision;body.lineBound=old.lineBound;}}
  else if(form.kind==='bind'){endpoint='/api/documents/bind';body.id=form.extra;}
  else if(form.kind==='salary')endpoint='/api/salary';
  else{endpoint='/api/record';body.kind=form.kind;if(form.kind==='insurance')body.verified=body.verified==='已確認';}
  for(const key of ['amount','dependentCount','hours','netPay','workHours'])if(key in body)body[key]=Number(body[key]);
  try{await action(endpoint,body,'資料已儲存於NAS。');$('form-dialog').close();}catch(e){$('form-error').textContent=e.message;}
});
for(const id of ['close-dialog','cancel-dialog'])$(id).addEventListener('click',()=>$('form-dialog').close());
$('close-preview').addEventListener('click',()=>{$('preview-dialog').close();$('preview-content').replaceChildren();});
$('preview-dialog').addEventListener('close',()=>$('preview-content').replaceChildren());
load().catch(e=>{$('content').innerHTML=empty('無法連接人資系統','請確認已連公司網路，再按重新整理。');notify(e.message,true);});
// A page left open after leaving the office must not continue displaying loaded HR data.
setInterval(async()=>{
  if(!state||busy)return;
  try{await request('/api/ping');}
  catch(e){state=null;csrf='';$('form-dialog').close();$('preview-dialog').close();$('preview-content').replaceChildren();$('content').innerHTML=empty('公司網路連線中斷','已隱藏人事資料，回公司後請重新整理。');notify(e.message,true);}
},15000);
