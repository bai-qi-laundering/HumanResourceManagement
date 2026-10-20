"""Read recruitment Excel files without executing formulas or inventing contact dates."""
from datetime import date, datetime, time
from io import BytesIO
import re
import zipfile

ALIASES = {'name': ['姓名', '應徵者姓名'], 'phone': ['電話', '電話號碼', '聯絡電話', '手機'], 'job': ['職務', '職位', '應徵職缺'], 'gender': ['性別'], 'age': ['年紀', '年齡'], 'interviewAt': ['面試時間', '預約面試時間'], 'notes': ['備註', '說明'], 'source': ['人力網', '來源'], 'callTime': ['撥打時間', '聯絡時間'], 'again': ['再次撥打'], 'date': ['日期', '聯絡日期']}


def text(value):
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def parse_day(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raw = text(value)
    try:
        if re.fullmatch(r'\d{7}', raw):
            return date(int(raw[:3]) + 1911, int(raw[3:5]), int(raw[5:])).isoformat()
        m = re.fullmatch(r'(\d{3,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?', raw)
        if m:
            year = int(m[1]) + (1911 if len(m[1]) == 3 else 0)
            return date(year, int(m[2]), int(m[3])).isoformat()
        return date.fromisoformat(raw[:10]).isoformat()
    except (ValueError, TypeError):
        return ''


def clock(value):
    if isinstance(value, (datetime, time)):
        return value.strftime('%H:%M')
    raw = text(value)
    match = re.fullmatch(r'(\d{1,2}):(\d{2})(?::\d{2})?', raw)
    if match and int(match[1]) < 24 and int(match[2]) < 60:
        return f'{int(match[1]):02}:{int(match[2]):02}'
    return ''


def period(title, context_year):
    m = re.search(r'(\d{3,4})年', title)
    year = int(m[1]) + (1911 if len(m[1]) == 3 else 0) if m else context_year
    if year is None:
        return '', '', year
    month, dates = None, []
    for token in re.finditer(r'(\d{1,2})(月|日)', title):
        n = int(token[1])
        if token[2] == '月':
            if month == 12 and n == 1:
                year += 1
            month = n
        elif month:
            try:
                dates.append(date(year, month, n).isoformat())
            except ValueError:
                pass
    return (min(dates), max(dates), year) if dates else ('', '', year)


def read_excel(raw, filename, start, end):
    if filename.lower().endswith('.xlsx'):
        import openpyxl
        with zipfile.ZipFile(BytesIO(raw)) as archive:
            if sum(i.file_size for i in archive.infolist()) > 60 * 1024 * 1024:
                raise ValueError('Excel解壓後超過60MB，請縮小資料範圍')
        book = openpyxl.load_workbook(BytesIO(raw), read_only=True, data_only=True, keep_links=False)
        sheets = ((s.title, s.iter_rows(values_only=True)) for s in book)
    elif filename.lower().endswith('.xls'):
        import xlrd
        book = xlrd.open_workbook(file_contents=raw)
        def rows(sheet):
            for i in range(sheet.nrows):
                yield [xlrd.xldate_as_datetime(c.value, book.datemode) if c.ctype == xlrd.XL_CELL_DATE else c.value for c in sheet.row(i)]
        sheets = ((s.name, rows(s)) for s in book.sheets())
    else:
        raise ValueError('請選Excel .xlsx或.xls檔，捷徑.lnk不含資料')
    records, skipped, context_year, context_month = [], 0, None, None
    warnings = []
    try:
        for title, rows in sheets:
            first_month = re.search(r'(\d{1,2})月', title)
            if not re.search(r'\d{3,4}年', title) and context_year and context_month == 12 and first_month and int(first_month[1]) == 1:
                context_year += 1
            first, last, context_year = period(title, context_year)
            if last:
                context_month = int(last[5:7])
            if first and (last < start or first > end):
                continue
            header, current_day = None, ''
            for index, row in enumerate(rows, 1):
                if header is None:
                    labels = [re.sub(r'\s+', '', text(v)) for v in row]
                    if any(k in labels for k in ALIASES['name']) and any(k in labels for k in ALIASES['phone']):
                        header = {k: next((labels.index(a) for a in aliases if a in labels), -1) for k, aliases in ALIASES.items()}
                        continue
                    # Recognize the user's standard date-prefixed ten-column export,
                    # including its FIRST row. Do not infer dates from interview time.
                    if len(row) == 10 and parse_day(row[0]) and re.fullmatch(r'[\w\u3400-\u9fff·．・\s-]{2,30}', text(row[1])) and re.fullmatch(r'09\d{8}', re.sub(r'[\s()-]', '', text(row[2]))):
                        header = dict(zip(['date', 'name', 'phone', 'job', 'gender', 'age', 'interviewAt', 'notes', 'source', 'callTime'], range(10)))
                        header['again'] = -1
                        warnings.append(title + '沒有標題列，依日期／姓名／電話／職缺／性別／年齡／面試時間／備註／來源／撥打時間辨識，請預覽核對')
                    else:
                        if index >= 10:
                            break
                        continue
                values = {k: row[c] if 0 <= c < len(row) else None for k, c in header.items()}
                if header['date'] >= 0 and parse_day(values['date']):
                    current_day = parse_day(values['date'])
                name = text(values['name'])
                if not name or name in ALIASES['name']:
                    continue
                day = current_day if header['date'] >= 0 else first if first == last else ''
                begin, finish = (day, day) if day else (first, last)
                if not begin or not finish or begin < start or finish > end:
                    skipped += 1
                    continue
                interview = values['interviewAt']
                interview_at = interview.strftime('%Y-%m-%dT%H:%M') if isinstance(interview, datetime) else ''
                entry = {k: text(values[k]) for k in ['name', 'phone', 'job', 'gender', 'age', 'notes', 'source', 'again']}
                entry.update(callDate=day, callTime=clock(values['callTime']), rawCallTime=text(values['callTime']), rawInterviewAt=text(interview), interviewAt=interview_at,
                             sourceFile=filename, sourceSheet=title, sourceRow=index, rangeStart=begin, rangeEnd=finish)
                records.append(entry)
                if len(records) > 10000:
                    raise ValueError('所選範圍超過10000列，請縮小日期範圍')
    finally:
        if hasattr(book, 'close'):
            book.close()
    if skipped:
        warnings.append(f'{skipped}列沒有可確認的範圍內日期，未納入')
    if not records:
        raise ValueError('沒有可匯入紀錄：請檢查日期範圍及姓名、電話標題；無標題檔請使用日期／姓名／電話等10欄格式')
    return {'schema': 'baiqi-recruitment', 'version': 1, 'startDate': start, 'endDate': end, 'records': records, 'warnings': warnings}
