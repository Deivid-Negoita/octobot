// boot.js — the startup overlay both pages share.
//
// The octobot mesh is ~12 MB, so the first few seconds are a download. Without
// an overlay the visitor stares at an empty grid and assumes the page is broken.
// This module owns that screen: real byte progress while the mesh streams in,
// named stages while the rig is built, and a readable trace if a step throws.

const $ = id => document.getElementById(id);

const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';

/**
 * Take over the #boot element declared in the page.
 * Returns the handle the page drives during startup.
 */
export function createBoot() {
  const root = $('boot');
  const bar = $('boot-bar');
  const fill = bar?.querySelector('i');
  const stageEl = $('boot-stage');
  const pctEl = $('boot-pct');
  let failed = false;

  const api = {
    /** Name the current startup step, e.g. 'BINDING PARTS'. */
    stage(text, detail = '') {
      if (failed || !stageEl) return;
      stageEl.textContent = text;
      if (pctEl) pctEl.textContent = detail;
    },

    /**
     * Report download progress. Pass a falsy `total` when the server sends no
     * Content-Length — the bar sweeps instead of sitting frozen at zero.
     */
    progress(loaded, total) {
      if (failed || !bar) return;
      if (!total) {
        bar.classList.add('indeterminate');
        if (pctEl) pctEl.textContent = fmtMB(loaded);
        return;
      }
      bar.classList.remove('indeterminate');
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = `${fmtMB(loaded)} / ${fmtMB(total)}`;
    },

    /** Fade the overlay out. Safe to call more than once. */
    done() {
      if (failed || !root) return;
      bar?.classList.remove('indeterminate');
      if (fill) fill.style.width = '100%';
      root.classList.add('done');
      root.setAttribute('aria-hidden', 'true');
    },

    /** Replace the overlay with a readable failure report and keep it on screen. */
    fail(step, err) {
      failed = true;
      console.error('[boot]', step, err);
      if (!root) return;
      root.classList.remove('done');
      root.classList.add('failed');
      root.setAttribute('aria-hidden', 'false');
      if (stageEl) stageEl.textContent = 'BOOT FAILED';
      if (pctEl) pctEl.textContent = step;
      bar?.classList.remove('indeterminate');
      if (fill) fill.style.width = '100%';
      const note = root.querySelector('.boot-note');
      if (note) {
        note.className = 'boot-trace';
        note.textContent = (err?.message ?? String(err))
          + (err?.stack ? '\n\n' + err.stack.split('\n').slice(0, 4).join('\n') : '')
          + '\n\nOpen the browser console for the full trace.'
          + '\nES modules need an HTTP server — run start.bat or `python serve.py`,'
          + '\nnot a file:// URL.';
      }
    },
  };
  return api;
}

/**
 * Fetch a binary asset, reporting bytes as they arrive.
 *
 * Streams through the response body when the browser exposes it; otherwise it
 * falls back to a plain buffered read, which still resolves, just without a
 * moving bar. `onProgress(loaded, total)` gets total = 0 when the server sends
 * no Content-Length (a gzipped response, typically).
 */
export async function fetchArrayBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const total = Number(res.headers.get('Content-Length')) || 0;

  if (!res.body?.getReader || typeof onProgress !== 'function') {
    return res.arrayBuffer();
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}
