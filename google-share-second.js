/**
 * Google Meet dual-display (dynamic USB-C or HDMI)
 * - Shows the *same* presentation locally on HDMI 2 while sharing to the meeting (LocalRemote)
 * - Preserves local preview (LocalOnly)
 */

import xapi from 'xapi';

// ====== Adjust if needed ======
const OUTPUT2_ID        = 2;   // HDMI 2 (second monitor)
const USB_C_SOURCE_ID   = 2;   // USB-C laptop ingest
const HDMI_SOURCE_ID    = 3;   // HDMI laptop ingest
const DEBUG             = true;
// ==============================

const ALLOWED_SOURCE_IDS = [USB_C_SOURCE_ID, HDMI_SOURCE_ID];

let googleCallActive   = false;
let matrixEngaged      = false;
let lastMatrixSourceId = null;

// Debounce/lock/log-dedupe
let debounceTimer = null;
let reevaluating  = false;
let lastEvalSig   = '';

function log(...a){ if (DEBUG) console.log('[gm-usbc-or-hdmi]', ...a); }

// ---- Helpers ----
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

// True ONLY when device is sending presentation to far end (not local preview)
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

// Collect actual presentation source id(s)
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
  } catch (e) {
    log('getLocalPresentationSourceIds error', e);
    return [];
  }
}

function pickRelevantSourceId(activeIds){
  const candidates = activeIds.filter(id => ALLOWED_SOURCE_IDS.includes(id));
  if (candidates.length === 0) return null;
  if (lastMatrixSourceId && candidates.includes(lastMatrixSourceId)) return lastMatrixSourceId;
  return candidates[candidates.length - 1];
}

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
  // Only reset if currently engaged, to avoid redundant logs
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

function scheduleReevaluate(reason){
  if (DEBUG) log('scheduleReevaluate:', reason);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    reevaluate().catch(err => log('reevaluate error', err));
  }, 80); // small delay to coalesce event bursts
}

async function reevaluate(){
  if (reevaluating) {
    if (DEBUG) log('skip: reevaluate in flight');
    return;
  }
  reevaluating = true;
  try {
    const remote = await isSharingToRemote();

    // Log only when state "signature" changes
    const sig = `${Number(googleCallActive)}-${Number(remote)}-${Number(matrixEngaged)}-${lastMatrixSourceId ?? 'null'}`;
    if (sig !== lastEvalSig) {
      log('Reevaluate -> google:', googleCallActive, 'remoteShare:', remote, 'engaged:', matrixEngaged);
      lastEvalSig = sig;
    }

    if (googleCallActive && remote){
      const activeIds = await getLocalPresentationSourceIds();
      const chosen    = pickRelevantSourceId(activeIds);
      if (chosen == null) {
        // Not USB-C/HDMI; ensure we’re not pinning anything
        await resetOutput2();
        return;
      }
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

// ---- Event wiring (debounced) ----
xapi.Event.PresentationStarted.on(async ev => { log('Event.PresentationStarted', ev); await refreshGoogleState(); scheduleReevaluate('PresentationStarted'); });
xapi.Event.PresentationStopped.on(async ev => { log('Event.PresentationStopped', ev); scheduleReevaluate('PresentationStopped'); });

xapi.Status.Conference.Presentation.Mode.on(async mode => { log('Presentation.Mode ->', mode); scheduleReevaluate('ModeChanged'); });

xapi.Event.CallSuccessful.on(async () => { log('Event.CallSuccessful'); await refreshGoogleState(); scheduleReevaluate('CallSuccessful'); });

// IMPORTANT: don’t hard reset here; let reevaluate handle it to avoid duplicates
xapi.Event.CallDisconnect.on(async () => { log('Event.CallDisconnect'); googleCallActive = false; scheduleReevaluate('CallDisconnect'); });

// ---- Init ----
(async function init(){
  log('Macro init (USB-C or HDMI, debounced)…');
  await refreshGoogleState();
  await resetOutput2(); // start clean
})();