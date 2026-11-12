// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Keeping the PC awake while QuorX works. A laptop that goes to sleep in the middle of a long build stops the reply
// (and the servers and commands it started). So while a reply (a scheduled chat's included) or a command runs, the
// desktop app asks Windows not to sleep ('prevent-app-suspension': the screen can still turn off), and lets go the
// moment all of it is done. A server left running on its own does not count: it would keep the PC awake for good.
//
// On by default, with that "only while something works" rule; ⚙ Settings → About → Desktop app switches it off.
// To make it off by default instead, set KEEP_AWAKE_DEFAULT to false (a choice made in Settings stays either way).

const KEEP_AWAKE_DEFAULT = true;
const POLL_MS = 5000; // how often main.js asks the harness what is working

/** The setting, from the desktop app's config.json ({ keepAwake: true | false }; missing = the default). */
const keepAwakeOn = (cfg) => (typeof cfg?.keepAwake === 'boolean' ? cfg.keepAwake : KEEP_AWAKE_DEFAULT);

/** busy: what the harness says works now ({ replies, servers, commands }, or null when it can't be asked). */
const wantAwake = (busy, on = KEEP_AWAKE_DEFAULT) => !!on && !!busy && ((busy.replies?.length || 0) + (busy.commands?.length || 0)) > 0;

/**
 * Holds and lets go of one power blocker. psb: Electron's powerSaveBlocker (or a stand-in in tests).
 * set(true) starts it once; set(false) stops it; asking again for what is already so does nothing.
 */
function createAwake(psb) {
  let id = null;
  return {
    set(want) {
      if (want && id == null) id = psb.start('prevent-app-suspension');
      else if (!want && id != null) { try { if (psb.isStarted(id)) psb.stop(id); } catch { /* already gone */ } id = null; }
      return id != null;
    },
    get held() { return id != null; },
  };
}

module.exports = { KEEP_AWAKE_DEFAULT, POLL_MS, keepAwakeOn, wantAwake, createAwake };
