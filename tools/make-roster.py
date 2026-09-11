#!/usr/bin/env python3
"""name.txt（學務系統匯出的 TSV）→ roster.csv（可匯入 Google 試算表）

兩個檔案都含學生個資，已被 .gitignore / .vercelignore 排除。
用法：python3 tools/make-roster.py [來源檔] [輸出檔]
"""
import csv, io, sys, collections, pathlib

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'name.txt')
DST = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else 'roster.csv')

EXPECTED = ['序號', '學號', '姓名', '年級', '電子信箱', '選上否']
HEADERS = EXPECTED + ['出席時間', '課堂加分', '講座加分']

rows = [l.rstrip('\r\n') for l in io.open(SRC, encoding='utf-8') if l.strip()]
if not rows:
    sys.exit(f'{SRC} 是空的')

header = [c.strip() for c in rows[0].split('\t')]
if header != EXPECTED:
    sys.exit(f'欄位不符。預期 {EXPECTED}，實際 {header}')

out, seen, dupes = [], set(), []
for i, line in enumerate(rows[1:], start=2):
    f = [c.strip() for c in line.split('\t')]
    if len(f) != 6:
        sys.exit(f'第 {i} 行有 {len(f)} 欄，預期 6 欄：{line!r}')
    seq, sid, name, grade, email, enrolled = f
    sid = sid.upper()
    if sid in seen:
        dupes.append(sid)
    seen.add(sid)
    out.append([seq, sid, name, grade, email, enrolled, '', 0, 0])

with io.open(DST, 'w', encoding='utf-8', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(HEADERS)
    w.writerows(out)

print(f'✓ {DST}：{len(out)} 位學生')
if dupes:
    print(f'⚠ 重複學號：{sorted(set(dupes))}')
print('  年級分布：', dict(sorted(collections.Counter(r[3] for r in out).items())))
