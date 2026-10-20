'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value || 0).toLocaleString('zh-TW', {maximumFractionDigits: 0});
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(new Date());
let state = null, page = 'overview', employeeId = null, tab = 'basic', csrf = '', currentForm = null, busy = false;
const pages = {overview:'待辦總覽',employees:'員工檔案',insurance:'保險異動',salary:'薪資歷史',leave:'特休紀錄',documents:'文件配對',recruitment:'徵人',settings:'連線與匯入'};
let candidateId=null;
let recruitFilters={query:'',department:'',status:'',date:today(),scope:'all',dateMode:'exact'};
let recruitPage=1,recruitEventPage=1;
let leaveSheet='',leaveQuery='';
const recruitStatuses=['待聯絡','待面試','待回覆','錄取','待報到','已報到','未錄取','放棄'];
const localMinute=()=>today()+'T'+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
const candidate=id=>(state.candidates||[]).find(c=>c.id===id);
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
function table(headers,rows){return rows.length?`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('尚無紀錄','請使用本頁的新增或匯入功能建立紀錄');}
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
  if(kind==='leave'&&!records.length)return empty('尚無人工特休紀錄','可新增核給、已休、調整或結清；Excel歷史資料另列於下方，不會自動加入可休餘額');
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
  return `<article class="document-card"><h3>${categoryNames[category]}</h3><button class="small" data-upload="${category}" data-id="${esc(e.id)}">上傳／拍照</button>${docs.length?docs.map(d=>`<div><span class="muted">${esc(d.filename)}</span><br>${d.available?`<button class="quiet small" data-preview="${d.id}">開啟${categoryNames[category]}</button>`:badge('原檔不存在，請重新掃描',true)}</div>`).join(''):badge('未配對',true)}</article>`;
}
function employeeView(){
  const e=employee(employeeId);if(!e){employeeId=null;return employees();}
  const tabs={basic:'基本資料',insurance:'勞健保',documents:'證件文件',salary:'每月薪資',leave:'特休',attendance:'打卡紀錄',change:'人事異動'};
  let body='';
  if(tab==='basic'){
    const fields={'員工編號':e.id,'部門':e.department,'職務':e.job,'聘僱型態':e.employmentType,'到職日':e.arrivalDate,'離職日':e.departureDate,'電話':e.phone,'緊急聯絡人':e.emergencyContact,'紙本原件位置':e.paperLocation,'LINE綁定':e.lineBound,'備註':e.notes};
    body=`<section class="panel"><div class="page-head"><h2>基本資料</h2>${button('編輯資料','employee',e.id)}</div><div class="fields">${Object.entries(fields).map(([k,v])=>`<div><div class="field-label">${esc(k)}</div><div class="field-value">${esc(v||'—')}</div></div>`).join('')}</div></section>`;
  }else if(tab==='documents')body=`<section class="panel"><h2>NAS原始文件</h2><div class="document-grid">${Object.keys(categoryNames).map(c=>documentCard(e,c)).join('')}</div><div class="notice">上傳後存入對應NAS資料夾並自動綁定此員工，每次保留新檔。既有文件配對後直接開啟預覽；駕照效期等資料可在「人事異動」登記。</div><button class="quiet" data-page="documents">文件掃描及配對</button></section>`;
  else if(tab==='salary')body=`<section class="panel"><div class="page-head"><h2>薪資版本</h2>${button('登錄薪資','salary',e.id)}</div>${salaryTable(e.id)}</section>`;
  else if(tab==='attendance'){
    const rows=state.attendance.filter(r=>r.employeeId===e.id).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
    body=`<section class="panel"><h2>來源打卡紀錄</h2><div class="notice">此頁只讀取同步的原始上下班紀錄；缺卡配對與薪資計算仍由現有打卡系統處理。</div>${table(['日期','時間','類型','狀態','備註'],rows.slice(0,200).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.time)}</td><td>${esc(r.type)}</td><td>${esc(r.status||'—')}</td><td>${esc(r.notes)}</td></tr>`))}</section>`;
  }else{
    const title=tab==='insurance'?'勞保、健保與勞退異動':tab==='leave'?'特休時數帳本':'人事異動歷史';
    const leaveRecords=state.records.filter(r=>r.employeeId===e.id&&r.kind==='leave');const balance=leaveRecords.reduce((n,r)=>n+r.hours*(r.action==='已休'||r.action==='結清'?-1:1),0);
    body=`<section class="panel"><div class="page-head"><h2>${title}</h2>${button('新增紀錄',tab,e.id)}</div>${tab==='leave'?`<div class="notice">各期合計餘額 ${Math.round(balance*100)/100} 小時。核給、已休及結清分期記錄；本版不自動給假，也不回寫薪資扣款。</div>`:''}${recordTable(tab,e.id)}</section>${tab==='leave'?'<section class="panel"><h2>原Excel特休紀錄</h2>'+leaveExcelTable(e.id)+'</section>':''}`;
  }
  return `<button class="quiet back" data-page="employees">← 員工名單</button><div class="person"><div class="avatar">${esc(e.name.slice(0,1))}</div><div><h1>${esc(e.name)} <span class="muted">${esc(e.id)}</span></h1><div class="muted">${esc(e.department)}・${esc(e.employmentType)}・${active(e)?'在職':'離職／尚未到職'}</div></div></div><div class="tabs" role="tablist" aria-label="員工資料">${Object.entries(tabs).map(([k,v])=>`<button role="tab" aria-selected="${tab===k}" class="${tab===k?'active':''}" data-tab="${k}">${v}</button>`).join('')}</div>${body}`;
}
function documents(){
  return heading('文件配對','依檔名建議人選，確認後才綁定；原NAS資料夾不變','<button data-form="upload">上傳員工文件</button><button data-scan>掃描NAS資料夾</button>')+`<section class="panel">${table(['種類／檔名','狀態','綁定／建議人員','操作'],state.documents.map(d=>`<tr><td>${categoryNames[d.category]}<div class="muted">${esc(d.filename)}</div></td><td>${badge(!d.available?'原檔不存在':d.employeeId?'已確認':'待配對',!d.available||!d.employeeId)}</td><td>${d.employeeId?who(d.employeeId):`<div class="muted">${d.suggestions.length===1?'建議：'+esc(employeeName(d.suggestions[0])):d.suggestions.length?'同名人員，請人工選擇':'未找到相同姓名，請人工選擇'}</div>`}</td><td>${d.available?`<div class="file-row"><button class="quiet small" data-bind="${d.id}">${d.employeeId?'重新配對':'確認配對'}</button>${d.employeeId?`<button class="small" data-preview="${d.id}">預覽</button>`:''}</div>`:''}</td></tr>`))}</section>`;
}
function settings(){
  return heading('連線與匯入','資料不會上傳GitHub；設定在NAS環境檔保存')+`<div class="split"><section class="panel"><h2>NAS資料夾</h2>${Object.entries(categoryNames).map(([k,v])=>`<div class="task"><div><strong>${v}</strong></div>${badge(state.settings.documentAccess?.[k]?.writable?'可讀寫':state.settings.documentRoots[k]?'可讀取／未允許上傳':'尚未連接',!state.settings.documentRoots[k])}</div>`).join('')}<div class="notice">在NAS的.env填入原資料夾路徑，再重建容器。文件上傳需要NAS資料夾與容器掛載均允許寫入；既有文件不刪除、不覆蓋。每份文件上限12MB。</div><button data-scan>掃描文件</button></section><section class="panel"><h2>現有打卡系統</h2><p>${badge(state.settings.gasConfigured?'串接已設定':'尚未設定',!state.settings.gasConfigured)}</p><p class="muted">${esc(state.lastImport?.time||'尚未同步')}<br>員工資料、原始打卡及試算表內已計算的薪資版本。</p><div class="actions"><button data-sync ${state.settings.gasConfigured?'':'disabled'}>同步打卡資料</button><button class="quiet" id="import-button">匯入JSON檔</button><input id="import-file" type="file" accept="application/json,.json" hidden></div><div class="notice">串接只讀，不改原Webhook，也不重新計算薪資。特休與保險資料尚未回寫既有薪資程式。</div>${state.lastImport?.warnings?.length?`<p class="muted">上次匯入提醒：${esc(state.lastImport.warnings.join('；'))}</p>`:''}</section></div><section class="panel"><h2>最近操作紀錄</h2><div class="notice">目前為共同使用模式，只記錄來源IP、時間及動作，不能識別個別人員。</div>${table(['時間','來源IP','操作','對象'],state.audit.map(r=>`<tr><td>${esc(r.created)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td></tr>`))}</section>`;
}
function render(){
  $('navigation').innerHTML=Object.entries(pages).map(([k,v])=>`<button class="${page===k?'active':''}" data-page="${k}" aria-current="${page===k?'page':'false'}">${v}</button>`).join('');
  const renderers={overview,employees,documents,settings,recruitment,leave:leavePage,insurance:()=>heading('保險異動','實際加退保日期及投保級距分開記錄',button('新增保險紀錄','insurance'))+`<section class="panel">${recordTable('insurance')}</section>`,salary:()=>heading('薪資歷史','保留每次匯入版本；核定及付款只變更狀態，不改金額',button('登錄薪資','salary'))+`<section class="panel">${salaryTable()}</section>`};
  $('content').innerHTML=page==='employees'&&employeeId?employeeView():renderers[page]();
}
function recruitOpen(c){return !['已報到','未錄取','放棄'].includes(c.status);}
function recruitMatch(c){
  const f=recruitFilters,query=(c.name+' '+c.phone+' '+c.job).toLowerCase();
  return query.includes(f.query.toLowerCase())&&(!f.department||c.department===f.department)&&(!f.status||c.status===f.status)&&
    (f.scope==='all'||f.scope==='due'&&recruitOpen(c)&&c.followupDate&&c.followupDate<=today()||f.scope==='interview'&&recruitOpen(c)&&c.interviewAt?.slice(0,10)===today()||f.scope==='overdue'&&recruitOpen(c)&&c.followupDate&&c.followupDate<today()||f.scope==='onboard'&&c.status==='待報到');
}
function candidateList(){
  const people=(state.candidates||[]).filter(recruitMatch);
  const start=(recruitPage-1)*50,visible=people.slice(start,start+50);
  return recruitPager('people',people.length,recruitPage,50)+table(['應徵者／電話','部門／職缺','進度','面試／下次追蹤','處理'],visible.map(c=>`<tr><td><button class="employee-link" data-candidate="${esc(c.id)}">${esc(c.name)}</button><div class="muted">${esc(c.phone)}</div></td><td>${esc(c.department||'—')}<div class="muted">${esc(c.job)}</div></td><td>${badge(c.status,recruitOpen(c)&&!!c.followupDate&&c.followupDate<today())}</td><td>${esc(c.interviewAt?.replace('T',' ')||'未排面試')}<div class="muted">追蹤：${esc(c.followupDate||'未設定')}</div></td><td><div class="actions">${button('電話紀錄','recruit-phone',c.id)}${button('面試紀錄','recruit-interview',c.id)}</div></td></tr>`));
}
function recruitPager(kind,total,page,size){return `<div class="toolbar"><span class="muted">共 ${total} 筆｜第 ${page}／${Math.max(1,Math.ceil(total/size))} 頁</span>${page>1?`<button class="quiet small" data-recruit-pager="${kind}" data-direction="-1">上一頁</button>`:''}${page*size<total?`<button class="quiet small" data-recruit-pager="${kind}" data-direction="1">下一頁</button>`:''}</div>`;}
function recruitEvents(id=null){
  const rows=(state.recruitmentEvents||[]).filter(r=>{
    if(id)return r.candidateId===id;
    const date=r.contactDate||r.at.slice(0,10),match=recruitFilters.dateMode==='unknown'?!date:date===recruitFilters.date;
    return match&&candidate(r.candidateId)&&recruitMatch(candidate(r.candidateId));
  }).sort((a,b)=>(b.at||b.contactDate||b.rangeEnd||'').localeCompare(a.at||a.contactDate||a.rangeEnd||'')||b.created.localeCompare(a.created));
  const selected=id?rows:rows.slice((recruitEventPage-1)*100,recruitEventPage*100);
  return (id?'':recruitPager('events',rows.length,recruitEventPage,100))+table(id?['日期時間','種類／結果','聯絡人／主管','紀錄／後續']:['日期時間','應徵者','種類／結果','聯絡人／主管','紀錄／後續'],selected.map(r=>`<tr><td>${esc(r.at?r.at.replace('T',' '):r.contactDate||'日期未明')}${!r.at&&r.rawCallTime?`<div class="muted">原撥打時間：${esc(r.rawCallTime)}</div>`:''}${r.imported?`<div class="muted">原分頁：${esc(r.sourceSheet)}<br>第 ${esc(r.sourceRow)} 列</div>`:''}</td>${id?'':`<td><button class="employee-link" data-candidate="${esc(r.candidateId)}">${esc(candidate(r.candidateId)?.name||'—')}</button></td>`}<td>${r.imported?'Excel歷史紀錄':r.kind==='phone'?'電話':'面試'}<br>${esc(r.outcome)}</td><td>${esc(r.contactPerson)}</td><td class="record-notes">${esc(r.notes||'—')}${r.nextFollowup?`<div class="muted">下次追蹤：${esc(r.nextFollowup)}</div>`:''}${r.nextInterviewAt?`<div class="muted">預約面試：${esc(r.nextInterviewAt.replace('T',' '))}</div>`:''}</td></tr>`));
}
async function previewRecruitmentFile(file){
  if(busy||!file)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
    if(file.size>20*1024*1024)throw Error('徵人匯入檔案上限20MB');
    let preview;
    if(/\.json$/i.test(file.name))preview=await request('/api/recruitment/import-preview',JSON.parse(await file.text()));
    else{
      const start=$('recruit-import-start').value,end=$('recruit-import-end').value;
      if(!start||!end||start>end)throw Error('請先設定有效的匯入日期範圍');
      const params=new URLSearchParams({start,end,filename:file.name});
      const response=await fetch('/api/recruitment/excel-preview?'+params,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-HR-CSRF':csrf},body:file});
      preview=await response.json();if(!response.ok)throw Error(preview.error||'Excel讀取失敗');
    }
    openForm('recruit-import','',preview);
  }catch(e){notify(e.message,true);}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function recruitment(){
  if(candidateId){
    const c=candidate(candidateId);if(!c){candidateId=null;return recruitment();}
    const fields={'電話':c.phone,'部門／職缺':[c.department,c.job].filter(Boolean).join('／'),'招募來源':c.source,'負責聯絡人':c.contactPerson,'可到職日':c.availableDate,'預約面試':c.interviewAt?.replace('T',' '),'下次追蹤日':c.followupDate,'進度':c.status,'備註':c.notes};
    return '<button class="quiet back" data-recruit-back>← 應徵者名單</button>'+heading(c.name,'招募歷程持續保留，不會被新的聯絡紀錄覆蓋',button('編輯應徵者','candidate',c.id)+button('新增電話紀錄','recruit-phone',c.id)+button('新增面試紀錄','recruit-interview',c.id)+(c.employeeId?`<button data-employee="${esc(c.employeeId)}">查看員工檔案</button>`:button('報到並轉為員工','recruit-convert',c.id)))+`<section class="panel"><div class="fields">${Object.entries(fields).map(([k,v])=>`<div><div class="field-label">${esc(k)}</div><div class="field-value">${esc(v||'—')}</div></div>`).join('')}</div></section><section class="panel"><h2>電話與面試完整歷程</h2>${recruitEvents(c.id)}</section>`;
  }
  const people=state.candidates||[],open=people.filter(recruitOpen),departments=[...new Set(people.map(c=>c.department).filter(Boolean))].sort();
  const counts=[['due','今日待聯絡',open.filter(c=>c.followupDate&&c.followupDate<=today()).length],['interview','今日面試',open.filter(c=>c.interviewAt?.slice(0,10)===today()).length],['overdue','逾期追蹤',open.filter(c=>c.followupDate&&c.followupDate<today()).length],['onboard','待報到',people.filter(c=>c.status==='待報到').length]];
  return heading('徵人',today()+'｜電話聯絡、面試及報到進度',button('新增應徵者','candidate'))+hiringGoals()+`<section class="panel"><h2>匯入Excel應徵資料</h2><div class="toolbar"><label>匯入開始日<input id="recruit-import-start" type="date" value="2026-07-01"></label><label>匯入截止日<input id="recruit-import-end" type="date" value="${today()}"></label><button data-recruit-import>選擇Excel／整理檔</button><input id="recruit-import-file" type="file" accept=".xlsx,.xls,.json" hidden></div><p class="muted">先預覽再匯入；依姓名＋電話合併人員，已匯入的相同來源列不重複新增。原分頁跨多日時保留日期範圍。</p></section>`+`<div class="stats">${counts.map(([k,t,n])=>`<button class="stat recruit-stat ${recruitFilters.scope===k?'selected':''}" data-recruit-scope="${k}"><span>${t}</span><strong>${n}</strong></button>`).join('')}</div><div class="toolbar"><input id="recruit-search" aria-label="搜尋應徵者" placeholder="搜尋姓名、電話或職缺" value="${esc(recruitFilters.query)}"><select id="recruit-department" aria-label="招募部門"><option value="">全部部門</option>${departments.map(d=>`<option ${d===recruitFilters.department?'selected':''}>${esc(d)}</option>`).join('')}</select><select id="recruit-status" aria-label="招募進度"><option value="">全部進度</option>${recruitStatuses.map(d=>`<option ${d===recruitFilters.status?'selected':''}>${esc(d)}</option>`).join('')}</select><button class="quiet" data-recruit-scope="all">全部人員</button></div><section class="panel"><h2>應徵者名單</h2><div id="candidate-list">${candidateList()}</div></section><section class="panel"><div class="page-head"><h2>每日電話與面試紀錄</h2><select id="recruit-date-mode" aria-label="歷史日期篩選"><option value="exact" ${recruitFilters.dateMode==='exact'?'selected':''}>有明確日期</option><option value="unknown" ${recruitFilters.dateMode==='unknown'?'selected':''}>日期未明（全部原分頁）</option></select><label>紀錄日期<input id="recruit-date" type="date" value="${esc(recruitFilters.date)}"></label></div><div id="recruit-events">${recruitEvents()}</div></section>`;
}
function hiringGoals(){
  const goals=state.recruitmentGoals||[];
  return `<section class="panel"><div class="page-head"><h2>各組徵人需求與完成進度</h2>${button('新增部門需求','goal')}</div><p class="muted">以建立需求時的在職人數為基準；報到增加、離職減少淨補足人數。離職日當天仍在職，隔日起扣除。待報到及僅標記「已報到」的應徵者不計入，須建立員工檔案。</p><div class="toolbar"><button class="quiet" id="goal-refresh">更新進度</button><button data-sync ${state.settings.gasConfigured?'':'disabled'}>同步打卡員工異動</button><span class="muted">${state.lastImport?'上次來源同步：'+esc(state.lastImport.at||state.lastImport.time||'請見連線與匯入'):'尚未同步打卡來源'}</span></div>${goals.length?`<div class="goals-grid">${goals.map(g=>`<article class="goal-card"><div class="page-head"><h3>${esc(g.department)}</h3>${button('增加需求','goal',g.department)}</div><div class="goal-number">${esc(g.filled)} / ${esc(g.required)} <small>人 · ${esc(g.percent)}%</small></div><progress value="${esc(g.percent)}" max="100" aria-label="${esc(g.department)}徵人完成度">${esc(g.percent)}%</progress><p>還需 ${esc(g.remaining)} 人 ${g.remaining===0?badge('已達標'):''}</p><p class="muted">基準 ${esc(g.baseline)} 人 → 目前在職 ${esc(g.current)} 人<br>淨補足 ${esc(g.netFilled)} 人 · 統計日 ${esc(g.asOf)}</p><details><summary>需求異動紀錄</summary>${g.history.map(h=>`<p class="record-notes">${esc(h.at.replace('T',' ').slice(0,16))}　增加 ${esc(h.additional)} 人<br>${esc(h.notes||'—')}</p>`).join('')}</details></article>`).join('')}</div>`:empty('尚未設定各組需求','先確認員工名單及離職日，再新增需要補足的人數')}</section>`;
}
function leaveExcelTable(id){
  const all=state.leaveExcel||[];
  const rows=all.filter(r=>(id?r.employeeId===id:!leaveSheet||r.sourceSheet===leaveSheet)&&(!leaveQuery||(r.name+' '+(r.employeeId||'')).includes(leaveQuery)));
  if(!rows.length)return empty('尚無符合的Excel特休紀錄','請在特休頁上傳「特休結算.xls」，或切換原分頁；不從打卡試算表取得特休');
  return table(['員工／來源','到職日','原表天數／已休','結算日期','核對／原始內容'],rows.map(r=>{
    const e=employee(r.employeeId),warnings=[...(r.warnings||[])];
    if(!e)warnings.push('尚未配對員工');
    if(e?.arrivalDate&&r.arrivalDate&&e.arrivalDate!==r.arrivalDate)warnings.push('與員工檔案到職日不同，可核對後套用');
    const dates=new Set(all.filter(a=>a.name===r.name&&a.arrivalDate).map(a=>a.arrivalDate));if(dates.size>1)warnings.push('各分頁到職日不一致');
    return `<tr><td>${e?who(e.id):esc(r.name)}<div class="muted">${esc(r.sourceFile)} · ${esc(r.sourceSheet)} · 第 ${esc(r.sourceRow)} 列</div>${button('配對員工','leave-bind',r.id)}</td><td>Excel：${esc(r.arrivalDate||r.arrivalRaw||'未填')}<div class="muted">員工檔案：${esc(e?.arrivalDate||'未填')}</div>${e&&r.arrivalDate&&e.arrivalDate!==r.arrivalDate?button('套用到職日','leave-arrival',r.id):''}</td><td>天數：${esc(r.daysRaw||'未填')}<br>已休：${esc(r.usedRaw||'未填')}<div class="muted">原表歷史值，非目前餘額</div></td><td>${r.settlements.map(s=>esc(s.label)+'：'+esc(s.date||s.raw||'未填')).join('<br>')}</td><td>${warnings.map(w=>badge(w,true)).join(' ')}<details><summary>查看原Excel內容</summary>${r.cells.map(c=>`<p class="record-notes"><b>${esc(c.label)}</b>：${esc(c.value)}</p>`).join('')}</details></td></tr>`;
  }));
}
function leavePage(){
  const sheets=[...new Set((state.leaveExcel||[]).map(r=>r.sourceSheet))].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  // Prefer the plain latest year (115), rather than an older date tab (11204).
  if(!leaveSheet&&sheets.length)leaveSheet=sheets.filter(s=>/^\d{3}$/.test(s)).sort((a,b)=>Number(b)-Number(a))[0]||sheets[0];
  return heading('特休紀錄','特休Excel與人工時數帳本分開呈現',button('新增特休紀錄','leave'))+`<section class="panel"><div class="page-head"><h2>原Excel特休紀錄</h2><button data-leave-import>匯入特休Excel</button><input id="leave-import-file" type="file" accept=".xlsx,.xls" hidden></div><p class="notice">顯示到職日、原表天數、已休、結算日期及備註。空白不當作0；保留各年度及已結清說明，確認匯入後，員工檔案缺少的到職日會由最新年度自動帶入；同名、同年度日期衝突及已有不同日期者需核對，可逐筆套用。歷史天數不自動核給為目前餘額。</p><div class="toolbar"><label>原Excel分頁<select id="leave-sheet">${sheets.map(s=>`<option ${s===leaveSheet?'selected':''}>${esc(s)}</option>`).join('')}</select></label><input id="leave-search" aria-label="搜尋特休員工" placeholder="搜尋姓名或員工編號" value="${esc(leaveQuery)}"></div><div id="leave-excel-list">${leaveExcelTable()}</div></section><section class="panel"><h2>人工特休時數帳本</h2>${recordTable('leave')}</section>`;
}
async function previewLeaveFile(file){
  if(!file||busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
    if(file.size>20*1024*1024)throw Error('特休Excel上限20MB');
    const response=await fetch('/api/leave/excel-preview?'+new URLSearchParams({filename:file.name}),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-HR-CSRF':csrf},body:file});
    const result=await response.json();if(!response.ok)throw Error(result.error||'特休Excel讀取失敗');
    openForm('leave-import','',result);
  }catch(e){notify(e.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function refreshRecruitLists(){if($('candidate-list'))$('candidate-list').innerHTML=candidateList();if($('recruit-events'))$('recruit-events').innerHTML=recruitEvents();}
async function prepareDocument(file){
  if(!file)throw Error('請先選擇檔案或拍照');
  const limit=state.settings.uploadLimit||12*1024*1024;
  if(/\.(pdf|jpe?g|png|webp)$/i.test(file.name)&&file.size<=limit)return file;
  if(/\.pdf$/i.test(file.name)&&file.size>limit)throw Error('單一文件不可超過12MB');
  if(!file.type.startsWith('image/')&&!/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name))throw Error('請選PDF、JPG、PNG或WEBP');
  let image;
  try{image=await createImageBitmap(file);}catch{throw Error('手機照片無法轉換，請改選JPG照片或在相機設定使用相容格式');}
  try{
    const scale=Math.min(1,2400/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));
    if(!blob||blob.size>limit)throw Error('照片轉換後仍超過12MB，請縮小後上傳');
    return new File([blob],'photo.jpg',{type:'image/jpeg'});
  }finally{image.close();}
}
async function uploadDocument(body,file){
  if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
    const ready=await prepareDocument(file),params=new URLSearchParams({employeeId:body.employeeId,category:body.category,filename:ready.name});
    const res=await fetch('/api/documents/upload?'+params,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-HR-CSRF':csrf},body:ready});
    const result=await res.json();if(!res.ok)throw Error(result.error||'上傳失敗');
    await load();notify('已存入NAS並綁定員工：'+result.filename);return result;
  }catch(e){notify(e.message,true);throw e;}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);const sync=document.querySelector('[data-sync]');if(sync)sync.disabled=!state?.settings.gasConfigured;}
}
function employeeOptions(value=''){return `<option value="">選擇員工</option>`+state.employees.map(e=>`<option value="${esc(e.id)}" ${e.id===value?'selected':''}>${esc(e.id+' '+e.name+'・'+e.department)}</option>`).join('');}
function field(label,name,value='',type='text',required=false,wide=false){return `<label class="${wide?'wide':''}">${esc(label)}${type==='textarea'?`<textarea name="${name}" ${required?'required':''}>${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''}>`}</label>`;}
function select(label,name,options,value=''){return `<label>${esc(label)}<select name="${name}" required>${options.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;}
function openForm(kind,id='',extra=null){
  currentForm={kind,id,extra};$('form-error').textContent='';let fields='';
  $('save-form').textContent=['recruit-import','leave-import'].includes(kind)?'確認匯入':'儲存';
  if(kind==='goal'){
    const goals=state.recruitmentGoals||[],goal=goals.find(g=>g.department===id);
    currentForm.goalRevisions=Object.fromEntries(goals.map(g=>[g.department,g.revision]));
    const depts=[...new Set([...state.employees.map(e=>e.department),...goals.map(g=>g.department)].filter(Boolean))].sort();
    $('dialog-title').textContent=goal?'增加'+id+'徵人需求':'新增部門徵人需求';
    fields=`<p class="wide notice">${goal?'目前需求 '+goal.required+' 人、淨補足 '+goal.netFilled+' 人。增加需求會保留原基準及完成進度。':'請先確認員工名單及離職日已同步。首次建立時以目前在職人數作為基準，之後報到、離職會更新淨補足人數。'}</p>`+(goal?field('部門','department',id,'text',true):select('部門（依員工檔案）','department',depts))+field('本次增加需求人數','additional',1,'number',true)+field('提出原因／備註','notes','','textarea',false,true);
  }else if(kind==='leave-arrival'){
    const row=(state.leaveExcel||[]).find(r=>r.id===id),e=employee(row.employeeId);currentForm.revision=e.revision;
    $('dialog-title').textContent='確認套用員工到職日';
    fields=`<p class="wide notice">${esc(e.id+' '+e.name)}<br>目前到職日：${esc(e.arrivalDate||'未填')}<br>套用日期：${esc(row.arrivalDate)}<br>來源：${esc(row.sourceSheet)} · 第 ${esc(row.sourceRow)} 列<br>儲存後更新員工檔案，日後同步打卡來源將保留這個已核對日期。</p>`;
  }else if(kind==='leave-bind'){
    const row=(state.leaveExcel||[]).find(r=>r.id===id);$('dialog-title').textContent='特休Excel配對員工';
    fields=`<p class="wide notice">${esc(row.name)} · ${esc(row.sourceSheet)} · 第 ${esc(row.sourceRow)} 列<br>只變更這筆來源紀錄的配對，不覆蓋員工到職日或核給時數。</p><label class="wide">員工<select name="employeeId" required>${employeeOptions(row.employeeId||'')}</select></label>`;
  }else if(kind==='leave-import'){
    $('dialog-title').textContent='確認匯入特休Excel';currentForm.payload=extra.payload;
    const rows=extra.rows,matched=rows.filter(r=>r.employeeId).length;
    fields=`<div class="wide notice">來源共 ${rows.length} 列，唯一姓名配對 ${matched} 列，待配對 ${rows.length-matched} 列；重複來源 ${rows.filter(r=>r.repeated).length} 列會略過。<br>將自動補入 ${(extra.arrivalPlan||[]).filter(p=>p.willFill).length} 位員工缺少的到職日（使用最新年度）。既有不同日期保留，匯入後可逐筆套用。各年度及結清備註均保留，歷史天數不直接核給。</div><div class="wide">${table(['姓名／分頁','到職日','天數／已休','核對提示'],rows.map(r=>`<tr><td>${esc(r.name)}<br>${esc(r.sourceSheet)} · ${esc(r.sourceRow)}</td><td>${esc(r.arrivalDate||r.arrivalRaw)}</td><td>${esc(r.daysRaw||'未填')} / ${esc(r.usedRaw||'未填')}</td><td>${r.reviewWarnings.map(esc).join('<br>')||'—'}${(extra.arrivalPlan||[]).some(p=>p.willFill&&p.employeeId===r.employeeId&&p.sourceSheet===r.sourceSheet&&p.sourceRow===r.sourceRow)?'<br><b>確認匯入後自動帶入到職日</b>':''}</td></tr>`))}</div>`;
  }else if(kind==='recruit-import'){
    $('dialog-title').textContent='確認匯入徵人資料';currentForm.payload=extra.payload;
    const m=extra.summary;fields=`<div class="wide notice">${esc(extra.payload.startDate)}～${esc(extra.payload.endDate)}<br>來源 ${m.rows} 列／依姓名電話合併 ${m.people} 人<br>待新增 ${m.newRows} 列／相同來源略過 ${m.repeatedRows} 列<br>${(extra.warnings||[]).map(esc).join('<br>')}</div><div class="wide">${table(['姓名','電話','原分頁'],extra.payload.records.slice(0,20).map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.sourceSheet)}</td></tr>`))}<p class="muted">預覽前20列；按確認後匯入全部範圍內資料。既有人工編輯資料保留。</p></div>`;
  }else if(kind==='upload'){
    $('dialog-title').textContent='上傳員工文件';
    fields=`<label>員工<select name="employeeId" required>${employeeOptions(id)}</select></label><label>文件類型<select name="category" required>${Object.entries(categoryNames).map(([k,v])=>`<option value="${k}" ${extra===k?'selected':''}>${v}</option>`).join('')}</select></label><label class="wide">選擇文件<input id="document-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,image/*"></label><label class="wide">或用手機／平板拍照<input id="document-camera" type="file" accept="image/*" capture="environment"></label><p id="upload-selection" class="wide muted">單份上限12MB；每次上傳保留新檔，會自動綁定所選員工。</p>`;
  }else if(kind==='candidate'){
    const c=id?candidate(id):{};$('dialog-title').textContent=id?'編輯應徵者':'新增應徵者';
    fields=field('姓名','name',c.name||'','text',true)+field('電話','phone',c.phone||'','tel',true)+field('應徵部門','department',c.department)+field('應徵職缺','job',c.job)+field('招募來源','source',c.source)+field('負責聯絡人','contactPerson',c.contactPerson)+field('可到職日','availableDate',c.availableDate,'date')+field('下次追蹤日','followupDate',c.followupDate,'date')+field('預約面試時間','interviewAt',c.interviewAt,'datetime-local')+select('招募進度','status',recruitStatuses,c.status||'待聯絡')+field('備註','notes',c.notes,'textarea',false,true);
  }else if(kind==='recruit-phone'||kind==='recruit-interview'){
    const c=candidate(id),phone=kind==='recruit-phone';$('dialog-title').textContent=c.name+'｜新增'+(phone?'電話':'面試')+'紀錄';
    fields=field('實際日期時間','at',localMinute(),'datetime-local',true)+field(phone?'聯絡人':'面試主管','contactPerson',c.contactPerson,'text',true)+select('結果','outcome',phone?['已接通','未接','忙線','停話／錯號','婉拒','約定面試','待回覆']:['已面試','未到場','改期','錄取','未錄取','待回覆'])+select('更新招募進度','status',recruitStatuses,c.status)+field('下次追蹤日（空白表示無待追蹤）','nextFollowup',c.followupDate,'date')+field('下次預約面試時間','nextInterviewAt',phone?c.interviewAt:'','datetime-local')+field(phone?'談話摘要':'面試內容／評語','notes','','textarea',false,true);
  }else if(kind==='recruit-convert'){
    const c=candidate(id);$('dialog-title').textContent=c.name+'｜報到並轉為員工';
    const depts=[...new Set([...state.employees.map(e=>e.department),...(state.recruitmentGoals||[]).map(g=>g.department),c.department].filter(Boolean))].sort();
    fields='<p class="wide notice">建立NAS人資員工檔案並保留招募歷程；到職日起依實際部門計入徵人進度。打卡系統仍需用相同員工編號建檔。</p>'+field('員工編號','employeeId','','text',true)+select('實際報到部門','department',['',...depts],c.department)+field('實際到職日','arrivalDate',c.availableDate||today(),'date',true)+select('聘僱型態','employmentType',['正職','時薪','兼職']);
  }else if(kind==='employee'){
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
  if(['candidate','recruit-phone','recruit-interview','recruit-convert'].includes(kind)&&id)currentForm.revision=candidate(id).revision;
  $('form-fields').innerHTML=`<div class="form-grid">${fields}</div>`;
  $('form-fields').querySelectorAll('input[type="number"]').forEach(e=>e.step='any');
  if(kind==='employee'&&id)$('form-fields').querySelector('[name=id]').readOnly=true;
  if(kind==='goal'&&id)$('form-fields').querySelector('[name=department]').readOnly=true;
  $('form-dialog').showModal();
}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||busy)return;
  if(!state&&b.id!=='refresh'){notify('請先重新整理，恢復公司網路連線。',true);return;}
  try{
    if(b.dataset.page){page=b.dataset.page;employeeId=null;candidateId=null;tab='basic';render();}
    else if(b.dataset.candidate){page='recruitment';candidateId=b.dataset.candidate;render();}
    else if(b.hasAttribute('data-recruit-back')){candidateId=null;render();}
    else if(b.dataset.recruitScope){recruitFilters.scope=b.dataset.recruitScope;recruitPage=1;recruitEventPage=1;render();}
    else if(b.dataset.recruitPager){if(b.dataset.recruitPager==='people')recruitPage+=Number(b.dataset.direction);else recruitEventPage+=Number(b.dataset.direction);refreshRecruitLists();}
    else if(b.hasAttribute('data-recruit-import'))$('recruit-import-file').click();
    else if(b.hasAttribute('data-leave-import'))$('leave-import-file').click();
    else if(b.dataset.upload)openForm('upload',b.dataset.id,b.dataset.upload);
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
    else if(b.id==='refresh'||b.id==='goal-refresh'){await load();notify('資料與徵人進度已更新。');}
    else if(b.id==='import-button')$('import-file').click();
  }catch{/* Action already displays errors. */}
});
document.addEventListener('input',event=>{if(event.target.id==='leave-search'){leaveQuery=event.target.value;$('leave-excel-list').innerHTML=leaveExcelTable();}if(event.target.id==='recruit-search'){recruitFilters.query=event.target.value;recruitPage=1;recruitEventPage=1;refreshRecruitLists();}if(event.target.id==='employee-search')$('employee-table').innerHTML=employeeTable(event.target.value,$('employee-filter').value);});
document.addEventListener('change',async event=>{
  const recruitKeys={'recruit-department':'department','recruit-status':'status','recruit-date':'date','recruit-date-mode':'dateMode'};if(recruitKeys[event.target.id]){recruitFilters[recruitKeys[event.target.id]]=event.target.value;recruitPage=1;recruitEventPage=1;refreshRecruitLists();}
  if(event.target.id==='recruit-import-file'){const file=event.target.files[0];try{await previewRecruitmentFile(file);}finally{event.target.value='';}}
  if(event.target.id==='leave-import-file'){const file=event.target.files[0];try{await previewLeaveFile(file);}finally{event.target.value='';}}
  if(event.target.id==='leave-sheet'){leaveSheet=event.target.value;$('leave-excel-list').innerHTML=leaveExcelTable();}
  if(['document-file','document-camera'].includes(event.target.id)){currentForm.file=event.target.files[0];$('upload-selection').textContent=currentForm.file?'已選擇：'+currentForm.file.name:'尚未選擇檔案';}

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
  if(form.kind==='leave-import'){try{const r=await action('/api/leave/import',form.payload,'特休Excel歷史紀錄已存入NAS。');notify('特休匯入完成：新增 '+r.added+' 列，相同來源略過 '+r.skipped+' 列；自動帶入 '+(r.arrivalFilled||0)+' 位到職日。');$('form-dialog').close();}catch(e){$('form-error').textContent=e.message;}return;}
  if(form.kind==='recruit-import'){try{const r=await action('/api/recruitment/import',form.payload,'徵人資料已匯入NAS。');notify('匯入完成：新增 '+r.counts.candidates+' 位應徵者、'+r.counts.events+' 筆聯絡紀錄；相同來源略過 '+r.counts.skipped+' 列。');$('form-dialog').close();}catch(e){$('form-error').textContent=e.message;}return;}
  if(form.kind==='upload'){try{await uploadDocument(body,form.file);$('form-dialog').close();}catch(e){$('form-error').textContent=e.message;}return;}
  if(form.kind==='goal'){endpoint='/api/recruitment/goal';body.additional=Number(body.additional);body.revision=form.goalRevisions[body.department]||0;}
  else if(form.kind==='leave-arrival'){endpoint='/api/leave/arrival';body.id=form.id;body.revision=form.revision;}
  else if(form.kind==='leave-bind'){endpoint='/api/leave/bind';body.id=form.id;}
  else if(form.kind==='candidate'){endpoint='/api/recruitment/candidate';if(form.id){body.id=form.id;body.revision=form.revision;}}
  else if(form.kind.startsWith('recruit-')){const c=candidate(form.id);body.candidateId=c.id;body.revision=form.revision;endpoint=form.kind==='recruit-convert'?'/api/recruitment/convert':'/api/recruitment/event';if(form.kind!=='recruit-convert')body.kind=form.kind==='recruit-phone'?'phone':'interview';}
  else if(form.kind==='employee'){endpoint='/api/employee';const old=form.id?employee(form.id):null;if(old){body.revision=old.revision;body.lineBound=old.lineBound;}}
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
let refreshTicks=0;
setInterval(async()=>{
  if(!state||busy)return;
  try{await request('/api/ping');if(++refreshTicks%4===0&&page==='recruitment'&&!$('form-dialog').open&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))await load();}
  catch(e){state=null;csrf='';$('form-dialog').close();$('preview-dialog').close();$('preview-content').replaceChildren();$('content').innerHTML=empty('公司網路連線中斷','已隱藏人事資料，回公司後請重新整理。');notify(e.message,true);}
},15000);
