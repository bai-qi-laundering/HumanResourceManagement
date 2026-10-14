"""百麒人資：內網 WSGI API、SQLite、NAS 唯讀文件。"""
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
TZ = ZoneInfo('Asia/Taipei')
DOC_TYPES = {'identity': '身分證', 'bank': '存摺', 'license': '駕照'}
MIMES = {'.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}
EMP_FIELDS = ['name', 'department', 'job', 'employmentType', 'arrivalDate', 'departureDate', 'phone', 'emergencyContact', 'paperLocation', 'notes', 'lineBound']


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def now():
    return datetime.now(TZ).isoformat(timespec='seconds')


def clean(value, maximum=1000):
    value = str(value if value is not None else '').strip()
    if len(value) > maximum or '\x00' in value:
        raise Problem('輸入內容過長或格式錯誤')
    return value


def ident(value):
    value = clean(value, 32).upper()
    if not re.fullmatch(r'[A-Z0-9_-]{1,32}', value):
        raise Problem('員工編號限英數字、底線及短橫線')
    return value


def valid_date(value, optional=True):
    value = clean(value, 10).replace('/', '-')
    if not value and optional:
        return ''
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise Problem('日期請使用 YYYY-MM-DD')


def number(value, low=0, high=100000000):
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise Problem('金額或時數格式錯誤')
    if not math.isfinite(value) or not low <= value <= high:
        raise Problem('金額或時數超出允許範圍')
    return value


def compact(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS salaries(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), month TEXT NOT NULL, digest TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(employee_id,month,digest));
                CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, category TEXT NOT NULL, relative_path TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, available INTEGER NOT NULL, employee_id TEXT REFERENCES employees(id), suggestions TEXT NOT NULL, UNIQUE(category,relative_path));
                CREATE TABLE IF NOT EXISTS attendance(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA journal_mode=WAL')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def audit(self, db, actor, action, target, detail=''):
        db.execute('INSERT INTO audit(created,actor,action,target,detail) VALUES(?,?,?,?,?)', (now(), actor, action, target, clean(detail, 500)))

    def employee(self, db, employee_id):
        row = db.execute('SELECT * FROM employees WHERE id=?', (ident(employee_id),)).fetchone()
        if not row:
            raise Problem('找不到員工', 404)
        return {'id': row['id'], **json.loads(row['data']), 'revision': row['revision']}

    def save_employee(self, body, actor):
        employee_id = ident(body.get('id'))
        data = {key: clean(body.get(key, ''), 4000 if key == 'notes' else 200) for key in EMP_FIELDS}
        if not data['name']:
            raise Problem('請填姓名')
        for key in ['arrivalDate', 'departureDate']:
            data[key] = valid_date(data[key])
        if data['arrivalDate'] and data['departureDate'] and data['arrivalDate'] > data['departureDate']:
            raise Problem('離職日不可早於到職日')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM employees WHERE id=?', (employee_id,)).fetchone()
            if old:
                if body.get('revision') != old['revision']:
                    raise Problem('資料已被其他電腦更新，請重新載入後編輯', 409)
                revision = old['revision'] + 1
                db.execute('UPDATE employees SET data=?,revision=? WHERE id=?', (compact(data), revision, employee_id))
            else:
                if body.get('revision'):
                    raise Problem('原員工已不存在，請重新載入', 409)
                revision = 1
                db.execute('INSERT INTO employees(id,data) VALUES(?,?)', (employee_id, compact(data)))
            self.audit(db, actor, '儲存員工資料', employee_id)
        return {'id': employee_id, **data, 'revision': revision}

    def add_record(self, body, actor):
        employee_id = ident(body.get('employeeId'))
        kind = body.get('kind')
        if kind not in ['insurance', 'leave', 'change']:
            raise Problem('紀錄種類錯誤')
        data = {'date': valid_date(body.get('date'), False), 'notes': clean(body.get('notes'), 2000)}
        if kind == 'insurance':
            if body.get('type') not in ['勞保', '健保', '勞退'] or body.get('action') not in ['加保', '退保', '級距異動', '眷屬異動', '提繳異動']:
                raise Problem('請選保險種類及異動項目')
            data.update(type=body['type'], action=body['action'], amount=number(body.get('amount', 0)), dependentCount=int(number(body.get('dependentCount', 0), 0, 20)), verified=bool(body.get('verified')))
        elif kind == 'leave':
            if body.get('action') not in ['核給', '已休', '調整', '結清']:
                raise Problem('請選特休異動種類')
            data.update(action=body['action'], hours=number(body.get('hours'), -10000 if body['action'] == '調整' else 0, 10000), period=clean(body.get('period'), 50))
            if not data['period'] or not data['hours']:
                raise Problem('請填特休期間與非零時數')
        else:
            data.update(type=clean(body.get('type'), 100))
            if not data['type']:
                raise Problem('請填異動項目')
        data['id'] = secrets.token_hex(12)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.employee(db, employee_id)
            if kind == 'leave' and data['action'] in ['已休', '結清']:
                balance = self.balance(db, employee_id, data['period'])
                if data['hours'] > balance:
                    raise Problem('超過該期間剩餘特休時數，請先核對核給紀錄')
            db.execute('INSERT INTO records VALUES(?,?,?,?,?)', (data['id'], employee_id, kind, compact(data), now()))
            self.audit(db, actor, '新增' + {'insurance': '保險', 'leave': '特休', 'change': '人事異動'}[kind], employee_id)
        return data

    def balance(self, db, employee_id, period=None):
        total = 0
        for row in db.execute("SELECT data FROM records WHERE employee_id=? AND kind='leave'", (employee_id,)):
            data = json.loads(row['data'])
            if period is not None and data['period'] != period:
                continue
            total += data['hours'] * (-1 if data['action'] in ['已休', '結清'] else 1)
        return round(total, 4)

    def salary_insert(self, db, employee_id, body, source):
        self.employee(db, employee_id)
        month = clean(body.get('month'), 7).replace('/', '-')
        if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month):
            raise Problem('薪資月份格式錯誤')
        data = dict(body)
        data['month'], data['netPay'], data['source'] = month, number(body.get('netPay')), source
        # Digest excludes revision/status: an identical import never creates another version.
        digest = hashlib.sha256(compact(data).encode()).hexdigest()
        old = db.execute('SELECT id FROM salaries WHERE employee_id=? AND month=? AND digest=?', (employee_id, month, digest)).fetchone()
        if old:
            return old['id'], False
        version = db.execute('SELECT COALESCE(MAX(version),0)+1 FROM salaries WHERE employee_id=? AND month=?', (employee_id, month)).fetchone()[0]
        key = secrets.token_hex(12)
        db.execute('INSERT INTO salaries VALUES(?,?,?,?,?,?,?,?)', (key, employee_id, month, digest, version, '待核對', compact(data), now()))
        return key, True

    def add_salary(self, body, actor):
        employee_id = ident(body.get('employeeId'))
        data = {'month': body.get('month'), 'netPay': number(body.get('netPay')), 'workHours': number(body.get('workHours', 0)), 'notes': clean(body.get('notes'), 2000)}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            key, created = self.salary_insert(db, employee_id, data, '人工登錄')
            self.audit(db, actor, '登錄薪資版本', employee_id, key)
        return {'id': key, 'created': created}

    def finalize_salary(self, body, actor):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM salaries WHERE id=?', (clean(body.get('id'), 40),)).fetchone()
            if not row:
                raise Problem('找不到薪資紀錄', 404)
            target = body.get('status')
            expected = {'已核定': '待核對', '已付款': '已核定'}
            if target not in expected or row['status'] != expected[target]:
                raise Problem('薪資狀態已變更或不可倒退，請重新載入', 409)
            db.execute('UPDATE salaries SET status=? WHERE id=?', (target, row['id']))
            self.audit(db, actor, '薪資' + target, row['employee_id'], row['month'] + ' 版本' + str(row['version']))
        return {'success': True}

    def state(self, settings):
        with self.db() as db:
            employees = [self.employee(db, row[0]) for row in db.execute('SELECT id FROM employees ORDER BY id').fetchall()]
            records = [{'employeeId': row['employee_id'], 'kind': row['kind'], 'created': row['created'], **json.loads(row['data'])} for row in db.execute('SELECT * FROM records ORDER BY created DESC,id DESC')]
            salaries = [{'id': row['id'], 'employeeId': row['employee_id'], 'version': row['version'], 'status': row['status'], 'created': row['created'], **json.loads(row['data'])} for row in db.execute('SELECT * FROM salaries ORDER BY month DESC,employee_id,version DESC')]
            docs = [{'id': r['id'], 'category': r['category'], 'filename': r['filename'], 'available': bool(r['available']), 'employeeId': r['employee_id'], 'suggestions': json.loads(r['suggestions']), 'size': r['size']} for r in db.execute('SELECT * FROM documents ORDER BY category,filename')]
            audit = [dict(row) for row in db.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')]
            attendance = [json.loads(r[0]) for r in db.execute('SELECT data FROM attendance ORDER BY id LIMIT 20000')]
            last = db.execute("SELECT value FROM settings WHERE key='lastImport'").fetchone()
        return {'employees': employees, 'records': records, 'salaries': salaries, 'documents': docs, 'attendance': attendance, 'audit': audit, 'lastImport': json.loads(last[0]) if last else None, 'settings': settings}

    def scan(self, roots, actor):
        found, errors = [], []
        with self.db() as db:
            employees = [self.employee(db, r[0]) for r in db.execute('SELECT id FROM employees').fetchall()]
        for category, root in roots.items():
            if not root or not root.is_dir():
                errors.append(DOC_TYPES[category] + '資料夾未設定或無法讀取')
                continue
            for path in root.rglob('*'):
                if path.is_symlink() or not path.is_file() or path.suffix.lower() not in MIMES:
                    continue
                try:
                    relative = str(path.relative_to(root))
                    if not path.resolve().is_relative_to(root.resolve()):
                        continue
                    stat = path.stat()
                    stem = path.stem.replace(' ', '').replace('　', '')
                    suggestions = []
                    for emp in employees:
                        name = emp['name'].replace(' ', '').replace('　', '')
                        if stem == name or re.fullmatch(re.escape(name) + r'[_\-（(](?:正面|反面|身分證|身份證|存摺|駕照|副本|\d+)[）)]?', stem):
                            suggestions.append(emp['id'])
                    key = hashlib.sha256((category + '\0' + relative).encode()).hexdigest()
                    found.append((key, category, relative, path.name, stat.st_size, stat.st_mtime_ns, compact(suggestions)))
                    if len(found) > 10000:
                        raise Problem('文件超過10000筆，請縮小資料夾範圍')
                except (OSError, ValueError):
                    errors.append(DOC_TYPES[category] + '有文件無法讀取')
        # Never mark a whole inaccessible root missing; only roots successfully scanned.
        successful = {category for category, root in roots.items() if root and root.is_dir() and not any(err.startswith(DOC_TYPES[category]) for err in errors)}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for category in successful:
                db.execute('UPDATE documents SET available=0 WHERE category=?', (category,))
            for key, category, rel, filename, size, mtime, suggestions in found:
                db.execute('''INSERT INTO documents VALUES(?,?,?,?,?,?,1,NULL,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,size=excluded.size,mtime=excluded.mtime,available=1,suggestions=excluded.suggestions''', (key, category, rel, filename, size, mtime, suggestions))
            self.audit(db, actor, '掃描NAS文件', '', '找到' + str(len(found)) + '份，未自動綁定')
        return {'count': len(found), 'warnings': sorted(set(errors))}

    def bind_document(self, body, actor):
        with self.db() as db:
            self.employee(db, body.get('employeeId'))
            row = db.execute('SELECT * FROM documents WHERE id=?', (clean(body.get('id'), 64),)).fetchone()
            if not row or not row['available']:
                raise Problem('文件不存在，請重新掃描', 404)
            db.execute('UPDATE documents SET employee_id=? WHERE id=?', (ident(body['employeeId']), row['id']))
            self.audit(db, actor, '確認文件配對', ident(body['employeeId']), row['category'] + ' ' + row['filename'])
        return {'success': True}

    def document(self, document_id, roots, actor):
        with self.db() as db:
            row = db.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
            if not row or not row['available'] or not row['employee_id']:
                raise Problem('文件尚未確認配對或已不存在', 404)
            root = roots.get(row['category'])
            if not root:
                raise Problem('NAS資料夾未設定', 503)
            path = root / row['relative_path']
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or path.suffix.lower() not in MIMES:
                raise Problem('文件路徑不允許', 403)
            try:
                file = os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb')
            except OSError:
                raise Problem('文件無法開啟，請確認NAS權限或重新掃描', 404)
            self.audit(db, actor, '預覽文件', row['employee_id'], row['category'])
        return file, MIMES[path.suffix.lower()]

    def import_payload(self, payload, actor):
        if not isinstance(payload, dict) or payload.get('schema') != 1:
            raise Problem('打卡匯出格式錯誤，未匯入')
        employees, salaries, attendance = payload.get('employees', []), payload.get('salaries', []), payload.get('attendance', [])
        if not all(isinstance(v, list) for v in [employees, salaries, attendance]) or len(employees) > 5000 or len(attendance) > 100000:
            raise Problem('匯入格式或筆數超出限制')
        count, warnings, seen = {'employees': 0, 'salaries': 0, 'attendance': 0}, [], set()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for emp in employees:
                eid = ident(emp.get('id'))
                if eid in seen:
                    raise Problem('來源員工編號重複：' + eid + '，未匯入')
                seen.add(eid)
                old = db.execute('SELECT data FROM employees WHERE id=?', (eid,)).fetchone()
                data = json.loads(old[0]) if old else {field: '' for field in EMP_FIELDS}
                for field in ['name', 'department', 'employmentType', 'arrivalDate', 'departureDate', 'lineBound']:
                    data[field] = clean(emp.get(field, ''), 200)
                if not data['name']:
                    raise Problem('來源員工缺姓名：' + eid)
                for field in ['arrivalDate', 'departureDate']:
                    data[field] = valid_date(data[field])
                db.execute('INSERT INTO employees VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=employees.revision+1', (eid, compact(data)))
                count['employees'] += 1
            for salary in salaries:
                eid = ident(salary.get('employeeId'))
                if not db.execute('SELECT 1 FROM employees WHERE id=?', (eid,)).fetchone():
                    warnings.append('薪資找不到員工：' + eid)
                    continue
                _, created = self.salary_insert(db, eid, salary, '打卡試算表')
                count['salaries'] += int(created)
            window = payload.get('attendanceWindow')
            if window:
                window_start, window_end = valid_date(window.get('start'), False), valid_date(window.get('end'), False)
                if window_start > window_end:
                    raise Problem('打卡同步日期範圍錯誤')
                # Replace only this explicit source window, so source edits/deletions do not
                # leave obsolete clock-in copies. Prior months remain unchanged.
                db.execute("DELETE FROM attendance WHERE json_extract(data,'$.date')>=? AND json_extract(data,'$.date')<=?", (window_start, window_end))
            for item in attendance:
                eid = ident(item.get('employeeId'))
                if not db.execute('SELECT 1 FROM employees WHERE id=?', (eid,)).fetchone():
                    continue
                if item.get('type') not in ['上班', '下班']:
                    continue
                day = valid_date(item.get('date'), False)
                if window and not window_start <= day <= window_end:
                    raise Problem('打卡紀錄超出匯入範圍，未匯入')
                time = clean(item.get('time'), 8)
                try:
                    datetime.strptime(time, '%H:%M:%S')
                except ValueError:
                    warnings.append(eid + ' ' + day + '有無效時間，該筆未匯入')
                    continue
                data = {'employeeId': eid, 'date': day, 'time': time, 'type': item['type'], 'status': clean(item.get('status'), 100), 'notes': clean(item.get('notes'), 2000)}
                key = hashlib.sha256(compact(data).encode()).hexdigest()
                count['attendance'] += db.execute('INSERT OR IGNORE INTO attendance VALUES(?,?,?)', (key, eid, compact(data))).rowcount
            summary = {'time': now(), 'counts': count, 'warnings': warnings[:100]}
            db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('lastImport', compact(summary)))
            self.audit(db, actor, '匯入打卡資料', '', compact(count))
        return summary


class GoogleRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urlsplit(newurl)
        if parts.scheme != 'https' or parts.hostname not in ['script.google.com', 'script.googleusercontent.com']:
            raise Problem('打卡來源重新導向不允許')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_source(url, secret):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'script.google.com' or not re.fullmatch(r'/macros/s/[A-Za-z0-9_-]+/exec', parsed.path) or parsed.query:
        raise Problem('請在NAS設定正確的Apps Script /exec網址')
    if len(secret) < 32:
        raise Problem('尚未設定打卡匯出密鑰')
    stamp = int(datetime.now(timezone.utc).timestamp())
    nonce = secrets.token_hex(16)
    signature = hmac.new(secret.encode(), f'{stamp}|{nonce}'.encode(), hashlib.sha256).hexdigest()
    body = compact({'action': 'hr_export', 'timestamp': stamp, 'nonce': nonce, 'signature': signature}).encode()
    try:
        with build_opener(GoogleRedirect()).open(Request(url, body, {'Content-Type': 'text/plain;charset=utf-8'}), timeout=40) as response:
            raw = response.read(20 * 1024 * 1024 + 1)
            if len(raw) > 20 * 1024 * 1024:
                raise Problem('打卡匯出超過20MB，請縮小來源範圍')
            result = json.loads(raw)
    except Problem:
        raise
    except Exception:
        raise Problem('打卡來源連線失敗；請核對NAS設定及Apps Script部署', 502)
    if result.get('success') is not True:
        raise Problem('打卡來源未授權或匯出失敗；原資料未變更', 502)
    return result['data']


class App:
    def __init__(self, data_dir=None, allowed_cidrs=None, hosts=None, roots=None):
        self.store = Store(Path(data_dir or os.environ.get('HR_DATA_DIR', HERE / 'data')) / 'hr.sqlite3')
        cidrs = allowed_cidrs or os.environ.get('HR_ALLOWED_CIDRS', '127.0.0.1/32').split(',')
        self.networks = [ipaddress.ip_network(n.strip()) for n in cidrs]
        if any(n.prefixlen == 0 or not n.network_address.is_private or n.network_address in ipaddress.ip_network('100.64.0.0/10') for n in self.networks):
            raise RuntimeError('HR_ALLOWED_CIDRS僅能填公司私人網段，不可允許所有位址或Tailscale網段')
        self.hosts = set(hosts or os.environ.get('HR_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(','))
        self.blocked_ips = set(filter(None, os.environ.get('HR_BLOCKED_SOURCE_IPS', '').split(',')))
        self.roots = roots or {cat: Path(os.environ['HR_' + cat.upper() + '_DIR']).resolve() if os.environ.get('HR_' + cat.upper() + '_DIR') else None for cat in DOC_TYPES}
        self.source_url = os.environ.get('HR_GAS_URL', '')
        self.source_secret = os.environ.get('HR_GAS_SECRET', '')

    def security(self, env, method):
        try:
            ip = ipaddress.ip_address(env.get('REMOTE_ADDR', ''))
        except ValueError:
            raise Problem('來源網路不允許', 403)
        if not any(ip in network for network in self.networks):
            raise Problem('此人資系統僅供公司指定網路使用', 403)
        if str(ip) in self.blocked_ips:
            raise Problem('不接受NAS本機代理或VPN轉送存取', 403)
        # Do not trust forwarded headers: a Tailscale or public proxy must not appear as office LAN.
        if any(env.get(key) for key in ['HTTP_X_FORWARDED_FOR', 'HTTP_FORWARDED', 'HTTP_X_REAL_IP']):
            raise Problem('本服務不接受代理轉送，請從公司內網直接開啟', 403)
        host = urlsplit('//' + env.get('HTTP_HOST', '')).hostname
        if host not in self.hosts:
            raise Problem('人資系統網址不允許', 403)
        origin = env.get('HTTP_ORIGIN')
        expected = env.get('wsgi.url_scheme', 'http') + '://' + env.get('HTTP_HOST', '')
        if origin and origin != expected:
            raise Problem('來源網頁不允許', 403)
        if method not in ['GET', 'HEAD']:
            cookies = SimpleCookie()
            try:
                cookies.load(env.get('HTTP_COOKIE', ''))
            except Exception:
                raise Problem('請重新載入人資頁面', 403)
            token = env.get('HTTP_X_HR_CSRF', '')
            cookie = cookies.get('hr_csrf')
            if not cookie or not re.fullmatch(r'[a-f0-9]{64}', token) or not hmac.compare_digest(cookie.value, token):
                raise Problem('請從人資頁面操作，或重新載入後重試', 403)
        return str(ip)

    def body(self, env):
        try:
            length = int(env.get('CONTENT_LENGTH') or 0)
            if not 0 < length <= 20 * 1024 * 1024:
                raise Problem('請求資料大小不允許', 413)
            data = json.loads(env['wsgi.input'].read(length))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except Problem:
            raise
        except Exception:
            raise Problem('請求格式錯誤')

    def __call__(self, env, start_response):
        try:
            method, path = env.get('REQUEST_METHOD', 'GET'), env.get('PATH_INFO', '/')
            actor = self.security(env, method)
            if method == 'GET' and path == '/api/ping':
                return self.response(start_response, {'time': now()})
            if method == 'GET' and path == '/api/state':
                csrf = secrets.token_hex(32)
                settings = {'documentRoots': {key: bool(value and value.is_dir()) for key, value in self.roots.items()}, 'gasConfigured': bool(self.source_url and len(self.source_secret) >= 32), 'networkMode': '公司內網限定'}
                result = self.store.state(settings)
                result['csrf'] = csrf
                return self.response(start_response, result, headers=[('Set-Cookie', 'hr_csrf=' + csrf + '; HttpOnly; SameSite=Strict; Path=/' + ('; Secure' if env.get('wsgi.url_scheme') == 'https' else ''))])
            if method == 'GET' and path == '/api/document':
                params = parse_qs(env.get('QUERY_STRING', ''))
                key = params.get('id', [''])[0]
                if not re.fullmatch(r'[a-f0-9]{64}', key):
                    raise Problem('文件識別碼錯誤', 404)
                file, mime = self.store.document(key, self.roots, actor)
                size = os.fstat(file.fileno()).st_size
                headers = [('Content-Type', mime), ('Content-Length', str(size)), ('Accept-Ranges', 'bytes'), ('Content-Disposition', 'inline'), ('Content-Security-Policy', "sandbox; default-src 'none'")]
                start, end, status = 0, size - 1, 200
                if env.get('HTTP_RANGE'):
                    match = re.fullmatch(r'bytes=(\d*)-(\d*)', env['HTTP_RANGE'])
                    if not match or not any(match.groups()):
                        file.close()
                        raise Problem('文件範圍錯誤', 416)
                    if match[1]:
                        start, end = int(match[1]), min(int(match[2]) if match[2] else size - 1, size - 1)
                    else:
                        start = max(0, size - int(match[2]))
                    if start > end or start >= size:
                        file.close()
                        raise Problem('文件範圍錯誤', 416)
                    headers[1] = ('Content-Length', str(end - start + 1))
                    headers.append(('Content-Range', f'bytes {start}-{end}/{size}'))
                    status = 206
                self.start(start_response, status, headers)
                file.seek(start)
                def stream():
                    try:
                        remaining = end - start + 1
                        while remaining > 0:
                            block = file.read(min(65536, remaining))
                            if not block:
                                break
                            remaining -= len(block)
                            yield block
                    finally:
                        file.close()
                return stream()
            if method == 'GET' and path in ['/', '/app.js', '/styles.css']:
                name = {'/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css'}[path]
                mime = {'/': 'text/html', '/app.js': 'text/javascript', '/styles.css': 'text/css'}[path]
                return self.response(start_response, (HERE / 'public' / name).read_bytes(), mime=mime + '; charset=utf-8')
            if method == 'POST':
                body = self.body(env)
                routes = {
                    '/api/employee': lambda: self.store.save_employee(body, actor),
                    '/api/record': lambda: self.store.add_record(body, actor),
                    '/api/salary': lambda: self.store.add_salary(body, actor),
                    '/api/salary/status': lambda: self.store.finalize_salary(body, actor),
                    '/api/documents/scan': lambda: self.store.scan(self.roots, actor),
                    '/api/documents/bind': lambda: self.store.bind_document(body, actor),
                    '/api/import': lambda: self.store.import_payload(body, actor),
                    '/api/sync': lambda: self.store.import_payload(fetch_source(self.source_url, self.source_secret), actor),
                }
                if path in routes:
                    return self.response(start_response, routes[path]())
            raise Problem('找不到此功能', 404)
        except Problem as exc:
            return self.response(start_response, {'error': exc.message}, status=exc.status)
        except Exception:
            # Do not leak filesystem paths, credential material or database contents to browser/logs.
            return self.response(start_response, {'error': '儲存或讀取失敗，請稍後重試並確認NAS資料夾權限'}, status=500)

    def start(self, callback, status, headers):
        phrases = {200: 'OK', 206: 'Partial Content', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 416: 'Range Not Satisfiable', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'}
        defaults = [('Cache-Control', 'no-store, private'), ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'), ('X-Frame-Options', 'SAMEORIGIN')]
        if not any(key == 'Content-Security-Policy' for key, _ in headers):
            defaults.append(('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"))
        callback(str(status) + ' ' + phrases.get(status, 'Error'), headers + defaults)

    def response(self, callback, data, status=200, mime='application/json; charset=utf-8', headers=None):
        raw = data if isinstance(data, bytes) else compact(data).encode()
        self.start(callback, status, [('Content-Type', mime), ('Content-Length', str(len(raw)))] + (headers or []))
        return [raw]


_app = None


def application(env, start_response):
    global _app
    if _app is None:
        _app = App()
    return _app(env, start_response)


if __name__ == '__main__':
    # Local development only; Docker uses Gunicorn, never this server.
    from wsgiref.simple_server import make_server
    port = int(os.environ.get('PORT', 8090))
    print(f'本機測試：http://127.0.0.1:{port}')
    make_server('127.0.0.1', port, application).serve_forever()
