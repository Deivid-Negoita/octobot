"""Capture the README screenshots.

    python tools/serve.py 8123 &
    python tools/shots.py

Writes docs/images/workbench.png and docs/images/playground.png.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = 'http://localhost:8123'
OUT = Path(__file__).resolve().parents[2] / 'docs' / 'images'
VIEW = {'width': 1600, 'height': 900}


def orbit(page, dx, dy, wheel=0):
    """Drag the viewport to swing the camera, then dolly with the wheel."""
    cx, cy = VIEW['width'] / 2, VIEW['height'] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + dx, cy + dy, steps=20)
    page.mouse.up()
    if wheel:
        page.mouse.wheel(0, wheel)
    page.wait_for_timeout(600)


def shoot(name, url, ready, pose):
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader'])
        page = browser.new_page(viewport=VIEW, device_scale_factor=2)
        page.goto(url, wait_until='networkidle')
        page.wait_for_function(ready, timeout=90_000)
        page.wait_for_timeout(1200)   # let the boot overlay finish fading
        pose(page)
        page.screenshot(path=str(OUT / f'{name}.png'))
        browser.close()
    print('wrote', OUT / f'{name}.png')


def workbench_pose(page):
    # the app frames the rig itself on load, so this only swings the camera to a
    # three-quarter view — it no longer has to dolly in to find the robot
    page.locator('#chain-list .chain-row').first.click()
    page.wait_for_timeout(300)
    orbit(page, 55, -15)
    page.evaluate("() => document.getElementById('sidebar').scrollTo(0, 0)")
    page.wait_for_timeout(400)


def playground_pose(page):
    page.locator('#btn-spawn').click()
    page.wait_for_timeout(500)
    page.keyboard.down('w')
    page.wait_for_timeout(1600)
    page.keyboard.up('w')
    orbit(page, 0, -90, -180)


if __name__ == '__main__':
    shoot('workbench', f'{BASE}/index.html',
          "() => document.querySelectorAll('#chain-list .chain-row').length === 8",
          workbench_pose)
    shoot('playground', f'{BASE}/playground.html',
          "() => document.getElementById('boot').classList.contains('done')",
          playground_pose)
