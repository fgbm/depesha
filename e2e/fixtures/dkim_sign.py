"""A DKIM-signed letter for the stand, with the key the e2e run publishes.

The letter is signed the way a real sender signs it (RFC 6376 §3.7): the signed data is the
canonicalized headers, the `DKIM-Signature` header with its `b=` value deleted, and the body
hash. The stand has no name server, so the e2e run publishes the key to the app
(`e2e_publish_dkim_key`) — the letter is then confirmed by the app's own check (ступень 3),
and its brand logo stands next to it in the list.

The key is a test key of this file: it signs nothing outside the stand.
"""

import base64
import hashlib

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

DOMAIN = "example.org"
SELECTOR = "s1"
KEY_PATH = "/home/vch/Projects/depesha-wt/q-trust/e2e/fixtures/dkim-key.pem"
NAME = f"{SELECTOR}._domainkey.{DOMAIN}."


def key_record() -> str:
    """The DKIM key record of the test key: `v=DKIM1; k=rsa; p=…`."""
    with open(KEY_PATH, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return f"v=DKIM1; k=rsa; p={base64.b64encode(der).decode()}"


def _relaxed(name: bytes, value: bytes) -> bytes:
    """The relaxed header canonicalization (RFC 6376 §3.4.2)."""
    value = b" ".join(value.split())
    return b"".join(name.lower().split()) + b":" + value


def _relaxed_body(body: bytes) -> bytes:
    """The relaxed body canonicalization (RFC 6376 §3.4.4): the whitespace runs of a line
    become one space, the trailing whitespace of a line is gone, the empty lines at the end are
    ignored, and a body that does not end with a CRLF gets one."""
    lines = body.split(b"\r\n")
    out = []
    for line in lines:
        out.append(b" ".join(line.split()))
    while out and not out[-1]:
        out.pop()
    if not out:
        return b""
    return b"\r\n".join(out) + b"\r\n"


def sign(headers: list[tuple[bytes, bytes]], body: bytes) -> str:
    """The `DKIM-Signature` header of a letter over the given headers and body."""
    signed = [h for h in headers if h[0].lower() in (b"from", b"to", b"subject", b"date")]
    data = b"".join(_relaxed(n, v) + b"\r\n" for n, v in signed)
    body_hash = hashlib.sha256(_relaxed_body(body)).digest()
    bh = base64.b64encode(body_hash).decode()
    unsigned = (
        f"v=1; a=rsa-sha256; s={SELECTOR}; d={DOMAIN}; c=relaxed/relaxed; "
        f"h=from:to:subject:date; bh={bh}; b="
    ).encode()
    data += _relaxed(b"dkim-signature", unsigned)
    data += body_hash
    with open(KEY_PATH, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    signature = key.sign(data, padding.PKCS1v15(), hashes.SHA256())
    b = base64.b64encode(signature).decode()
    return f"DKIM-Signature: {unsigned.decode()}{b}"


def signed_letter(subject: str, sender: bytes, to: bytes, text: str, when: str, mid: str) -> bytes:
    """A whole letter, signed: the bytes of the header block and the body.

    `sender` is the whole `From` value (a name and the address), `to` the whole `To` value.
    """
    body = text.encode()
    headers = [
        (b"From", sender),
        (b"To", to),
        (b"Subject", subject.encode()),
        (b"Date", when.encode()),
    ]
    signature = sign(headers, body)
    head = b"".join(n + b": " + v + b"\r\n" for n, v in headers)
    return signature.encode() + b"\r\n" + head + b"\r\n" + body
