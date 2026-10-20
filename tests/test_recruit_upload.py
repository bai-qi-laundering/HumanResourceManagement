import io
import json
import sqlite3
from unittest.mock import patch
from urllib.parse import urlencode

import unittest
import test_server
from server import UPLOAD_LIMIT


class RecruitmentUploadTests(unittest.TestCase):
    setUp = test_server.HRTests.setUp
    tearDown = test_server.HRTests.tearDown
    call = test_server.HRTests.call
    emp = test_server.HRTests.emp
    def upload(self, raw=b'%PDF-1.4\nnew document', name='test.pdf', category='bank', eid='F001', **extra):
        env = {'REQUEST_METHOD': 'POST', 'PATH_INFO': '/api/documents/upload',
               'QUERY_STRING': urlencode({'employeeId': eid, 'category': category, 'filename': name}),
               'REMOTE_ADDR': '192.168.1.50', 'HTTP_HOST': '192.168.1.20:8090',
               'wsgi.url_scheme': 'http', 'wsgi.input': io.BytesIO(raw),
               'CONTENT_LENGTH': str(len(raw)), 'HTTP_COOKIE': self.cookie, 'HTTP_X_HR_CSRF': self.csrf}
        env.update(extra)
        result = {}
        def start(status, headers):
            result['status'] = int(status.split()[0])
        result['data'] = json.loads(b''.join(self.app(env, start)))
        return result

    def new_candidate(self, **extra):
        result = self.call('/api/recruitment/candidate', {'name': '測試應徵者', 'phone': '0912345678', 'department': '洗滌', 'job': '洗滌人員', 'followupDate': '2026-10-20', **extra})
        self.assertEqual(result['status'], 200, result)
        return result['data']

    def test_upload_versions_autobind_and_scan(self):
        self.emp()
        first, second = self.upload(name='../../fake.pdf'), self.upload()
        self.assertEqual(first['status'], 200, first)
        self.assertEqual(second['status'], 200)
        self.assertNotEqual(first['data']['filename'], second['data']['filename'])
        self.assertTrue(first['data']['filename'].startswith('F001_王小明_存摺_'))
        self.assertEqual(len(list(self.roots['bank'].iterdir())), 2)
        key = first['data']['id']
        self.assertEqual(self.call('/api/document?id=' + key)['data'], b'%PDF-1.4\nnew document')
        self.call('/api/documents/scan', {})
        docs = self.call('/api/state')['data']['documents']
        self.assertTrue(all(d['employeeId'] == 'F001' for d in docs))
        # No duplicate identity/license rows when the two mounts share a folder.
        self.app.roots['license'] = self.roots['identity']
        self.assertEqual(self.upload(category='identity')['status'], 200)
        scan = self.call('/api/documents/scan', {})
        self.assertEqual(scan['data']['count'], 3)
        self.assertEqual(len(self.call('/api/state')['data']['documents']), 3)

    def test_upload_validation_permissions_csrf_and_cleanup(self):
        self.emp()
        self.assertEqual(self.upload(raw=b'<svg/>', name='x.svg')['status'], 400)
        self.assertEqual(self.upload(raw=b'<html>evil', name='x.jpg')['status'], 400)
        self.assertEqual(self.upload(eid='MISSING')['status'], 404)
        self.assertEqual(self.upload(raw=b'')['status'], 413)
        self.assertEqual(self.upload(CONTENT_LENGTH=str(UPLOAD_LIMIT+1))['status'], 413)
        self.assertEqual(self.upload(HTTP_X_HR_CSRF='')['status'], 403)
        self.assertEqual(self.upload(REMOTE_ADDR='100.64.1.2')['status'], 403)
        self.assertEqual(self.upload(CONTENT_LENGTH='999')['status'], 400)
        self.assertEqual(list(self.roots['bank'].iterdir()), [])
        with patch.object(self.app.store, 'audit', side_effect=sqlite3.OperationalError('write failed')):
            self.assertEqual(self.upload()['status'], 500)
        self.assertEqual(list(self.roots['bank'].iterdir()), [])
        with self.app.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM documents').fetchone()[0], 0)
        with patch('server.os.open', side_effect=PermissionError()):
            self.assertEqual(self.upload()['status'], 503)
        # Supported photo content is accepted without trusting browser MIME.
        self.assertEqual(self.upload(raw=b'\xff\xd8\xffphoto', name='camera.jpg')['status'], 200)

    def test_candidate_contact_interview_persistence_and_conflicts(self):
        c = self.new_candidate()
        phone = {'candidateId': c['id'], 'revision': c['revision'], 'kind': 'phone', 'at': '2026-10-20T09:00', 'contactPerson': 'NANA', 'outcome': '約定面試', 'notes': '確認職缺及上班時段', 'nextFollowup': '2026-10-21', 'nextInterviewAt': '2026-10-21T10:00', 'status': '待面試'}
        self.assertEqual(self.call('/api/recruitment/event', phone)['status'], 200)
        self.assertEqual(self.call('/api/recruitment/event', phone)['status'], 409)
        state = self.call('/api/state')['data']
        c = state['candidates'][0]
        self.assertEqual(c['interviewAt'], '2026-10-21T10:00')
        self.assertEqual(c['followupDate'], '2026-10-21')
        self.assertEqual(c['status'], '待面試')
        interview = {**phone, 'revision': c['revision'], 'kind': 'interview', 'at': '2026-10-21T10:00', 'outcome': '錄取', 'nextInterviewAt': '', 'status': '待報到'}
        self.assertEqual(self.call('/api/recruitment/event', interview)['status'], 200)
        state = self.call('/api/state')['data']
        self.assertEqual(len(state['recruitmentEvents']), 2)
        self.assertEqual(state['recruitmentEvents'][1]['notes'], '確認職缺及上班時段')
        c = state['candidates'][0]
        self.assertEqual(c['interviewAt'], '')
        self.assertEqual(c['status'], '待報到')
        self.assertEqual(self.call('/api/recruitment/candidate', {**c, 'notes': '更改基本資料'})['status'], 200)
        self.assertEqual(self.call('/api/recruitment/candidate', c)['status'], 409)
        self.assertEqual(len(self.app.store.state({})['recruitmentEvents']), 2)

    def test_recruitment_validation_and_conversion_atomicity(self):
        self.assertEqual(self.call('/api/recruitment/candidate', {'name': '缺電話'})['status'], 400)
        self.assertEqual(self.call('/api/recruitment/candidate', {'name': '甲', 'phone': '123', 'interviewAt': 'bad'})['status'], 400)
        c = self.new_candidate()
        self.emp()
        body = {'candidateId': c['id'], 'revision': c['revision'], 'employeeId': 'F001', 'arrivalDate': '2026-10-22', 'employmentType': '正職'}
        self.assertEqual(self.call('/api/recruitment/convert', body)['status'], 409)
        self.assertEqual(self.call('/api/state')['data']['candidates'][0]['status'], '待聯絡')
        body['employeeId'] = 'F999'
        self.assertEqual(self.call('/api/recruitment/convert', body)['status'], 200)
        state = self.call('/api/state')['data']
        emp = next(e for e in state['employees'] if e['id'] == 'F999')
        self.assertEqual(emp['phone'], c['phone'])
        self.assertEqual(emp['arrivalDate'], '2026-10-22')
        self.assertEqual(state['candidates'][0]['status'], '已報到')
        self.assertEqual(state['candidates'][0]['employeeId'], 'F999')
        self.assertEqual(self.call('/api/recruitment/convert', body)['status'], 409)
