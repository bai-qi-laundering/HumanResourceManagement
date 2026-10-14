/** 加入原打卡Apps Script的獨立檔案；不新增doPost、不更换Webhook。 */
function baiqiHrExport_(request) {
  const fail = function () { return ContentService.createTextOutput(JSON.stringify({success:false})).setMimeType(ContentService.MimeType.JSON); };
  try {
    const secret=PropertiesService.getScriptProperties().getProperty('HR_EXPORT_SECRET')||'';
    const timestamp=Number(request.timestamp),nonce=String(request.nonce||''),signature=String(request.signature||'');
    if(secret.length<32||!Number.isInteger(timestamp)||Math.abs(Date.now()/1000-timestamp)>180||!/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))return fail();
    const wanted=Utilities.computeHmacSha256Signature(timestamp+'|'+nonce,secret).map(function(b){return ('0'+(b&255).toString(16)).slice(-2);}).join('');
    let diff=0;for(let i=0;i<wanted.length;i++)diff|=wanted.charCodeAt(i)^signature.charCodeAt(i);if(diff)return fail();
    const lock=LockService.getScriptLock();if(!lock.tryLock(2000))return fail();
    try {
      const cache=CacheService.getScriptCache(),key='HR_NONCE_'+nonce;
      if(cache.get(key))return fail();cache.put(key,'1',360);
    } finally { lock.releaseLock(); }
    const ss=typeof baiqiLeaderSS_==='function'?baiqiLeaderSS_():SpreadsheetApp.getActiveSpreadsheet();
    if(!ss)return fail();
    const empSheet=ss.getSheetByName('員工資料');if(!empSheet)return fail();
    const raw=empSheet.getDataRange().getDisplayValues(),headers=raw.shift();
    const arrivalIndices=headers.map(function(v,i){return ['到職日','到職日期','入職日','入職日期'].includes(String(v).replace(/\s/g,''))?i:-1;}).filter(function(i){return i>=0;});
    if(arrivalIndices.length>1)return fail();
    const formatDate=function(value){if(!value)return '';const m=String(value).match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);return m?m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'):String(value);};
    const employees=raw.filter(function(r){return r[0];}).map(function(r){return {id:String(r[0]).trim(),name:r[1],department:r[3],employmentType:r[4],arrivalDate:arrivalIndices.length?formatDate(r[arrivalIndices[0]]):'',departureDate:formatDate(r[6]),lineBound:r[2]?'已綁定':'未綁定'};});
    const ids=new Set(employees.map(function(e){return e.id.toUpperCase();}));
    const payroll=ss.getSheetByName('薪資計算明細'),salaries=[];
    const num=function(v){const n=Number(String(v||'0').replace(/,/g,''));if(!Number.isFinite(n))throw new Error('薪資數字無效');return n;};
    if(payroll){
      const values=payroll.getDataRange().getDisplayValues(),head=values.shift();
      values.forEach(function(r){
        const month=String(r[0]||'').replace('/','-'),id=String(r[2]||'').trim();
        if(/^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&ids.has(id.toUpperCase()))salaries.push({employeeId:id,month:month,netPay:num(r[11]),workHours:num(r[6]),otHours:num(r[7])+num(r[8]),otPay:num(r[9]),insuranceTotal:num(r[10]),details:{headers:head,values:r}});
      });
    }
    // 同步最近兩個月原始打卡，不重新配對，也不執行薪資計算。
    const taipei=Utilities.formatDate(new Date(),'GMT+8','yyyy-MM-dd'),y=Number(taipei.slice(0,4)),m=Number(taipei.slice(5,7));
    const start=new Date(Date.UTC(y,m-2,1));const windowStart=Utilities.formatDate(start,'UTC','yyyy-MM-dd');
    const attendance=[],log=ss.getSheetByName('打卡紀錄');
    if(log&&log.getLastRow()>1){
      log.getRange(2,1,log.getLastRow()-1,Math.min(11,log.getLastColumn())).getDisplayValues().forEach(function(r){
        const date=formatDate(r[0]),id=String(r[3]||'').trim(),type=String(r[9]||'').trim();
        if(date<windowStart||date>taipei||!ids.has(id.toUpperCase())||!['上班','下班'].includes(type))return;
        const time=String(r[1]||'').trim(),match=time.match(/^(?:(上午|下午|AM|PM)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
        if(!match)return;let hour=Number(match[2]);const period=(match[1]||match[5]||'').toUpperCase();
        if(period){if(hour===12)hour=0;if(period==='下午'||period==='PM')hour+=12;}
        attendance.push({employeeId:id,date:date,time:String(hour).padStart(2,'0')+':'+match[3]+':'+(match[4]||'00'),type:type,status:r[6]||'',notes:r[8]||''});
      });
    }
    return ContentService.createTextOutput(JSON.stringify({success:true,data:{schema:1,employees:employees,salaries:salaries,attendance:attendance,attendanceWindow:{start:windowStart,end:taipei}}})).setMimeType(ContentService.MimeType.JSON);
  }catch(error){return fail();}
}
