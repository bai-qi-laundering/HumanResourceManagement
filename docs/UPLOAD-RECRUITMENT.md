# 文件上傳與徵人功能（2026-10-20）

## 已安裝 NAS 的更新步驟

本版沿用既有 `.env`、SQLite 及文件路徑。Compose 已對齊目前運作中的 host network，仍只綁 NAS 內網 IP:8090；文件掛載改為允許寫入。不要刪除資料庫或重新填密鑰。

1. File Station → 原來的身分證／駕照資料夾 → 內容 → 權限，讓 `HR_UID` 對應的 NAS 帳號具有讀取、列出及新增／寫入權限。存摺資料夾也需同樣設定。身分證與駕照共用同一資料夾時，只需設定一次。保留其他使用者既有權限，不開放 everyone。
2. DSM → 控制台 → 工作排程器 → 新增「使用者自訂指令碼」，使用者選 root；停用排程，只手動執行。
3. 貼上以下內容；專案資料夾目前為 `/volume1/docker/HumanResourceManagement`：

```sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
TASK_DIR=$(mktemp -d)
trap 'rm -rf "$TASK_DIR"' EXIT HUP INT TERM
curl --fail --location --retry 2 --proto '=https' https://raw.githubusercontent.com/bai-qi-laundering/HumanResourceManagement/main/scripts/update-nas.sh -o "$TASK_DIR/update-nas.sh"
sh "$TASK_DIR/update-nas.sh"
```

4. 手動執行。這會先下載新版、備份目前資料庫和程式，再重新建置原本的 `baiqi-hr` 專案。需要 NAS 可連 GitHub 及容器套件來源。網址不變。
5. 在 File Station 查看專案內 `hr-update.log`。資料庫備份位於資料目錄下 `backups/hr-before-upload-recruitment-日期時間.sqlite3`；舊程式位於專案 `backups/code-before-upload-recruitment-日期時間.tar.gz`。備份失敗時不會覆蓋原程式。
6. 重新整理 `http://192.168.123.201:8090/`。

若選擇手動下載 ZIP 更新，也必須完整更新 `server.py`、`public/`、`compose.yaml`，保留 `.env`，並重新建置，不能只重新啟動。若原專案另有自行修改的部署設定，先與備份的 Compose 比對。

## 文件操作

員工檔案 → 選員工 → 證件文件 → 身分證／存摺／駕照「上傳／拍照」→ 選檔案或用相機拍照 → 儲存。文件配對頁也可上傳並選員工。

- 可選 JPG、JPEG、PNG、WEBP、PDF；每份最多 12MB。大照片及瀏覽器可解碼的其他照片會嘗試轉成 JPG。HEIC 若瀏覽器無法解碼，請在手機先轉 JPG，或把相機改為相容格式。
- 拍照按鈕是否直接開相機由裝置與瀏覽器決定；公司電腦可選既有檔案。
- 每次上傳建立新檔，檔名為 `員工編號_姓名_文件類型_日期時間_隨機碼.副檔名`；舊檔保留，並直接綁定所選員工。
- 身分證正反面可分兩次上傳，每份都會保留。網站不提供刪除原檔操作。
- NAS 帳號權限及掛載都需允許寫入。連線與匯入頁會顯示「可讀寫」或「可讀取／未允許上傳」；實際上傳仍會驗證 NAS 權限與剩餘空間。

## 徵人操作

- 「新增應徵者」填姓名、電話、部門／職缺、來源、負責人、可到職日、追蹤日與預約面試。
- 名單可依姓名、電話、職缺、部門及進度篩選。
- 「今日待聯絡」包含今天到期及已逾期且尚未結案的人；「今日面試」按預約日期；另有逾期追蹤與待報到。
- 每次按「電話紀錄」或「面試紀錄」，輸入實際日期時間、聯絡人／面試主管、結果、內容及後續安排。紀錄逐筆追加；編輯基本資料不會刪掉歷程。
- 每日紀錄可切換日期；點姓名可看所有日期的完整電話與面試歷程。完成面試且沒有新預約時，會清除舊面試預約。
- 「報到並轉為員工」需填未使用的員工編號及實際到職日，才會建立 NAS 員工檔案。已有相同編號時不覆蓋。原應徵資料與歷程保留。
- 轉員工不會自動寫入既有打卡試算表；請在原打卡系統使用相同編號建檔與 LINE 綁定，再同步即可對應同一人。

所有招募及文件資料仍只保存在 NAS，沿用公司網路限制；此版本沒有對外招募表單。
