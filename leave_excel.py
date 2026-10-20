"""Read leave settlement workbooks as historical evidence, never as live grants."""
import io
import re
import zipfile
from datetime import date, datetime


def text(value):
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (date, datetime)):
        return value.strftime('%Y-%m-%d')
    return str(value).strip()[:4000]


def day(value):
    if isinstance(value, (date, datetime)):
        return value.strftime('%Y-%m-%d')
    s = text(value)
    m = re.fullmatch(r'(\d{3,4})[-/年](\d{1,2})[-/月](\d{1,2})日?', s)
    if not m and re.fullmatch(r'\d{7,8}', s):
        m = re.fullmatch(r'(\d{3,4})(\d{2})(\d{2})', s)
    if not m:
        return ''
    y, month, d = map(int, m.groups())
    try:
        return date(y + 1911 if y < 1911 else y, month, d).isoformat()
    except ValueError:
        return ''


def amount(value):
    # A small addition expression such as 7+3 is common. Never evaluate code.
    s = text(value).replace('＋', '+').replace(' ', '')
    if re.fullmatch(r'\d+(?:\.\d+)?(?:\+\d+(?:\.\d+)?)*', s):
        return round(sum(float(n) for n in s.split('+')), 3)
    return None


def read_excel(raw, filename):
    if raw.startswith(b'PK'):
        import openpyxl
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            if sum(i.file_size for i in z.infolist()) > 60 * 1024 * 1024:
                raise ValueError('Excel展開後過大')
        book = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        sheets = [(s.title, list(s.iter_rows(values_only=True))) for s in book]
        book.close()
    else:
        import xlrd
        book = xlrd.open_workbook(file_contents=raw)
        sheets = []
        for sh in book.sheets():
            rows = []
            for i in range(sh.nrows):
                rows.append([xlrd.xldate.xldate_as_datetime(c.value, book.datemode) if c.ctype == xlrd.XL_CELL_DATE else c.value for c in sh.row(i)])
            sheets.append((sh.name, rows))
        book.release_resources()
    records = []
    for title, rows in sheets:
        header_at = next((i for i, row in enumerate(rows[:20]) if any(text(c) in ['姓名', '員工'] for c in row) and any(text(c) in ['到職日', '入職日', '到職日期'] for c in row)), None)
        if header_at is None:
            continue
        headers = [text(c) for c in rows[header_at]]
        def column(label):
            return headers.index(label) if label in headers else None
        name_col = next(i for i, h in enumerate(headers) if h in ['姓名', '員工'])
        arrival_col = next(i for i, h in enumerate(headers) if h in ['到職日', '入職日', '到職日期'])
        days_col = column('天數')
        used_col = next((i for i, h in enumerate(headers) if h in ['已休', '已休天數'] or h.endswith('年已休')), None)
        settle_cols = [i for i, h in enumerate(headers) if '結算' in h and '月份' not in h and h not in ['結算給付']]
        for row_num, row in enumerate(rows[header_at + 1:], header_at + 2):
            row = list(row) + [''] * max(0, len(headers) - len(row))
            name = text(row[name_col])
            if not name or name in ['姓名', '合計', '總計']:
                continue
            arrival = day(row[arrival_col])
            # Notes and footer rows do not represent employees.
            if not arrival and not re.fullmatch(r'[\w\u3400-\u9fff·．・\s-]{2,30}', name):
                continue
            warnings = []
            if not arrival:
                warnings.append('到職日無法辨識，保留原文')
            settlements = [{'label': headers[i], 'date': day(row[i]), 'raw': text(row[i])} for i in settle_cols]
            for item in settlements:
                label_year = re.search(r'(\d{3,4})年', item['label'])
                if label_year and item['date']:
                    y = int(label_year[1]); y += 1911 if y < 1911 else 0
                    if not item['date'].startswith(str(y)):
                        warnings.append(item['label'] + '與儲存格年份不同，需核對')
            days_raw = text(row[days_col]) if days_col is not None else ''
            used_raw = text(row[used_col]) if used_col is not None else ''
            if days_raw and amount(days_raw) is None:
                warnings.append('天數含文字，需核對')
            if used_raw and amount(used_raw) is None:
                warnings.append('已休含文字，需核對')
            records.append({'name': name, 'arrivalDate': arrival, 'arrivalRaw': text(row[arrival_col]), 'days': amount(days_raw), 'daysRaw': days_raw, 'usedDays': amount(used_raw), 'usedRaw': used_raw, 'settlements': settlements, 'cells': [{'label': h or '第%d欄' % (i + 1), 'value': text(v)} for i, (h, v) in enumerate(zip(headers, row)) if text(v)], 'sourceFile': filename, 'sourceSheet': title, 'sourceRow': row_num, 'warnings': warnings})
            if len(records) > 10000:
                raise ValueError('特休匯入最多10000列')
    if not records:
        raise ValueError('找不到包含姓名、到職日的特休分頁')
    return {'records': records}
