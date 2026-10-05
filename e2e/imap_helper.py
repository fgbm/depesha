#!/usr/bin/env python3
"""Seeds and inspects the GreenMail test mailbox for the E2E test.

  imap_helper.py seed            create folders and test messages for carol
  imap_helper.py count FOLDER SUBJECT
  imap_helper.py flags FOLDER SUBJECT
  imap_helper.py header FOLDER SUBJECT HEADER
  imap_helper.py flag FOLDER SUBJECT        set \\Flagged from "another client"
  imap_helper.py big FOLDER SUBJECT KB      deliver a read letter with a KB-sized attachment
  imap_helper.py delete FOLDER SUBJECT      expunge the letters with that subject
"""

import base64
import email.utils
import imaplib
import socket
import sys
import time

HOST, PORT, USER, PASSWORD = "127.0.0.1", 3143, "carol", "secret"
ME = "carol@local.test"


def conn():
    c = imaplib.IMAP4(HOST, PORT)
    # APPEND waits for "+" before the literal: with Nagle each message took 40 ms.
    c.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    c.login(USER, PASSWORD)
    return c


def append(c, folder, raw, flags="", when=None):
    date = imaplib.Time2Internaldate(when or time.time())
    typ, data = c.append(folder, flags, date, raw)
    assert typ == "OK", data


def msg(subject, body, sender="Иван Петров <ivan@example.org>", when=None, extra="", mid=None):
    date = email.utils.formatdate(when or time.time(), localtime=True)
    mid = mid or f"{abs(hash(subject + str(when)))}@example.org"
    subj = "=?utf-8?B?" + base64.b64encode(subject.encode()).decode() + "?="
    frm_name, frm_addr = sender.split(" <")
    frm = "=?utf-8?B?" + base64.b64encode(frm_name.encode()).decode() + "?= <" + frm_addr
    return (
        f"From: {frm}\r\nTo: {ME}\r\nSubject: {subj}\r\nDate: {date}\r\n"
        f"Message-ID: <{mid}>\r\nMIME-Version: 1.0\r\n{extra}"
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
    # The receiving server's verdict (the mailbox's own domain): "always for the sender" holds
    # only for a sender the server vouches for.
    "Authentication-Results: mx.local.test; dmarc=pass header.from=example.org\r\n"
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


FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures" / "attachments"
DOCS_TYPES = {
    "contract.pdf": "application/pdf",
    "contract.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "price.xlsx": "application/octet-stream",
    "notes.md": "text/markdown",
    "sums.csv": "text/csv",
}


def docs(when):
    """A letter with one attachment of every kind the viewer draws itself."""
    parts = [
        "From: =?utf-8?B?" + base64.b64encode("Отдел закупок".encode()).decode() + "?= <buy@example.org>\r\n"
        "To: carol@local.test\r\nSubject: =?utf-8?B?" + base64.b64encode("Документы на проверку".encode()).decode() + "?=\r\n"
        f"Date: {email.utils.formatdate(when, localtime=True)}\r\nMessage-ID: <docs1@example.org>\r\nMIME-Version: 1.0\r\n"
        'Content-Type: multipart/mixed; boundary="mix"\r\n\r\n'
        "--mix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nДоговор, прайс и заметки во вложении.\r\n"
    ]
    for name, ctype in DOCS_TYPES.items():
        data = base64.encodebytes((FIXTURES / name).read_bytes()).decode().replace("\n", "\r\n")
        parts.append(
            f'--mix\r\nContent-Type: {ctype}; name="{name}"\r\nContent-Disposition: attachment; filename="{name}"\r\n'
            f"Content-Transfer-Encoding: base64\r\n\r\n{data}"
        )
    parts.append("--mix--\r\n")
    return "".join(parts).encode()


def markdown(subject):
    """A letter written in Markdown, as Depesha sends it: text, then the Markdown, then HTML."""
    source = "# Итоги встречи\r\n\r\n- [x] договор подписан\r\n- [ ] подключить сканеры\r\n\r\n| Задача | Кто |\r\n|---|---|\r\n| Сканеры | Алексей |\r\n"
    html = "<h1>Итоги встречи</h1><ul><li>&#9745; договор подписан</li><li>&#9744; подключить сканеры</li></ul>"
    b64 = lambda text: base64.encodebytes(text.encode()).decode().replace("\n", "\r\n")
    subj = "=?utf-8?B?" + base64.b64encode(subject.encode()).decode() + "?="
    return (
        f"From: Alexey <alexey@example.org>\r\nTo: {ME}\r\nSubject: {subj}\r\n"
        f"Date: {email.utils.formatdate(time.time(), localtime=True)}\r\nMessage-ID: <md-{abs(hash(subject))}@example.org>\r\n"
        'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n'
        f"--alt\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{b64(source)}"
        "--alt\r\nContent-Type: text/markdown; charset=utf-8; variant=CommonMark\r\n"
        f"Content-Transfer-Encoding: base64\r\n\r\n{b64(source)}"
        f"--alt\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{b64(html)}"
        "--alt--\r\n"
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
    # In «Работа», not in INBOX: the inbox's rows stay where other steps expect them.
    append(c, imaplib_utf7("Работа"), docs(now - 86400), "(\\Seen)", now - 86400)
    append(c, "INBOX", CP1251, "", now - 7200)
    append(c, "INBOX", HTML, "", now - 3600)
    append(c, "INBOX", msg("Счёт за октябрь", "Оплатить до пятницы, реквизиты во вложении.", when=now - 600), "", now - 600)
    # A conversation of three letters (References), read long ago.
    root = "budget-1@example.org"
    append(c, "INBOX", msg("Бюджет на ноябрь", "Предлагаю обсудить.", when=now - 5400, mid=root), "(\\Seen)", now - 5400)
    append(c, "INBOX", msg("Re: Бюджет на ноябрь", "Согласен.", sender="Мария Соколова <maria@example.org>", when=now - 5000,
                           mid="budget-2@example.org", extra=f"In-Reply-To: <{root}>\r\nReferences: <{root}>\r\n"), "(\\Seen)", now - 5000)
    append(c, "INBOX", msg("Re: Бюджет на ноябрь", "Тогда в пятницу.", when=now - 4800, mid="budget-3@example.org",
                           extra=f"In-Reply-To: <budget-2@example.org>\r\nReferences: <{root}> <budget-2@example.org>\r\n"), "(\\Seen)", now - 4800)
    # A newsletter: bulk, unsubscribes by mail (to carol herself, so the test can see the request).
    append(c, "INBOX", msg("Скидки недели", "Только сегодня.", sender="Магазин <news@shop.example>", when=now - 4000,
                           extra="List-Id: <weekly.shop.example>\r\n"
                                 "List-Unsubscribe: <mailto:carol@local.test?subject=unsubscribe-weekly>\r\n"), "", now - 4000)
    c.logout()


def reply(folder, subject):
    """Answers the message from `folder` into INBOX, as the other side would."""
    c = conn()
    uids = find(c, folder, subject)
    typ, data = c.uid("FETCH", uids[-1], "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
    mid = data[0][1].decode().split(":", 1)[1].strip()
    append(c, "INBOX", msg(f"Re: {subject}", "Отвечаю.", sender="Ответчик <answer@example.org>",
                           extra=f"In-Reply-To: {mid}\r\nReferences: {mid}\r\n"))
    c.logout()


def imaplib_utf7(name):
    # Modified UTF-7 for the Cyrillic folder name.
    if all(ord(ch) < 128 for ch in name):
        return name
    b64 = base64.b64encode(name.encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
    return f'"&{b64}-"'


def big(subject, kb, when=None):
    """A letter with one attachment of `kb` kilobytes of noise: large mail for #16."""
    import os

    data = base64.encodebytes(os.urandom(kb * 1024)).decode().replace("\n", "\r\n")
    subj = "=?utf-8?B?" + base64.b64encode(subject.encode()).decode() + "?="
    date = email.utils.formatdate(when or time.time(), localtime=True)
    return (
        f"From: =?utf-8?B?{base64.b64encode('Мария Соколова'.encode()).decode()}?= <maria@example.org>\r\n"
        f"To: {ME}\r\nSubject: {subj}\r\nDate: {date}\r\nMessage-ID: <big-{kb}-{int(time.time())}@example.org>\r\n"
        'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="big"\r\n\r\n'
        "--big\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPhotos attached.\r\n"
        '--big\r\nContent-Type: application/zip; name="photos.zip"\r\nContent-Disposition: attachment; filename="photos.zip"\r\n'
        f"Content-Transfer-Encoding: base64\r\n\r\n{data}--big--\r\n"
    ).encode()


def utf7_path(name):
    """Modified UTF-7 of a folder path: each level apart, GreenMail's "." left as it is."""
    return '"' + ".".join(imaplib_utf7(part).strip('"') for part in name.split(".")) + '"'


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
    if cmd == "reply":
        reply(sys.argv[2], sys.argv[3])
        print("ok")
        return
    if cmd == "deliver":
        c = conn()
        append(c, "INBOX", msg(sys.argv[2], "Новое письмо для правил.", sender="Пётр Сидоров <petr@example.org>"))
        c.logout()
        print("ok")
        return
    if cmd == "big":
        c = conn()
        # Read: unread counters of later steps stay as they were.
        append(c, utf7_path(sys.argv[2]), big(sys.argv[3], int(sys.argv[4])), "(\\Seen)")
        c.logout()
        print("ok")
        return
    if cmd == "deliver-markdown":
        c = conn()
        append(c, "INBOX", markdown(sys.argv[2]))
        c.logout()
        print("ok")
        return
    folder, subject = sys.argv[2], sys.argv[3]
    c = conn()
    c._encoding = "utf-8"
    if cmd == "delete":
        c.select(utf7_path(folder))
        typ, data = c.uid("FETCH", "1:*", "(UID BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
        from email.header import decode_header, make_header

        for item in data:
            if isinstance(item, tuple):
                raw = item[1].decode("ascii", "replace").split(":", 1)[-1].replace("\r\n", "").strip()
                if subject in str(make_header(decode_header(raw))):
                    c.uid("STORE", item[0].split(b"UID ")[1].split()[0], "+FLAGS", "(\\Deleted)")
        c.expunge()
        c.logout()
        print("ok")
        return
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
    elif cmd == "raw":
        if uids:
            typ, data = c.uid("FETCH", uids[-1], "(BODY.PEEK[])")
            print(data[0][1].decode("utf-8", "replace"))
    elif cmd == "flag":
        c.uid("STORE", uids[-1], "+FLAGS", "(\\Flagged)")
        print("ok")
    c.logout()


if __name__ == "__main__":
    main()
