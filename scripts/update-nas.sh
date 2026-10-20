#!/bin/sh
# Synology DSM manual task, run as root. Existing .env and NAS documents are preserved.
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
PROJECT_DIR=${HR_PROJECT_DIR:-/volume1/docker/HumanResourceManagement}
UPDATE_REF=${1:-main}
# Accept only a branch name fixed here or a hexadecimal commit SHA.
if [ "$UPDATE_REF" != main ]; then
  [ "${#UPDATE_REF}" -eq 40 ] || exit 1
  case "$UPDATE_REF" in *[!0-9a-f]*) exit 1 ;; esac
fi
cd "$PROJECT_DIR"
[ -f .env ] || { echo '找不到原本的.env，請確認專案路徑'; exit 1; }
exec > "$PROJECT_DIR/hr-update.log" 2>&1
date
echo '開始更新人資文件上傳及徵人功能'
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM
curl --fail --location --retry 2 --proto '=https' "https://github.com/bai-qi-laundering/HumanResourceManagement/archive/$UPDATE_REF.zip" -o "$STAGE_DIR/source.zip"
# DSM may not provide unzip. Use Python from the already installed HR image.
CURRENT_IMAGE=$(docker inspect -f '{{.Image}}' baiqi-hr)
docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
  --mount "type=bind,source=$STAGE_DIR,target=/update" \
  --entrypoint python "$CURRENT_IMAGE" -c '
import zipfile
with zipfile.ZipFile("/update/source.zip") as archive:
    if sum(item.file_size for item in archive.infolist()) > 50 * 1024 * 1024:
        raise SystemExit("更新檔案大小異常，原程式未變更")
    archive.extractall("/update")
print("更新檔案解壓完成")
'
SOURCE_DIR="$STAGE_DIR/HumanResourceManagement-$UPDATE_REF"
[ -f "$SOURCE_DIR/server.py" ] && [ -f "$SOURCE_DIR/compose.yaml" ] || { echo '下載內容不完整，原程式未變更'; exit 1; }
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose -p baiqi-hr "$@"; }
else
  compose() { docker-compose -p baiqi-hr "$@"; }
fi
[ "$(docker inspect -f '{{.State.Running}}' baiqi-hr)" = true ] || { echo '請先啟動目前的人資容器，才能建立資料庫備份'; exit 1; }
docker exec baiqi-hr python -c '
import datetime, os, pathlib, sqlite3
root=pathlib.Path(os.environ.get("HR_DATA_DIR","/data")); folder=root/"backups"; folder.mkdir(exist_ok=True)
path=folder/("hr-before-upload-recruitment-"+datetime.datetime.now().strftime("%Y%m%d-%H%M%S")+".sqlite3")
source=sqlite3.connect(root/"hr.sqlite3"); target=sqlite3.connect(path)
source.backup(target); target.close(); source.close(); os.chmod(path,0o600)
print("資料庫備份完成：",path.name)
'
mkdir -p backups
chmod 700 backups
STAMP=$(date +%Y%m%d-%H%M%S)
tar -czf "backups/code-before-upload-recruitment-$STAMP.tar.gz" server.py public Dockerfile compose.yaml requirements.txt
for item in server.py Dockerfile compose.yaml requirements.txt README.md .env.example; do
  cp "$SOURCE_DIR/$item" "$PROJECT_DIR/$item"
done
for item in public docs scripts; do
  mkdir -p "$PROJECT_DIR/$item"
  cp -R "$SOURCE_DIR/$item/." "$PROJECT_DIR/$item/"
done
compose up -d --build --no-deps --force-recreate hr
sleep 3
[ "$(docker inspect -f '{{.State.Running}}' baiqi-hr)" = true ] || { echo '容器未正常運作，請查看容器日誌；程式及資料庫備份均已保留'; exit 1; }
echo '更新完成。請重新整理人資網頁，確認徵人分頁及證件文件的上傳按鈕。'
echo '文件上傳仍需原NAS帳號對文件資料夾具有寫入權限；.env及既有文件均未修改。'
