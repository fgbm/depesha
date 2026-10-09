#!/usr/bin/env python3
"""Waits until the test stand serves, not merely listens: a real IMAP login on GreenMail
(plain and TLS) and on Dovecot (STARTTLS and TLS), also the one without UIDPLUS (STARTTLS, #113). Dovecot opens its port before its TLS
handshake works; the tests that came first got EOF."""
import imaplib
import ssl
import sys
import time

HOST = "127.0.0.1"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def greenmail_plain():
    c = imaplib.IMAP4(HOST, 3143, timeout=5)
    c.login("alice", "secret")
    c.logout()


def greenmail_tls():
    c = imaplib.IMAP4_SSL(HOST, 3993, ssl_context=ctx, timeout=5)
    c.login("alice", "secret")
    c.logout()


def dovecot_starttls():
    c = imaplib.IMAP4(HOST, 31143, timeout=5)
    c.starttls(ssl_context=ctx)
    c.login("alice", "secret")
    c.logout()


def dovecot_tls():
    c = imaplib.IMAP4_SSL(HOST, 31993, ssl_context=ctx, timeout=5)
    c.login("alice", "secret")
    c.logout()


def dovecot_no_uidplus():
    c = imaplib.IMAP4(HOST, 31144)
    c.starttls(ssl_context=ctx)
    c.login("alice", "secret")
    c.logout()


CHECKS = [greenmail_plain, greenmail_tls, dovecot_starttls, dovecot_tls, dovecot_no_uidplus]
deadline = time.time() + 90
pending = list(CHECKS)
last = {}
while pending and time.time() < deadline:
    for check in list(pending):
        try:
            check()
            pending.remove(check)
        except Exception as e:  # noqa: BLE001 - any failure means "not yet"
            last[check.__name__] = e
    if pending:
        time.sleep(1)

if pending:
    for check in pending:
        print(f"стенд не готов: {check.__name__}: {last.get(check.__name__)}", file=sys.stderr)
    sys.exit(1)
print("стенд готов")
