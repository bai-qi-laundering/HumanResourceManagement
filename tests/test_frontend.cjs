/* Node VM interaction test; real browser visual QA is still required on NAS. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const fixtures={employees:[{id:'TEST001',name:'測試員工',department:'摺疊',employmentType:'正職',arrivalDate:'2024-01-01',revision:1}],records:[],salaries:[],documents:[],attendance:[],audit:[],settings:{documentRoots:{identity:false,bank:false,license:false},gasConfigured:false},csrf:'a'.repeat(64)};
class Node {constructor(){this.innerHTML='';this.textContent='';this.hidden=false;this.disabled=false;this.value='';this.style={};this.classList={toggle(){}};this.listeners={};}addEventListener(e,fn){this.listeners[e]=fn;}querySelectorAll(){return [];}querySelector(){return new Node();}close(){this.open=false;}showModal(){this.open=true;}replaceChildren(){this.innerHTML='';}append(){} }
const nodes=new Map(),listeners={},get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};let heartbeat;
const context={console,Intl,Date,Number,JSON,String,Object,Array,Set,FormData:class{},setInterval:fn=>{heartbeat=fn;},confirm:()=>true,fetch:async()=>({ok:true,json:async()=>fixtures}),document:{getElementById:get,addEventListener:(e,fn)=>listeners[e]=fn,querySelectorAll:()=>[],querySelector:()=>null,createElement:()=>new Node()}};
vm.createContext(context);vm.runInContext(fs.readFileSync('public/app.js','utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert(get('content').innerHTML.includes('人事待辦總覽'));
 for(const page of ['employees','insurance','salary','leave','documents','settings']){vm.runInContext(`page='${page}';render();`,context);assert(get('content').innerHTML.length>100);}
 vm.runInContext("page='employees';employeeId='TEST001';tab='basic';render();",context);assert(get('content').innerHTML.includes('紙本原件位置'));
 for(const tab of ['insurance','documents','salary','leave','attendance','change']){vm.runInContext(`tab='${tab}';render();`,context);assert(!get('content').innerHTML.includes('undefined'));}
 const evil='<img src=x onerror=alert(1)>';
 fixtures.employees[0].name=evil;vm.runInContext("tab='basic';render();",context);assert(!get('content').innerHTML.includes('<img src=x'));assert(get('content').innerHTML.includes('&lt;img'));
 for(const kind of ['employee','insurance','salary','leave','change']){context.openForm(kind,'TEST001');assert(get('form-dialog').open);assert(get('form-fields').innerHTML.includes('name='));}
 context.fetch=async()=>{throw Error('offline');};await heartbeat();assert(get('content').innerHTML.includes('公司網路連線中斷'));assert.equal(vm.runInContext('state',context),null);
 console.log('PASS: all application views, employee tabs/forms, escaped names, disconnect clears loaded data.');
})().catch(e=>{console.error(e);process.exitCode=1;});
