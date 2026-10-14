import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import App, Problem


class HRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.roots = {k: self.root / k for k in ['identity', 'bank', 'license']}
        for folder in self.roots.values():
            folder.mkdir()
        with patch.dict(os.environ, {'HR_BLOCKED_SOURCE_IPS': '192.168.1.20'}):
            self.app = App(self.root / 'data', ['192.168.1.0/24'], ['192.168.1.20'], self.roots)
        self.csrf = None
        self.cookie = ''
        self.call('/api/state')

    def tearDown(self):
        self.temp.cleanup()

    def call(self, path, data=None, ip='192.168.1.50', headers=None):
        path, _, query = path.partition('?')
        raw = json.dumps(data).encode() if data is not None else b''
        env = {'REQUEST_METHOD': 'POST' if data is not None else 'GET', 'PATH_INFO': path, 'QUERY_STRING': query, 'REMOTE_ADDR': ip, 'HTTP_HOST': '192.168.1.20:8090', 'wsgi.url_scheme': 'http', 'wsgi.input': io.BytesIO(raw), 'CONTENT_LENGTH': str(len(raw)), 'HTTP_COOKIE': self.cookie, 'HTTP_X_HR_CSRF': self.csrf or ''}
        env.update(headers or {})
        result = {}
        def start(status, response_headers):
            result['status'], result['headers'] = int(status.split()[0]), dict(response_headers)
        payload = b''.join(self.app(env, start))
        if result['headers']['Content-Type'].startswith('application/json'):
            result['data'] = json.loads(payload)
        else:
            result['data'] = payload
        if 'Set-Cookie' in result['headers']:
            self.cookie = result['headers']['Set-Cookie'].split(';')[0]
            self.csrf = result['data']['csrf']
        return result

    def emp(self, eid='F001', name='王小明', **extra):
        payload = {'id': eid, 'name': name, 'department': '摺疊', 'arrivalDate': '2024-04-01', **extra}
        result = self.call('/api/employee', payload)
        self.assertEqual(result['status'], 200, result)
        return result['data']

    def test_network_boundary_host_origin_proxy_csrf(self):
        for ip in ['8.8.8.8', '100.90.1.2', '192.168.2.50', '192.168.1.20', '127.0.0.1']:
            self.assertEqual(self.call('/api/state', ip=ip)['status'], 403)
        for headers in [{'HTTP_HOST': 'evil.test'}, {'HTTP_X_FORWARDED_FOR': '192.168.1.50'}, {'HTTP_FORWARDED': 'for=192.168.1.50'}, {'HTTP_ORIGIN': 'https://evil.test'}, {'HTTP_X_REAL_IP': '192.168.1.50'}]:
            self.assertEqual(self.call('/api/state', headers=headers)['status'], 403)
        self.assertEqual(self.call('/api/employee', {'id': 'F001', 'name': '王小明'}, headers={'HTTP_X_HR_CSRF': ''})['status'], 403)
        result = self.call('/')
        self.assertEqual(result['status'], 200)
        self.assertIn('no-store', result['headers']['Cache-Control'])
        self.assertIn("script-src 'self'", result['headers']['Content-Security-Policy'])
        self.assertEqual(self.call('/.env')['status'], 404)
        self.assertEqual(self.call('/server.py')['status'], 404)

    def test_employee_persistence_revision_and_dates(self):
        emp = self.emp(notes='<img src=x onerror=alert(1)>', paperLocation='A櫃／第二層')
        self.assertEqual(self.call('/api/employee', {'id': 'F001', 'name': '變更'})['status'], 409)
        emp['name'] = '王大明'
        self.assertEqual(self.call('/api/employee', emp)['status'], 200)
        self.assertEqual(self.call('/api/employee', emp)['status'], 409)
        self.assertEqual(self.call('/api/employee', {'id': 'BAD', 'name': '測試', 'arrivalDate': '2026-02-30'})['status'], 400)
        again = App(self.root / 'data', ['192.168.1.0/24'], ['192.168.1.20'], self.roots)
        self.assertEqual(again.store.state({})['employees'][0]['name'], '王大明')
        self.assertEqual(again.store.state({})['employees'][0]['paperLocation'], 'A櫃／第二層')

    def test_insurance_distinct_dates_and_leave_balance_atomicity(self):
        self.emp()
        for kind, day in [('勞保', '2024-04-01'), ('健保', '2024-04-02')]:
            result = self.call('/api/record', {'employeeId': 'F001', 'kind': 'insurance', 'date': day, 'type': kind, 'action': '加保', 'amount': 30000, 'verified': True})
            self.assertEqual(result['status'], 200)
        base = {'employeeId': 'F001', 'kind': 'leave', 'date': '2026-10-14', 'period': '2026週年'}
        self.assertEqual(self.call('/api/record', {**base, 'action': '核給', 'hours': 80})['status'], 200)
        self.assertEqual(self.call('/api/record', {**base, 'action': '已休', 'hours': 4})['status'], 200)
        self.assertEqual(self.call('/api/record', {**base, 'action': '已休', 'hours': 77})['status'], 400)
        with self.app.store.db() as db:
            self.assertEqual(self.app.store.balance(db, 'F001', '2026週年'), 76)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM records WHERE kind='leave'").fetchone()[0], 2)
        self.assertEqual(self.call('/api/record', {**base, 'period': '另一期間', 'action': '已休', 'hours': 4})['status'], 400)

    def test_salary_versions_idempotency_and_locked_history(self):
        self.emp()
        body = {'employeeId': 'F001', 'month': '2026-09', 'netPay': 30000, 'workHours': 176}
        first = self.call('/api/salary', body)['data']
        repeat = self.call('/api/salary', body)['data']
        self.assertEqual(first['id'], repeat['id'])
        self.assertFalse(repeat['created'])
        self.assertEqual(self.call('/api/salary/status', {'id': first['id'], 'status': '已付款'})['status'], 409)
        self.assertEqual(self.call('/api/salary/status', {'id': first['id'], 'status': '已核定'})['status'], 200)
        self.assertEqual(self.call('/api/salary/status', {'id': first['id'], 'status': '已付款'})['status'], 200)
        self.assertEqual(self.call('/api/salary/status', {'id': first['id'], 'status': '已核定'})['status'], 409)
        self.call('/api/salary', {**body, 'netPay': 31000})
        salaries = self.call('/api/state')['data']['salaries']
        self.assertEqual(len(salaries), 2)
        self.assertEqual([s for s in salaries if s['id'] == first['id']][0]['netPay'], 30000)
        self.assertEqual([s for s in salaries if s['id'] == first['id']][0]['status'], '已付款')

    def test_documents_ambiguity_confirmation_readonly_range_and_escape(self):
        self.emp()
        self.emp('F002', '王小明')
        raw = b'%PDF-1.4\nmock test document\n'
        (self.roots['bank'] / '王小明.pdf').write_bytes(raw)
        outside = self.root / 'secret.pdf'
        outside.write_bytes(b'secret')
        (self.roots['bank'] / '偷看.pdf').symlink_to(outside)
        self.assertEqual(self.call('/api/documents/scan', {})['data']['count'], 1)
        docs = self.call('/api/state')['data']['documents']
        self.assertEqual(len(docs), 1)
        self.assertEqual(set(docs[0]['suggestions']), {'F001', 'F002'})
        self.assertIsNone(docs[0]['employeeId'])
        key = docs[0]['id']
        self.assertEqual(self.call('/api/document?id=' + key)['status'], 404)
        self.assertEqual(self.call('/api/documents/bind', {'id': key, 'employeeId': 'F001'})['status'], 200)
        result = self.call('/api/document?id=' + key)
        self.assertEqual(result['data'], raw)
        self.assertEqual(result['headers']['Content-Disposition'], 'inline')
        part = self.call('/api/document?id=' + key, headers={'HTTP_RANGE': 'bytes=0-4'})
        self.assertEqual(part['status'], 206)
        self.assertEqual(part['data'], b'%PDF-')
        self.assertEqual(self.call('/api/document?id=' + key, headers={'HTTP_RANGE': 'bytes=999-1000'})['status'], 416)
        self.assertEqual((self.roots['bank'] / '王小明.pdf').read_bytes(), raw)
        self.call('/api/documents/scan', {})
        self.assertEqual(self.call('/api/state')['data']['documents'][0]['employeeId'], 'F001')
        (self.roots['bank'] / '王小明.pdf').unlink()
        (self.roots['bank'] / '王小明.pdf').symlink_to(outside)
        self.assertEqual(self.call('/api/document?id=' + key)['status'], 403)

    def test_source_import_atomic_idempotent_preserves_local_fields_and_snapshot_correction(self):
        self.emp(notes='人資備註', phone='0912345678')
        payload = {'schema': 1, 'employees': [{'id': 'F001', 'name': '王小明', 'department': '物流', 'arrivalDate': '2024-04-01'}], 'salaries': [{'employeeId': 'F001', 'month': '2026-09', 'netPay': 30000}], 'attendance': [{'employeeId': 'F001', 'date': '2026-10-14', 'time': '08:00:00', 'type': '上班', 'status': ''}], 'attendanceWindow': {'start': '2026-10-01', 'end': '2026-10-14'}}
        self.assertEqual(self.call('/api/import', payload)['status'], 200)
        self.assertEqual(self.call('/api/import', payload)['data']['counts']['salaries'], 0)
        data = self.call('/api/state')['data']
        self.assertEqual(data['employees'][0]['phone'], '0912345678')
        self.assertEqual(data['employees'][0]['notes'], '人資備註')
        self.assertEqual(len(data['attendance']), 1)
        payload['attendance'][0]['time'] = '08:10:00'
        self.call('/api/import', payload)
        self.assertEqual(len(self.call('/api/state')['data']['attendance']), 1)
        payload['employees'].append(payload['employees'][0])
        payload['employees'][0]['department'] = '錯誤部門'
        self.assertEqual(self.call('/api/import', payload)['status'], 400)
        self.assertEqual(self.call('/api/state')['data']['employees'][0]['department'], '物流')


if __name__ == '__main__':
    unittest.main()
