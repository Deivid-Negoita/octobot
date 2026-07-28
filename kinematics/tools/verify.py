"""Smoke-test both pages in a real browser: no console errors, rig built, render OK.

    python tools/serve.py 8123 &
    python tools/verify.py [--shots]

--shots also writes docs/images/{workbench,playground}.png for the README.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# the UI is full of box-drawing glyphs; a cp1252 console must not kill the run
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = 'http://localhost:8123'
DOCS = Path(__file__).resolve().parents[2] / 'docs' / 'images'
IGNORE = ('favicon', 'fonts.googleapis', 'fonts.gstatic')


def check(page_name, url, ready_js, after=None, shot=None):
    errors, logs = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader'])
        page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('console', lambda m: (logs.append(m.text),
                                      errors.append(m.text) if m.type == 'error' else None))
        page.on('pageerror', lambda e: errors.append(f'PAGEERROR {e}'))
        page.goto(url, wait_until='networkidle')
        try:
            page.wait_for_function(ready_js, timeout=90_000)
        except Exception as exc:
            errors.append(f'not ready: {exc}')
        if after:
            after(page)
        page.wait_for_timeout(1500)
        if shot:
            shot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(shot))
        browser.close()

    errors = [e for e in errors if not any(s in e for s in IGNORE)]
    print(f'\n=== {page_name} ===')
    for line in logs[:12]:
        print('  log:', line[:150])
    if errors:
        print('  FAIL')
        for e in errors:
            print('   !', e[:400])
        return False
    print('  PASS — no console errors, boot completed')
    return True


def workbench_after(page):
    # the rig has to answer the UI: eight legs listed, telemetry streaming
    legs = page.locator('#chain-list .chain-row').count()
    print(f'  legs listed: {legs}')
    assert legs == 8, f'expected 8 legs, got {legs}'
    page.locator('#chain-list .chain-row').first.click()
    joints = page.locator('#joint-list .joint-row').count()
    print(f'  joints in LEG-1: {joints}')
    assert joints >= 4, joints
    page.keyboard.press('h')
    assert page.locator('#help-modal.open').count() == 1, 'help did not open on H'
    page.keyboard.press('Escape')
    assert page.locator('#help-modal.open').count() == 0, 'help did not close on Escape'
    page.keyboard.press('p')
    assert page.locator('#sidebar.collapsed').count() == 1, 'P did not hide the sidebar'
    page.keyboard.press('p')
    assert page.locator('#sidebar.collapsed').count() == 0, 'P did not restore the sidebar'
    page.locator('#btn-walk').click()
    page.wait_for_timeout(2500)
    print('  gait:', page.locator('#btn-walk').inner_text().strip())
    fps = page.locator('#t-fps').inner_text()
    print(f'  fps: {fps}, status: {page.locator("#t-status").inner_text()}')
    page.locator('#btn-walk-stop').click()


def playground_after(page):
    rows = page.locator('#servo-rows tr').count()
    print(f'  servo rows: {rows}')
    assert rows == 8, f'expected 8 legs of telemetry, got {rows}'
    page.locator('#btn-spawn').click()
    # The counter refreshes on the telemetry tick, which is frame-rate bound, so
    # wait on the value rather than on a fixed delay that a slow frame outlasts.
    page.wait_for_function(
        "() => document.getElementById('t-blocks').textContent === '1'", timeout=15_000)
    print('  blocks:', page.locator('#t-blocks').inner_text())
    page.keyboard.down('w')
    page.wait_for_timeout(2500)
    page.keyboard.up('w')
    print('  body after walking:', page.locator('#t-body').inner_text())
    page.keyboard.press('p')
    assert page.locator('#left-panel.collapsed').count() == 1, 'P did not hide the left panel'
    assert page.locator('#right-panel.collapsed').count() == 1, 'P did not hide the telemetry'
    page.keyboard.press('p')
    assert page.locator('#right-panel.collapsed').count() == 0, 'P did not restore the telemetry'


if __name__ == '__main__':
    shots = '--shots' in sys.argv
    ok = check('WORKBENCH', f'{BASE}/index.html',
               "() => document.querySelectorAll('#chain-list .chain-row').length === 8",
               workbench_after, DOCS / 'workbench.png' if shots else None)
    ok &= check('PLAYGROUND', f'{BASE}/playground.html',
                "() => document.getElementById('boot').classList.contains('done')",
                playground_after, DOCS / 'playground.png' if shots else None)
    print('\nRESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
