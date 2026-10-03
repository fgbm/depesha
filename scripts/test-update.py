#!/usr/bin/env python3
"""End-to-end check of self-updating, on Linux with AppImage builds (about 5 minutes).

    scripts/test-update.py

1. A throwaway signing key; two debug AppImages, 9.0.0 and 9.0.1, built with its public key.
2. 9.0.0 runs on a virtual display and finds 9.0.1 on a local server: it must replace itself.
3. The server then offers 9.0.2: the real signature, a file with one byte added. It must refuse.

Needs Xvfb on $DISPLAY (default :99; see e2e/README.md). The project's own key is not used.
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
work = tempfile.mkdtemp(prefix="depesha-update-")


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def build(version, pub, env):
    config = json.dumps({"version": version, "plugins": {"updater": {"pubkey": pub}}})
    subprocess.run(
        ["npx", "tauri", "build", "--debug", "--bundles", "appimage", "--config", config],
        cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    name = f"Depesha_{version}_amd64.AppImage"
    for suffix in ("", ".sig"):
        shutil.copy(os.path.join(ROOT, "target/debug/bundle/appimage", name + suffix), work)
    return os.path.join(work, name)


def offer(version, file, sig_file):
    with open(sig_file) as f:
        sig = f.read().strip()
    url = f"http://127.0.0.1:{PORT}/{os.path.basename(file)}"
    with open(os.path.join(work, "latest.json"), "w") as f:
        json.dump({"version": version, "platforms": {"linux-x86_64": {"signature": sig, "url": url}}}, f)


def run_app(appimage, profile):
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":99"), GDK_BACKEND="x11", WAYLAND_DISPLAY="",
               XDG_CONFIG_HOME=f"{profile}/c", XDG_DATA_HOME=f"{profile}/d", XDG_CACHE_HOME=f"{profile}/k",
               DEPESHA_NO_NOTIFICATIONS="1", DEPESHA_UPDATE_URL=f"http://127.0.0.1:{PORT}/latest.json")
    # Own process group: the AppImage starts WebKit helpers that must go with it.
    return subprocess.Popen([appimage], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    proc.wait(timeout=20)


def log_of(profile):
    logs = os.path.join(profile, "d/ru.depesha.mail/logs")
    return "".join(open(os.path.join(logs, n)).read() for n in os.listdir(logs)) if os.path.isdir(logs) else ""


def wait(what, fn, seconds=120):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if fn():
            return
        time.sleep(3)
    sys.exit(f"FAIL: {what}")


def main():
    keyfile = os.path.join(work, "key")
    subprocess.run(["npx", "tauri", "signer", "generate", "--ci", "-w", keyfile, "-p", ""],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(keyfile) as f:
        key = f.read()
    with open(keyfile + ".pub") as f:
        pub = f.read().strip()
    env = dict(os.environ, TAURI_SIGNING_PRIVATE_KEY=key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD="")
    print("building 9.0.0 and 9.0.1…")
    old = build("9.0.0", pub, env)
    new = build("9.0.1", pub, env)
    installed = os.path.join(work, "installed.AppImage")
    shutil.copy(old, installed)

    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", work],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        offer("9.0.1", new, new + ".sig")
        profile = tempfile.mkdtemp(dir=work)
        app = run_app(installed, profile)
        wait("9.0.0 did not replace itself with 9.0.1", lambda: sha(installed) == sha(new))
        stop(app)
        print("ok: a signed update is installed")

        tampered = os.path.join(work, "tampered.AppImage")
        shutil.copy(new, tampered)
        with open(tampered, "ab") as f:
            f.write(b"X")
        offer("9.0.2", tampered, new + ".sig")
        before = sha(installed)
        profile = tempfile.mkdtemp(dir=work)
        app = run_app(installed, profile)
        wait("no verdict on the tampered update", lambda: "signature verification failed" in log_of(profile))
        stop(app)
        if sha(installed) != before:
            sys.exit("FAIL: the tampered update replaced the app")
        print("ok: a tampered update is refused, the app is untouched")
    finally:
        server.terminate()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
