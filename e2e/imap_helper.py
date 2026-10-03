#!/usr/bin/env python3
"""Seeds and inspects the GreenMail test mailbox for the E2E test.

  imap_helper.py seed            create folders and test messages for carol
  imap_helper.py count FOLDER SUBJECT
  imap_helper.py flags FOLDER SUBJECT
  imap_helper.py header FOLDER SUBJECT HEADER
  imap_helper.py flag FOLDER SUBJECT        set \\Flagged from "another client"
"""

import base64
import email.utils
import imaplib
import sys
import time

HOST, PORT, USER, PASSWORD = "127.0.0.1", 3143, "carol", "secret"
ME = "carol@local.test"


def conn():
    c = imaplib.IMAP4(HOST, PORT)
    c.login(USER, PASSWORD)
    return c


def append(c, folder, raw, flags="", when=None):
    date = imaplib.Time2Internaldate(when or time.time())
    typ, data = c.append(folder, flags, date, raw)
    assert typ == "OK", data


def msg(subject, body, sender="Иван Петров <ivan@example.org>", when=None, extra=""):
    date = email.utils.formatdate(when or time.time(), localtime=True)
    subj = "=?utf-8?B?" + base64.b64encode(subject.encode()).decode() + "?="
    frm_name, frm_addr = sender.split(" <")
    frm = "=?utf-8?B?" + base64.b64encode(frm_name.encode()).decode() + "?= <" + frm_addr
    return (
        f"From: {frm}\r\nTo: {ME}\r\nSubject: {subj}\r\nDate: {date}\r\n"
        f"Message-ID: <{abs(hash(subject + str(when)))}@example.org>\r\nMIME-Version: 1.0\r\n{extra}"
        f"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        + base64.encodebytes(body.encode()).decode().replace("\n", "\r\n")
    ).encode()


CP1251 = (
    b"From: =?koi8-r?Q?=E2=D5=C8=C7=C1=CC=D4=C5=D2=C9=D1?= <buh@example.ru>\r\n"
    b"To: carol@local.test\r\n"
    b"Subject: =?windows-1251?B?0fe48iDt4CDu7+vg8vM=?=\r\n"
    b"Date: Fri, 2 Oct 2026 10:00:00 +0300\r\n"
    b"Message-ID: <cp1251@example.ru>\r\n"
    b"MIME-Version: 1.0\r\n"
    b"Content-Type: text/plain; charset=windows-1251\r\n"
    b"Content-Transfer-Encoding: quoted-printable\r\n\r\n"
    b"=C4=EE=E1=F0=FB=E9 =E4=E5=ED=FC! =CE=EF=EB=E0=F2=E8=F2=E5 =E4=EE =EF=FF=F2=\r\n"
    b"=ED=E8=F6=FB.\r\n"
)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

HTML = (
    "From: =?utf-8?B?" + base64.b64encode("Рассылка".encode()).decode() + "?= <news@example.org>\r\n"
    "To: carol@local.test\r\nSubject: =?utf-8?B?" + base64.b64encode("HTML-письмо с картинками".encode()).decode() + "?=\r\n"
    "Date: Fri, 2 Oct 2026 11:00:00 +0300\r\nMessage-ID: <html1@example.org>\r\nMIME-Version: 1.0\r\n"
    'Content-Type: multipart/mixed; boundary="mix"\r\n\r\n'
    '--mix\r\nContent-Type: multipart/related; boundary="rel"\r\n\r\n'
    "--rel\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
    '<h2 style="color:#0a5">Новости</h2><p onclick="steal()">Текст <b>новости</b>.</p>'
    '<script>alert(1)</script><img id="logo" src="cid:logo@x"> <img id="pixel" src="https://tracker.example/p.gif">'
    '<p><a href="https://example.com/news">Подробнее</a></p>\r\n'
    "--rel\r\nContent-Type: image/png\r\nContent-ID: <logo@x>\r\nContent-Disposition: inline\r\n"
    "Content-Transfer-Encoding: base64\r\n\r\n" + base64.b64encode(PNG).decode() + "\r\n--rel--\r\n"
    '--mix\r\nContent-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\n'
    "Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--mix--\r\n"
).encode()


def seed():
    c = conn()
    # GreenMail's hierarchy delimiter is ".".
    for f in ("Sent", "Drafts", "Trash", "Calendar", "Calendar.Birthdays", "Работа"):
        typ, data = c.create(imaplib_utf7(f))
        assert typ == "OK", (f, data)
    now = time.time()
    # 620 older messages: more than the first-sync window of 500.
    for i in range(620):
        when = now - 86400 * 30 - (620 - i) * 3600
        subject = "Quarterly report archive" if i == 10 else f"Массовое письмо {i:03d}"
        append(c, "INBOX", msg(subject, f"Тело письма номер {i}", when=when), "(\\Seen)", when)
    append(c, "INBOX", CP1251, "", now - 7200)
    append(c, "INBOX", HTML, "", now - 3600)
    append(c, "INBOX", msg("Счёт за октябрь", "Оплатить до пятницы, реквизиты во вложении.", when=now - 600), "", now - 600)
    c.logout()


def imaplib_utf7(name):
    # Modified UTF-7 for the Cyrillic folder name.
    if all(ord(ch) < 128 for ch in name):
        return name
    b64 = base64.b64encode(name.encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
    return f'"&{b64}-"'


def find(c, folder, subject):
    """UIDs whose decoded subject contains `subject` (GreenMail has no SEARCH CHARSET)."""
    from email.header import decode_header, make_header

    typ, _ = c.select(imaplib_utf7(folder))
    if typ != "OK":
        return []
    typ, data = c.uid("FETCH", "1:*", "(UID BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
    uids = []
    for item in data:
        if not isinstance(item, tuple):
            continue
        uid = item[0].split(b"UID ")[1].split()[0]
        raw = item[1].decode("ascii", "replace").split(":", 1)[-1].replace("\r\n", "").strip()
        if subject in str(make_header(decode_header(raw))):
            uids.append(uid)
    return uids


def main():
    cmd = sys.argv[1]
    if cmd == "seed":
        seed()
        return
    folder, subject = sys.argv[2], sys.argv[3]
    c = conn()
    c._encoding = "utf-8"
    uids = find(c, folder, subject)
    if cmd == "count":
        print(len(uids))
    elif cmd == "flags":
        if uids:
            typ, data = c.uid("FETCH", uids[-1], "(FLAGS)")
            print(data[0].decode())
    elif cmd == "header":
        if uids:
            typ, data = c.uid("FETCH", uids[-1], f"(BODY.PEEK[HEADER.FIELDS ({sys.argv[4]})])")
            print(data[0][1].decode().strip())
    elif cmd == "flag":
        c.uid("STORE", uids[-1], "+FLAGS", "(\\Flagged)")
        print("ok")
    c.logout()


if __name__ == "__main__":
    main()
