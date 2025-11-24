/**
 * Google Meet dual-display (wired only: USB-C & HDMI) with auto-detected SourceIds
 * - While sharing to the meeting (LocalRemote) in a Google Meet call,
 *   pin the actual wired source (USB-C or HDMI) to Output 2 via Video Matrix.
 * - Preserves LocalOnly (preview) behavior.
 * - Auto-discovers SourceIds from Status.Video.Input.Connector by matching Type:
 *     - USB-C: Type contains "USBC-DP" / "USBC" / "USB-C"
 *     - HDMI : Type contains "HDMI"
 */

import xapi from 'xapi';

// ====== Adjust if needed ======
const OUTPUT2_ID = 2;     // HDMI 2 (second monitor)
const DEBUG      = true;  // set false to quiet logs
// ==============================

// Dynamic list of input SourceIds we consider "wired laptop" sources
let ALLOWED_SOURCE_IDS = [];  // populated at init from connector Type

let googleCallActive   = false;
let matrixEngaged      = false;
let lastMatrixSourceId = null;

// Debounce / lock / log de-dupe
let debounceTimer = null;
let reevaluating  = false;
let lastEvalSig   = '';

function log(...a){ if (DEBUG) console.log('[gm-wired-autodetect]', ...a); }

// ---------- Discovery: read connectors and build ALLOWED_SOURCE_IDS ----------
function normalizeType(s=''){
  return String(s).trim().toUpperCase();
}

function parseConnectorId(obj){
  // The xAPI JS SDK usually provides .id for indexed lists
  const candidates = [obj?.id, obj?.ConnectorId, obj?.Connector, obj?.Number, obj?.Instance];
  for (const v of candidates){
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function refreshAllowedSourcesFromConnectors(){
  try {
    const connectors = await xapi.Status.Video.Input.Connector.get();
    const list = Array.isArray(connectors) ? connectors : (connectors ? [connectors] : []);
    const usbMatchers  = ['USBC-DP', 'USBC', 'USB-C', 'USB C', 'USB TYPE-C'];
    const hdmiMatchers = ['HDMI'];

    const found = new Set();

    for (const c of list){
      const id = parseInt(parseConnectorId(c), 10);
      if (!Number.isFinite(id)) continue;
      const t  = normalizeType(c.Type);
      const isUSBc = usbMatchers.some(m => t.includes(m));
      const isHDMI = hdmiMatchers.some(m => t.includes(m));
      if (isUSBc || isHDMI){
        // On RoomOS endpoints the SourceId matches the connector index.
        found.add(id);
        log(`discovered connector id ${id} type=${t}`);
      }
    }

    ALLOWED_SOURCE_IDS = [...found].sort((a,b)=>a-b);

    if (ALLOWED_SOURCE_IDS.length === 0){
      // Safe fallback in case the device returns unexpected Type strings
      ALLOWED_SOURCE_IDS = [2, 3];
      log('WARNING: no wired connectors detected from Type; falling back to [2,3]');
    } else {
      log('ALLOWED_SOURCE_IDS =', ALLOWED_SOURCE_IDS.join(', '));
    }
  } catch (e){
    // On error, keep previous list or fallback
    if (ALLOWED_SOURCE_IDS.length === 0) ALLOWED_SOURCE_IDS = [2,3];
    log('refreshAllowedSourcesFromConnectors error; using', ALLOWED_SOURCE_IDS, e);
  }
}

// ---------- Call & presentation state ----------
function looksLikeGoogle(candidate='') {
  const s = String(candidate).trim().toLowerCase().replace(/^\w+:\/\//, '');
  return s.startsWith('meet.google.com/');
}

async function refreshGoogleState(){
  try {
    const calls = await xapi.Status.Call.get();
    const list  = Array.isArray(calls) ? calls : (calls ? [calls] : []);
    googleCallActive = list.some(c => {
      const cand = (c.CallbackURI || c.CallbackNumber || c.RemoteURI || c.DisplayName || '').toString();
      return looksLikeGoogle(cand);
    });
    log('googleCallActive =', googleCallActive);
  } catch (e) {
    log('refreshGoogleState error', e);
    googleCallActive = false;
  }
}

// Only when actually sending to far end (not local preview)
async function isSharingToRemote(){
  try {
    const inst = await xapi.Status.Conference.Presentation.LocalInstance.get();
    const list = Array.isArray(inst) ? inst : (inst ? [inst] : []);
    return list.some(i => String(i.SendingMode || '') === 'LocalRemote');
  } catch (e) {
    log('isSharingToRemote error', e);
    return false;
  }
}

function normalizeIds(src){
  const arr  = Array.isArray(src) ? src : (src ? [src] : []);
  const nums = arr.map(v => parseInt(v, 10)).filter(Number.isFinite);
  return [...new Set(nums)];
}

async function getLocalPresentationSourceIds(){
  try {
    const inst = await xapi.Status.Conference.Presentation.LocalInstance.get();
    const list = Array.isArray(inst) ? inst : (inst ? [inst] : []);
    const ids = [];
    for (const i of list) {
      const raw = (i.Source !== undefined) ? i.Source : i.SourceId; // handle both keys
      ids.push(...normalizeIds(raw));
    }
    return [...new Set(ids)].sort((a,b)=>a-b);
  } catch (e){
    log('getLocalPresentationSourceIds error', e);
    return [];
  }
}

function pickRelevantSourceId(activeIds){
  // Filter to auto-discovered wired IDs (USB-C/HDMI)
  const candidates = activeIds.filter(id => ALLOWED_SOURCE_IDS.includes(id));
  if (candidates.length === 0) return null;
  if (lastMatrixSourceId && candidates.includes(lastMatrixSourceId)) return lastMatrixSourceId; // avoid flicker
  return candidates[candidates.length - 1]; // "latest" heuristic
}

// ---------- Matrix routing ----------
async function assignToOutput2(sourceId){
  try {
    await xapi.Command.Video.Matrix.Assign({
      Output: OUTPUT2_ID,
      Mode: 'Replace',
      SourceId: sourceId,
    });
    matrixEngaged = true;
    lastMatrixSourceId = sourceId;
    log(`Matrix ASSIGN: Output ${OUTPUT2_ID} <- Source ${sourceId}`);
  } catch (e) {
    log('Matrix.Assign failed', e);
  }
}

async function resetOutput2(){
  if (!matrixEngaged) return;
  try {
    await xapi.Command.Video.Matrix.Reset({ Output: OUTPUT2_ID });
    matrixEngaged = false;
    lastMatrixSourceId = null;
    log(`Matrix RESET: Output ${OUTPUT2_ID}`);
  } catch (e) {
    log('Matrix.Reset failed', e);
  }
}

// ---------- Debounced reevaluate ----------
function scheduleReevaluate(reason){
  if (DEBUG) log('scheduleReevaluate:', reason);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    reevaluate().catch(err => log('reevaluate error', err));
  }, 80);
}

async function reevaluate(){
  if (reevaluating) { if (DEBUG) log('skip: reevaluate in flight'); return; }
  reevaluating = true;
  try {
    const remote = await isSharingToRemote();

    const sig = `${Number(googleCallActive)}-${Number(remote)}-${Number(matrixEngaged)}-${lastMatrixSourceId ?? 'null'}`;
    if (sig !== lastEvalSig) {
      log('Reevaluate -> google:', googleCallActive, 'remoteShare:', remote, 'engaged:', matrixEngaged);
      lastEvalSig = sig;
    }

    if (googleCallActive && remote){
      // Ensure allowed sources are known (in case device rebooted / config changed)
      if (ALLOWED_SOURCE_IDS.length === 0) await refreshAllowedSourcesFromConnectors();

      const activeIds = await getLocalPresentationSourceIds();
      const chosen    = pickRelevantSourceId(activeIds);

      if (chosen == null) { await resetOutput2(); return; } // not a wired source
      if (!matrixEngaged || lastMatrixSourceId !== chosen){
        await assignToOutput2(chosen);
      }
    } else {
      await resetOutput2();
    }
  } finally {
    reevaluating = false;
  }
}

// ---------- Event wiring ----------
xapi.Event.PresentationStarted.on(async ev => { log('Event.PresentationStarted', ev); await refreshGoogleState(); scheduleReevaluate('PresentationStarted'); });
xapi.Event.PresentationStopped.on(async ev => { log('Event.PresentationStopped', ev); scheduleReevaluate('PresentationStopped'); });

xapi.Status.Conference.Presentation.Mode.on(async mode => { log('Presentation.Mode ->', mode); scheduleReevaluate('ModeChanged'); });

xapi.Event.CallSuccessful.on(async () => { log('Event.CallSuccessful'); await refreshGoogleState(); scheduleReevaluate('CallSuccessful'); });
xapi.Event.CallDisconnect.on(async () => { log('Event.CallDisconnect'); googleCallActive = false; scheduleReevaluate('CallDisconnect'); });

// Optional: if you want dynamic re-detection when cabling or firmware changes expose new connectors,
// you can listen to connector status changes and refresh the allowed list.
// xapi.Status.Video.Input.Connector.on(async () => { await refreshAllowedSourcesFromConnectors(); });

// ---------- Init ----------
(async function init(){
  log('Macro init (wired autodetect)…');
  await refreshAllowedSourcesFromConnectors(); // learn wired SourceIds (USB-C / HDMI)
  await refreshGoogleState();
  await resetOutput2(); // start clean so local preview is native
})();

