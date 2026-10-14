# 串接現在的 LINE 打卡／GAS

初版為 **只讀連動**。不改打卡資料、不處理薪資公式、不推送 LINE 訊息。

## Apps Script 端

1. 打開目前 LINE Webhook 正在使用的打卡 Apps Script 專案。
2. 新增指令碼檔案 `HrExport`，貼入此專案 `integration/HrExport.gs` 的完整內容。它只新增 `baiqiHrExport_`，不定義第二個 `doPost`。
3. 在原 `doPost(e)` 中找到：

```javascript
var json = JSON.parse(e.postData.contents);
```

緊接著加入這一行（在 LINE `events` 分流與打卡 API 分流之前）：

```javascript
if (json && json.action === 'hr_export') return baiqiHrExport_(json);
```

4. 專案設定 → 指令碼屬性 → 新增 `HR_EXPORT_SECRET`。值是自己產生的至少32字元随机密鑰（建議64字元），與 NAS `.env` 的 `HR_GAS_SECRET` 一樣。不得填進 GitHub 或公開試算表。
5. 儲存，**更新原部署的新版本**。原 `/exec`、Webhook、LIFF 網址不改。

匯出資料：

- 員工資料 A編號、B姓名、D部門、E聘僱型態、G離職日；到職日期依表頭找到。C只匯出「已／未綁定」，不匯出 LINE user ID。
- 薪資計算明細中的總結列：月份A、員工編號C、實發L、工時G、加班H/I/J、勞健保K，及原表頭／欄位快照。適用本對話目前的薪資明細版型；不同版型需先調整。
- 最近兩個月原打卡：A日期、B時間、D編號、G狀態、I備註、J上／下班。狀態空白不排除。匯入明確時間窗口時會更新该窗口，避免來源補卡修正後保留舊副本。

## NAS 端

`.env` 加入：

```dotenv
HR_GAS_URL=https://script.google.com/macros/s/你的部署ID/exec
HR_GAS_SECRET=與AppsScript屬性完全相同的密鑰
```

重新建立／啟動容器。進人資「連線與匯入」→「同步打卡資料」。

HTTP請求在後端簽署，只有短時間有效、含防重放 nonce；密鑰不會出現在瀏覽器。GAS驗證通過才匯出。請勿用公開 CSV 網址暴露員工或薪資。

## 薪資歷史

原「薪資計算明細」若每月覆蓋，匯出器只能取得當下仍存在的月份。請每月算完薪資後同步保存到 HR，核對後標記核定／已付款。新的同月金額會新增版本，不改原已付款版本；一樣的匯入不重複新增。

人資此時不回寫保險／特休到既有薪資程式。待確認這套人資資料與計薪政策後，再加入第二階段回寫。

## 無法先調整 GAS 時

可從已授權的內部來源整理 JSON，於「連線與匯入 → 匯入JSON」匯入。格式如下；內容僅為格式範例，勿當真實員工資料使用：

```json
{
  "schema": 1,
  "employees": [{"id": "TEST001", "name": "範例員工", "department": "辦公室", "employmentType": "正職", "arrivalDate": "2026-01-01", "departureDate": ""}],
  "salaries": [{"employeeId": "TEST001", "month": "2026-09", "netPay": 30000, "workHours": 176}],
  "attendance": [{"employeeId": "TEST001", "date": "2026-10-14", "time": "08:00:00", "type": "上班", "status": "", "notes": ""}]
}
```

匯入會以編號合併人員並保留人資自行填寫的電話、緊急聯絡人、紙本位置與備註；來源名單不會刪掉 HR 人員。相同編號重複時全批停止，不留下半套更新。
