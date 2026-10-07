#!/bin/sh
# Seeds the shared namespace once, before Dovecot starts (#42 integration tests): a
# "ReadOnly" folder the test user may only read. Run by the "seed" service in
# compose.test.yaml, on a busybox image (the dovecot image has no shell tools). The
# mailbox is a plain Maildir; the ACL file grants `anyone` lookup and read only, so
# MYRIGHTS answers `lr` and a delete or a move out is refused with [NOPERM].
set -eu

root=/shared
mkdir -p "$root/ReadOnly/cur" "$root/ReadOnly/new" "$root/ReadOnly/tmp"
printf 'anyone lr\n' > "$root/ReadOnly/dovecot-acl"

# One letter, so a test can try to delete or move something.
cat > "$root/ReadOnly/cur/1.msg:2,S" <<'MSG'
From: Бухгалтерия <buh@example.org>
To: me@example.org
Subject: Реестр платежей на неделю
Message-ID: <shared-ro@example.org>
Date: Fri, 2 Oct 2026 10:00:00 +0300
Content-Type: text/plain; charset=utf-8

Тело общего письма. Менять его нельзя: папка только для чтения.
MSG

# The container's mail user is uid 1000 (vmail); the seed runs as root.
chown -R 1000:1000 "$root"
chmod -R u+rwX,g+rwX "$root"
