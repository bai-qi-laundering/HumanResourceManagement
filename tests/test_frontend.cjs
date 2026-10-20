/* Node VM interaction test; real browser visual QA is still required on NAS. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const fixtures={employees:[{id:'TEST001',name:'測試員工',department:'摺疊',employmentType:'正職',arrivalDate:'2024-01-01',revision:1}],records:[],salaries:[],documents:[],attendance:[],candidates:[{id:'candidate1',name:'應徵測試',phone:'0912345678',department:'洗滌',job:'洗滌人員',status:'待面試',followupDate:'2026-10-20',interviewAt:'2026-10-21T10:00',revision:1}],recruitmentEvents:[{id:'event1',candidateId:'candidate1',kind:'phone',at:'2026-10-20T09:00',contactPerson:'NANA',outcome:'約定面試',notes:'已確認面試',created:'2026-10-20T09:01'}],audit:[],settings:{documentRoots:{identity:false,bank:false,license:false},gasConfigured:false},csrf:'a'.repeat(64)};
class Node {constructor(){this.innerHTML='';this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.style={};this.classList={toggle(){}};this.listeners={};}addEventListener(e,fn){this.listeners[e]=fn;}querySelectorAll(){return [];}querySelector(){return new Node();}close(){this.open=false;}showModal(){this.open=true;}replaceChildren(){this.innerHTML='';}append(){} }
const nodes=new Map(),listeners={},get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};let heartbeat;
const context={console,Intl,Date,Number,JSON,String,Object,Array,Set,FormData:class{},setInterval:fn=>{heartbeat=fn;},confirm:()=>true,fetch:async()=>({ok:true,json:async()=>fixtures}),document:{getElementById:get,addEventListener:(e,fn)=>listeners[e]=fn,querySelectorAll:()=>[],querySelector:()=>null,createElement:()=>new Node()}};
vm.createContext(context);vm.runInContext(fs.readFileSync('public/app.js','utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert(get('content').innerHTML.includes('人事待辦總覽'));
 for(const page of ['employees','insurance','salary','leave','documents','settings','recruitment']){vm.runInContext(`page='${page}';render();`,context);assert(get('content').innerHTML.length>100);}
 vm.runInContext("page='employees';employeeId='TEST001';tab='basic';render();",context);assert(get('content').innerHTML.includes('紙本原件位置'));
 for(const tab of ['insurance','documents','salary','leave','attendance','change']){vm.runInContext(`tab='${tab}';render();`,context);assert(!get('content').innerHTML.includes('undefined'));}
 const evil='<img src=x onerror=alert(1)>';
 fixtures.employees[0].name=evil;vm.runInContext("tab='basic';render();",context);assert(!get('content').innerHTML.includes('<img src=x'));assert(get('content').innerHTML.includes('&lt;img'));
 for(const kind of ['employee','insurance','salary','leave','change']){context.openForm(kind,'TEST001');assert(get('form-dialog').open);assert(get('form-fields').innerHTML.includes('name='));}
 vm.runInContext("page='recruitment';candidateId='candidate1';render();",context);assert(get('content').innerHTML.includes('已確認面試'));assert(get('content').innerHTML.includes('應徵測試'));
 for(const kind of ['candidate','recruit-phone','recruit-interview','recruit-convert']){context.openForm(kind,'candidate1');assert(get('form-dialog').open);assert(!get('form-fields').innerHTML.includes('undefined'));}
 context.openForm('upload','TEST001','bank');assert(get('form-fields').innerHTML.includes('capture="environment"'));
 const previousRevision=vm.runInContext("openForm('candidate','candidate1');currentForm.revision",context);fixtures.candidates[0].revision=9;assert.equal(vm.runInContext('currentForm.revision',context),previousRevision);
 fixtures.candidates[0].name=evil;fixtures.recruitmentEvents[0].notes=evil;vm.runInContext("render();",context);assert(!get('content').innerHTML.includes('<img src=x'));assert(get('content').innerHTML.includes('&lt;img'));
 let sent=[];let formEntries=[];
 context.FormData=class {constructor(){return formEntries[Symbol.iterator]();}};
 context.fetch=async(path,options)=>{if(options?.method==='POST')sent.push({path,options});return {ok:true,json:async()=>path.startsWith('/api/documents/upload')?{filename:'new-document.pdf'}:fixtures};};
 context.openForm('candidate','candidate1');formEntries=[['name','測試更改'],['phone','0912345678'],['status','待面試']];
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/recruitment/candidate');assert.equal(JSON.parse(sent.at(-1).options.body).revision,9);
 context.openForm('recruit-phone','candidate1');formEntries=[['at','2026-10-20T10:00'],['contactPerson','NANA'],['outcome','未接']];
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/recruitment/event');assert.equal(JSON.parse(sent.at(-1).options.body).kind,'phone');
 context.openForm('recruit-convert','candidate1');formEntries=[['employeeId','F999'],['arrivalDate','2026-10-20'],['employmentType','正職']];
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/recruitment/convert');
 context.openForm('upload','TEST001','bank');vm.runInContext("currentForm.file={name:'test.pdf',type:'application/pdf',size:30}",context);formEntries=[['employeeId','TEST001'],['category','bank']];context.URLSearchParams=URLSearchParams;
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert(sent.at(-1).path.startsWith('/api/documents/upload?'));assert.equal(sent.at(-1).options.body.name,'test.pdf');assert.equal(sent.at(-1).options.headers['X-HR-CSRF'],'a'.repeat(64));
 const payload={schema:'baiqi-recruitment',version:1,startDate:'2026-07-01',endDate:'2026-10-20',records:[{name:'測試人員',phone:'0900000001',sourceSheet:'115年7月1日'}]};
 context.openForm('recruit-import','',{payload,summary:{rows:1,people:1,newRows:1,repeatedRows:0},warnings:[]});assert(get('form-fields').innerHTML.includes('測試人員'));assert.equal(get('save-form').textContent,'確認匯入');
 context.fetch=async(path,options)=>{if(options?.method==='POST')sent.push({path,options});return {ok:true,json:async()=>path==='/api/recruitment/import'?{counts:{candidates:1,events:1,skipped:0}}:fixtures};};
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/recruitment/import');
 fixtures.recruitmentEvents.push({id:'unknown1',candidateId:'candidate1',kind:'phone',at:'',contactDate:'',rangeStart:'2026-07-02',rangeEnd:'2026-07-08',sourceSheet:'115年7月2日8日',sourceRow:2,rawCallTime:'10:00',imported:true,outcome:'原Excel紀錄',notes:'日期未填',created:'2026-10-20T10:00'});
 vm.runInContext("page='recruitment';candidateId=null;recruitFilters.dateMode='unknown';render();",context);assert(get('content').innerHTML.includes('日期未填'));assert(get('content').innerHTML.includes('原撥打時間'));
 fixtures.recruitmentGoals=[{department:'洗滌',baseline:10,current:12,required:5,netFilled:2,filled:2,remaining:3,percent:40,revision:1,asOf:'2026-10-20',history:[{at:'2026-10-20T10:00',additional:5,notes:'現場補人'}]}];
 vm.runInContext("page='recruitment';render();",context);assert(get('content').innerHTML.includes('40%'));assert(get('content').innerHTML.includes('還需 3 人'));
 context.openForm('goal','洗滌');formEntries=[['department','洗滌'],['additional','2'],['notes','增加需求']];
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/recruitment/goal');assert.equal(JSON.parse(sent.at(-1).options.body).revision,1);
 fixtures.leaveExcel=[{id:'leave1',employeeId:'TEST001',name:evil,arrivalDate:'2023-01-01',sourceFile:'特休.xls',sourceSheet:'115',sourceRow:2,daysRaw:'7+3',usedRaw:'',warnings:[],settlements:[],cells:[{label:'備註',value:evil}]}];
 vm.runInContext("page='leave';render();",context);assert(!get('content').innerHTML.includes('從打卡試算表匯入後顯示'));assert(get('content').innerHTML.includes('7+3'));assert(get('content').innerHTML.includes('已休：未填'));assert(!get('content').innerHTML.includes('<img src=x'));
 context.openForm('leave-bind','leave1');formEntries=[['employeeId','TEST001']];await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/leave/bind');
 const leavePayload={records:[{name:'測試',sourceSheet:'115',sourceRow:2}]};context.openForm('leave-import','',{payload:leavePayload,rows:[{name:'測試',sourceSheet:'115',sourceRow:2,reviewWarnings:['到職日需核對']}]});assert(get('form-fields').innerHTML.includes('到職日需核對'));
 context.fetch=async(path,options)=>{if(options?.method==='POST')sent.push({path,options});return {ok:true,json:async()=>path==='/api/leave/import'?{added:1,skipped:0}:fixtures};};
 await get('edit-form').listeners.submit({preventDefault(){},target:{}});assert.equal(sent.at(-1).path,'/api/leave/import');
 context.fetch=async()=>{throw Error('offline');};await heartbeat();assert(get('content').innerHTML.includes('公司網路連線中斷'));assert.equal(vm.runInContext('state',context),null);
 console.log('PASS: all application views, employee tabs/forms, escaped names, disconnect clears loaded data.');
})().catch(e=>{console.error(e);process.exitCode=1;});
