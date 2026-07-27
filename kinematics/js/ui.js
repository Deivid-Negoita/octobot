// ui.js — panels, lists, telemetry, io
import { bendAngleAt } from './solver.js';
import { loadFromURL } from './loader.js';
import { createBoot } from './boot.js';
import { GAITS } from './gait.js';
import {
  setMode, setActiveChain, selectJoint,
  rebaselineCollisions, maybeRigOctobot, gaitBodyModel, setRigVisible,
  frameModel,
} from './main.js';

const $ = id => document.getElementById(id);
const hex = c => '#' + c.toString(16).padStart(6, '0');
const fmt = (v, d = 2) => (v < 0 ? '' : '+') + v.toFixed(d);
const fmtV = v => `${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`;

export function initUI(App) {
  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ------------------------------------------------ topbar

  $('btn-mode-build').addEventListener('click', () => setMode('build'));
  $('btn-mode-solve').addEventListener('click', () => setMode('solve'));

  const helpModal = $('help-modal');
  function setHelp(open) {
    helpModal.classList.toggle('open', open);
    if (open) $('help-close').focus();
    else $('btn-help').focus();
  }
  $('btn-help').addEventListener('click', () => setHelp(!helpModal.classList.contains('open')));
  $('help-close').addEventListener('click', () => setHelp(false));
  // clicking the dimmed backdrop dismisses; clicking the card itself must not
  helpModal.addEventListener('mousedown', e => { if (e.target === helpModal) setHelp(false); });

  // the sidebar overlaps the model on narrow screens, so it has to be dismissible
  const sidebar = $('sidebar');
  function togglePanels() {
    const collapsed = sidebar.classList.toggle('collapsed');
    $('btn-panels').setAttribute('aria-expanded', String(!collapsed));
    $('btn-panels').classList.toggle('on', collapsed);
  }
  $('btn-panels').addEventListener('click', togglePanels);
  App.togglePanels = togglePanels;

  $('btn-export').addEventListener('click', () => {
    const data = { version: 1, app: 'ik-workbench', chains: App.chains.map(c => c.toJSON()) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ik-rig.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('rig exported');
  });

  // ------------------------------------------------ legs panel

  const selectedJointData = () => {
    const sel = App.selectedJoint;
    return sel ? { sel, j: sel.chain.joints[sel.index] } : null;
  };

  $('inp-bend').addEventListener('input', e => {
    const d = selectedJointData();
    if (!d) return;
    const v = parseInt(e.target.value, 10);
    d.j.maxBend = v;
    $('val-bend').textContent = v >= 180 ? 'FREE' : v + '°';
    d.sel.chain.targetDirty = true;
  });

  $('sel-joint-type').addEventListener('change', e => {
    const d = selectedJointData();
    if (!d) return;
    const v = e.target.value;
    if (v === 'ball') {
      d.j.type = 'ball';
    } else {
      d.j.type = 'hinge';
      d.j.hingePreset = v;
      if (v === 'h180') d.j.hingeRange = 180;
      else if (v === 'h360') d.j.hingeRange = 360;
    }
    d.sel.chain.targetDirty = true;
    d.sel.chain.setSelectedJoint(d.sel.index); // refresh axis indicator
    refreshInspector();
    refreshJointList();
  });

  for (const btn of document.querySelectorAll('#seg-axis button')) {
    btn.addEventListener('click', () => {
      const d = selectedJointData();
      if (!d) return;
      d.j.hingeAxis = btn.dataset.axis;
      delete d.j.axisVec; // picking a preset overrides an auto-rig custom axis
      d.sel.chain.targetDirty = true;
      d.sel.chain.setSelectedJoint(d.sel.index);
      refreshInspector();
    });
  }

  $('inp-range').addEventListener('input', e => {
    const d = selectedJointData();
    if (!d) return;
    d.j.hingeRange = parseInt(e.target.value, 10);
    $('val-range').textContent = d.j.hingeRange + '°';
    d.sel.chain.targetDirty = true;
  });

  function refreshChainList() {
    const list = $('chain-list');
    list.innerHTML = '';
    for (const c of App.chains) {
      const row = document.createElement('div');
      row.className = 'row chain-row' + (c === App.activeChain ? ' active' : '');
      row.innerHTML = `
        <span class="dot" style="background:${hex(c.color)}"></span>
        <span class="grow">${c.name}</span>
        <span class="dim">${c.joints.length}J</span>
        <button class="mini" title="toggle visibility">${c.visible ? '◉' : '◌'}</button>`;
      row.addEventListener('click', () => setActiveChain(c));
      const visBtn = row.querySelector('button');
      visBtn.addEventListener('click', e => { e.stopPropagation(); c.setVisible(!c.visible); refreshChainList(); });
      list.appendChild(row);
    }
    if (!App.chains.length) list.innerHTML = '<div class="empty">loading the octobot…</div>';
  }

  // per-joint rotation readout: signed servo angle for hinges, bend for balls
  function jointAngleText(c, i) {
    if (i >= c.joints.length - 1) return '';
    const j = c.joints[i];
    if (j.type === 'hinge') {
      let a = c.signedHingeAngle(i);
      if (Math.abs(a) < 0.05) a = 0; // avoid "-0.0°"
      return (a >= 0 ? '+' : '') + a.toFixed(1) + '°';
    }
    if (i === 0) return '';
    return bendAngleAt(c.points, i).toFixed(1) + '°';
  }

  let jointRows = [];
  function refreshJointList() {
    const list = $('joint-list');
    list.innerHTML = '';
    jointRows = [];
    const c = App.activeChain;
    if (!c || !c.joints.length) {
      list.innerHTML = '<div class="empty">select a leg</div>';
      return;
    }
    c.joints.forEach((j, i) => {
      const row = document.createElement('div');
      const selected = App.selectedJoint?.chain === c && App.selectedJoint.index === i;
      row.className = 'row joint-row' + (selected ? ' active' : '');
      const tag = i === 0 ? 'ROOT' : (i === c.joints.length - 1 ? 'EE' : 'J' + i);
      row.innerHTML = `
        <span class="jtag">${tag}</span>
        <span class="jpos mono"></span>
        <span class="jang mono"></span>`;
      row.addEventListener('click', () => selectJoint({ chain: c, index: i }));
      list.appendChild(row);
      const posEl = row.querySelector('.jpos');
      const angEl = row.querySelector('.jang');
      angEl.classList.toggle('hinge', j.type === 'hinge');
      posEl.textContent = fmtV(j.pos);
      angEl.textContent = jointAngleText(c, i);
      jointRows.push({ posEl, angEl, index: i });
    });
  }

  function softRefreshJoints() {
    const c = App.activeChain;
    if (!c || jointRows.length !== c.joints.length) { refreshJointList(); return; }
    for (const r of jointRows) {
      r.posEl.textContent = fmtV(c.joints[r.index].pos);
      r.angEl.textContent = jointAngleText(c, r.index);
    }
  }

  function refreshInspector() {
    const sel = App.selectedJoint;
    const box = $('joint-inspector');
    if (!sel) { box.classList.add('disabled'); return; }
    box.classList.remove('disabled');
    const c = sel.chain;
    const j = c.joints[sel.index];
    const isEE = sel.index === c.joints.length - 1;
    const hint = $('inspector-hint');
    if (isEE) {
      // end effector: no outgoing bone to constrain — hide controls, keep hint
      $('row-bend').classList.add('hidden');
      $('row-axis').classList.add('hidden');
      $('row-range').classList.add('hidden');
      $('sel-joint-type').parentElement.classList.add('hidden');
      hint.textContent = 'end effector — constraints apply to joints with an outgoing bone';
      return;
    }
    $('sel-joint-type').parentElement.classList.remove('hidden');
    const isHinge = j.type === 'hinge';
    $('sel-joint-type').value = isHinge ? (j.hingePreset ?? 'hcustom') : 'ball';
    $('row-bend').classList.toggle('hidden', isHinge);
    $('row-axis').classList.toggle('hidden', !isHinge);
    $('row-range').classList.toggle('hidden', !(isHinge && j.hingePreset === 'hcustom'));
    $('inp-bend').value = j.maxBend;
    $('val-bend').textContent = j.maxBend >= 180 ? 'FREE' : j.maxBend + '°';
    $('inp-range').value = j.hingeRange;
    $('val-range').textContent = j.hingeRange + '°';
    for (const b of document.querySelectorAll('#seg-axis button')) {
      const on = !j.axisVec && b.dataset.axis === j.hingeAxis;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (isHinge && j.axisVec) {
      hint.textContent = 'auto-rig leg-frame axis · pick X/Y/Z to override';
    } else if (isHinge) {
      hint.textContent = 'FABRIK only · sweeps around the axis, centered on the rest (build) pose';
    } else {
      hint.textContent = sel.index === 0
        ? 'cone limit has no effect on the root — use HINGE for a constrained base'
        : 'FABRIK only · limits bend vs previous segment';
    }
  }

  // ------------------------------------------------ solver panel

  $('sel-solver').addEventListener('change', e => {
    if (App.activeChain) { App.activeChain.solver = e.target.value; App.activeChain.targetDirty = true; }
  });
  $('inp-iterations').addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    $('val-iterations').textContent = v;
    if (App.activeChain) { App.activeChain.iterations = v; App.activeChain.targetDirty = true; }
  });
  $('inp-tolerance').addEventListener('input', e => {
    const v = Math.pow(10, parseFloat(e.target.value)); // log slider: -4 .. -1
    $('val-tolerance').textContent = v.toExponential(0);
    if (App.activeChain) { App.activeChain.tolerance = v; App.activeChain.targetDirty = true; }
  });

  function refreshSolver() {
    const c = App.activeChain;
    if (!c) return;
    $('sel-solver').value = c.solver;
    $('inp-iterations').value = c.iterations;
    $('val-iterations').textContent = c.iterations;
    $('inp-tolerance').value = Math.log10(c.tolerance);
    $('val-tolerance').textContent = c.tolerance.toExponential(0);
  }

  // collision guard toggles
  for (const [id, key] of [['chk-col-models', 'models'], ['chk-col-self', 'self'], ['chk-col-floor', 'floor']]) {
    $(id).checked = App.collisionOpts[key];
    $(id).addEventListener('change', e => {
      App.collisionOpts[key] = e.target.checked;
      rebaselineCollisions(); // current pose becomes the new baseline
    });
  }

  // ------------------------------------------------ gait panel

  const selGait = $('sel-gait');
  for (const [k, g] of Object.entries(GAITS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = g.label;
    selGait.appendChild(o);
  }
  selGait.addEventListener('change', e => { App.gait.gait = e.target.value; });
  $('sel-heading').addEventListener('change', e => {
    const [x, y, z] = e.target.value.split(',').map(Number);
    const wasWalking = App.gait.active;
    if (wasWalking) App.gait.stop();
    App.gait.dir.set(x, y, z);
    if (wasWalking) {
      const legs = App.chains.filter(c => c.joints.length >= 2 && c.visible);
      App.gait.start(legs, gaitBodyModel());
    }
  });
  $('inp-cycle').addEventListener('input', e => {
    App.gait.cycleTime = parseFloat(e.target.value);
    $('val-cycle').textContent = App.gait.cycleTime.toFixed(1) + 's';
  });
  $('inp-stride').addEventListener('input', e => {
    App.gait.stride = parseFloat(e.target.value);
    $('val-stride').textContent = App.gait.stride.toFixed(2);
  });
  $('inp-lift').addEventListener('input', e => {
    App.gait.lift = parseFloat(e.target.value);
    $('val-lift').textContent = App.gait.lift.toFixed(2);
  });
  $('chk-show-rig').addEventListener('change', e => setRigVisible(e.target.checked));

  function syncGaitInputs() {
    $('inp-stride').value = App.gait.stride;
    $('val-stride').textContent = App.gait.stride.toFixed(2);
    $('inp-lift').value = App.gait.lift;
    $('val-lift').textContent = App.gait.lift.toFixed(2);
  }

  function updateWalkButton() {
    $('btn-walk').textContent = App.gait.active ? '❚❚ WALKING' : '▶ WALK';
    $('btn-walk').classList.toggle('playing', App.gait.active);
  }
  function toggleWalk() {
    if (App.gait.active) {
      App.gait.stop();
      if (App.mode === 'solve') setMode('solve'); // re-attach target gizmo
    } else {
      const legs = App.chains.filter(c => c.joints.length >= 2 && c.visible);
      if (legs.length < 2) { toast('the octobot is still loading', true); return; }
      App.tcontrols.detach();
      if (!App.gait.start(legs, gaitBodyModel())) {
        toast('could not start gait', true);
        return;
      }
      toast('walking — ' + GAITS[App.gait.gait].label);
    }
    updateWalkButton();
  }
  $('btn-walk').addEventListener('click', toggleWalk);
  $('btn-walk-stop').addEventListener('click', () => {
    if (App.gait.active) toggleWalk();
  });

  // ------------------------------------------------ the octobot

  // This workbench only ever holds one model: the octobot, loaded and auto-rigged
  // on startup. There is no import, no library and no second model to manage.
  const boot = createBoot();

  function onOctobotLoaded(model) {
    boot.stage('BUILDING RIG');
    App.scene.add(model.group);
    App.models.push(model);
    let rig;
    try {
      rig = maybeRigOctobot(model);
    } catch (err) {
      boot.fail('maybeRigOctobot', err);
      return;
    }
    frameModel(model.group);
    boot.done();
    if (rig) {
      toast(`octobot rigged — ${rig.legs} legs, ${rig.bound?.legs ?? 0} parts bound · press ▶ WALK`);
    } else {
      toast('octobot loaded but could not be rigged', true);
    }
  }

  loadFromURL(
    'models/octobot.glb',
    onOctobotLoaded,
    (name, err) => boot.fail(`loading ${name}`, err),
    (loaded, total) => {
      boot.progress(loaded, total);
      // the GLTF parse happens once the last byte lands, and it is not instant
      if (total && loaded >= total) boot.stage('PARSING MESH');
    },
  );

  // ------------------------------------------------ telemetry

  let telemetryTimer = 0;
  let lastStatusKey = '';
  function updateStatus(c) {
    const el = $('t-status');
    const status = c ? c.status : 'ok';
    el.classList.remove('ok', 'reach', 'collision');
    if (status === 'collision') {
      const reasons = [...(c.collision?.reasons ?? [])].join(', ');
      el.textContent = 'COLLISION';
      el.title = 'blocked by: ' + reasons;
      el.classList.add('collision');
    } else if (status === 'reach') {
      el.textContent = 'OUT OF REACH';
      el.title = 'target beyond total chain length';
      el.classList.add('reach');
    } else {
      el.textContent = 'OK';
      el.title = '';
      el.classList.add('ok');
    }
    // toast once per status transition
    const key = c ? c.name + ':' + status : '';
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      if (status === 'collision') {
        const reasons = [...(c.collision?.reasons ?? [])].join(', ');
        toast('⚠ TARGET BLOCKED — collision with: ' + (reasons || 'obstacle'), true);
      } else if (status === 'reach') {
        toast('target out of reach — arm fully extended', true);
      }
    }
  }

  function updateTelemetry(dt) {
    telemetryTimer += dt;
    if (telemetryTimer < 0.12) return;
    telemetryTimer = 0;
    const c = App.activeChain;
    $('t-fps').textContent = App.fps;
    if (!c || c.joints.length < 2) {
      $('t-ee').textContent = '—'; $('t-target').textContent = '—';
      $('t-err').textContent = '—'; $('t-iter').textContent = '—'; $('t-ms').textContent = '—';
      updateStatus(null);
      return;
    }
    $('t-ee').textContent = fmtV(c.endEffector);
    $('t-target').textContent = fmtV(c.target);
    $('t-err').textContent = (c.lastStats.error * 1000).toFixed(1) + ' mm';
    $('t-iter').textContent = c.lastStats.iterations;
    $('t-ms').textContent = c.lastStats.ms.toFixed(2) + ' ms';
    $('t-err').classList.toggle('bad', c.lastStats.error > c.tolerance * 5 + 1e-9);
    updateStatus(c);
    if (App.gait.active || App.tcontrols.dragging) softRefreshJoints();
  }

  // ------------------------------------------------ mode indicator

  function onModeChanged() {
    for (const [id, mode] of [['btn-mode-build', 'build'], ['btn-mode-solve', 'solve']]) {
      const on = App.mode === mode;
      $(id).classList.toggle('on', on);
      $(id).setAttribute('aria-pressed', String(on));
    }
    $('t-mode').textContent = App.mode.toUpperCase();
  }

  function refreshAll() {
    refreshChainList();
    refreshJointList();
    refreshInspector();
    refreshSolver();
    onModeChanged();
    updateWalkButton();
    $('t-chain').textContent = App.activeChain ? App.activeChain.name : '—';
  }

  const helpOpen = () => helpModal.classList.contains('open');

  return {
    refreshAll, softRefreshJoints, onModeChanged, updateTelemetry, toast, toggleWalk, syncGaitInputs,
    helpOpen, toggleHelp: () => setHelp(!helpOpen()), closeHelp: () => setHelp(false),
  };
}
