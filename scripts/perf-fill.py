#!/usr/bin/env python3
"""Fills a Dovecot (compose.test.yaml) mailbox with N messages by writing Maildir directly.

    scripts/perf-fill.py [N] [USER]     defaults: 50000 perfbulk

APPEND over IMAP takes ~30 ms per message on Dovecot (fsync), half an hour for 50 000;
copying a ready Maildir takes seconds. The container's vmail user is uid 1000.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time

n = int(sys.argv[1]) if len(sys.argv) > 1 else 50_000
user = sys.argv[2] if len(sys.argv) > 2 else "perfbulk"
container = "depesha-dovecot-1"

root = tempfile.mkdtemp(prefix="depesha-perf-")
mail = os.path.join(root, user, "mail")
for d in ("cur", "new", "tmp"):
    os.makedirs(os.path.join(mail, d))

start = int(time.time()) - n * 60
for i in range(n):
    s, k = i % 300, i % 97
    body = (
        f"From: =?utf-8?B?{__import__('base64').b64encode(f'Отправитель {s}'.encode()).decode()}?= <sender{s}@example.org>\r\n"
        f"To: me@example.org\r\n"
        f"Subject: =?utf-8?B?{__import__('base64').b64encode(f'Письмо номер {i} про счёт {k}'.encode()).decode()}?=\r\n"
        f"Message-ID: <{i}@perf.example.org>\r\n"
        f"Date: {time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime(start + i * 60))}\r\n"
        f"Content-Type: text/plain; charset=utf-8\r\n\r\n"
        f"Текст письма {i}. Ключевое слово квартал{k}.\r\n"
    ).encode()
    ts = start + i * 60
    flags = "" if i % 3 == 0 else "S"
    path = os.path.join(mail, "cur", f"{ts}.M{i}P1.perf,S={len(body)}:2,{flags}")
    with open(path, "wb") as f:
        f.write(body)
    os.utime(path, (ts, ts))

# Dovecot 2.4 keeps Maildir mailboxes in GUID-named directories, so files are not dropped
# in place: the ready Maildir is imported with doveadm, which takes seconds.
src = f"/srv/vmail/import-{user}"
subprocess.run(["docker", "cp", "-a", os.path.join(root, user, "mail"), f"{container}:{src}"], check=True)
subprocess.run(["docker", "exec", container, "doveadm", "import", "-u", user, f"maildir:{src}", "", "all"], check=True, stderr=subprocess.DEVNULL)
shutil.rmtree(root)
print(f"{n} messages in Maildir of {user}")
