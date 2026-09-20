#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
"""End-to-end browser proof for the packaged laser-line-scan project.

Starts `serve.mjs`, drives the wizard (optics -> rig -> calibration), runs the
calibration and then the object scan at full speed, and asserts the packaged
demo dataset produces a real point cloud from a plain static server.

    NIDVUE_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
      /home/pingz/Code/Nidvue/Websites/Source/.venv/bin/python tests/smoke.py

Optional: LASER_SCAN_PORT picks the port (default: a free one).
"""
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = Path("/tmp/standalone-smoke.png")
CHROMIUM = os.environ.get("NIDVUE_CHROMIUM")
errors = []
console_errors = []
failed = []


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


port = int(os.environ.get("LASER_SCAN_PORT") or free_port())
origin = f"http://127.0.0.1:{port}"
server = subprocess.Popen(
    ["node", str(ROOT / "serve.mjs"), "--port", str(port)],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
try:
    for _ in range(100):
        try:
            with urllib.request.urlopen(origin + "/", timeout=0.5) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(0.1)
    else:
        raise SystemExit("serve.mjs did not start")
    print(f"server {origin} pid={server.pid}", flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox"], executable_path=CHROMIUM)
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda message: console_errors.append(f"{message.type}: {message.text}") if message.type == "error" else None)
        page.on("response", lambda r: failed.append((r.status, r.url)) if r.status >= 400 else None)
        # The package ships no favicon, so Chromium's automatic /favicon.ico
        # request logs an unrelated console 404. Stub it with 204 so the
        # zero-console-error assertion measures the scanner itself.
        page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=b""))

        page.goto(origin + "/", wait_until="domcontentloaded")
        expect(page.locator("#ll-start")).to_be_enabled(timeout=30000)
        assert page.locator("#ll-setup-section").is_visible()

        # Wizard: optics -> rig -> calibration.
        page.click("#ll-to-rig")
        expect(page.locator("#ll-rig-section")).to_be_visible()
        page.click("#ll-to-calibration")
        expect(page.locator("#ll-calibration-section")).to_be_visible()
        # The packaged demo's default rig is charuco-moving-board. Its validation
        # split is intentionally small (12 frames), so the end-to-end point-count
        # proof selects charuco-fixed-board, whose split carries the shared truth
        # volume and enough frames to exceed the 30000-point threshold.
        page.click('[data-dataset="charuco-fixed-board"]')
        expect(page.locator("#ll-start")).to_be_enabled(timeout=30000)

        # Calibration at full speed.
        page.select_option("#ll-speed", "0")
        page.click("#ll-start")
        page.wait_for_function("!document.querySelector('#laser-lab').classList.contains('is-running')", timeout=180000)
        expect(page.locator("#ll-calibration-results")).to_be_visible()
        residual = page.locator("#ll-residual").inner_text()
        corners = page.locator("#ll-board-corners").inner_text()
        assert "mm" in residual and residual.strip() != "—", residual
        assert corners.strip() not in ("", "—"), corners
        print(f"calibration residual={residual} corners={corners}", flush=True)

        # Object scan at full speed.
        page.click("#ll-to-validation")
        page.select_option("#ll-v-speed", "0")
        page.click("#ll-validate")
        page.wait_for_function("!document.querySelector('#laser-lab').classList.contains('is-running')", timeout=240000)
        expect(page.locator("#ll-result-section")).to_be_visible()
        page.wait_for_function("document.querySelector('#ll-viewer').dataset.revealed==='true'", timeout=30000)
        points = int(page.locator("#ll-viewer").get_attribute("data-points") or 0)
        assert points > 30000, points
        # The visible point count must agree with the reconstructed cloud.
        label = page.locator("#ll-points").inner_text()
        label_points = int(re.sub(r"[^0-9]", "", label) or 0)
        assert label_points == points, f"#ll-points shows {label!r} but the cloud has {points} points"
        print(f"validation points={points} (expected > 30000)", flush=True)

        # The export button must produce a non-empty ASCII PLY from the cloud.
        expect(page.locator("#ll-ply")).to_be_enabled(timeout=30000)
        with page.expect_download(timeout=60000) as download_info:
            page.click("#ll-ply")
        download_path = download_info.value.path()
        assert download_path is not None, "PLY export produced no download path"
        ply_size = download_path.stat().st_size
        assert ply_size > 0, f"exported PLY is empty ({ply_size} bytes)"
        with open(download_path, "rb") as handle:
            assert handle.read(3) == b"ply", "exported PLY does not start with 'ply'"
        print(f"ply bytes={ply_size}", flush=True)

        page.wait_for_timeout(300)
        page.screenshot(path=str(SCREENSHOT), full_page=True)
        browser.close()
finally:
    server.terminate()
    server.wait(timeout=10)

print(f"screenshot {SCREENSHOT}", flush=True)
if failed:
    print(f"http failures ({len(failed)}): {failed[:5]}", flush=True)
if console_errors:
    print(f"console errors ({len(console_errors)}): {console_errors[:5]}", flush=True)
if errors:
    raise SystemExit(f"page errors ({len(errors)}): {errors}")
assert not console_errors, console_errors
assert not failed, failed
print("PASS: calibration + validation completed from the static server with no page or console errors")
