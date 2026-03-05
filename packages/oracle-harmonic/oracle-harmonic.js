/**
 * ORACLE-HARMONIC MODULE
 * ============================================================
 * Shared cog for: Sim3Colts, Retro Ruliad Billiards
 *
 * Provides:
 *   - 0 Ping Oracle: P2P provenance chain via BroadcastChannel
 *   - Harmonic Sunrise: Audio-driven Player 2 engine
 *   - Ghost prediction: Game-agnostic state extrapolation
 *
 * No server. No encryption. First block wins.
 * ============================================================
 */

const OracleHarmonic = (() => {

  // ----------------------------------------------------------
  // INTERNAL STATE
  // ----------------------------------------------------------

  let _instanceId = null;
  let _gameId = null;
  let _channel = null;
  let _chain = [];           // local copy of the shared chain
  let _blockHeight = 0;
  let _playerHistories = {}; // playerId -> last N event snapshots
  const HISTORY_DEPTH = 30;

  // Harmonic
  let _audioCtx = null;
  let _analyser = null;
  let _dataArray = null;
  let _micActive = false;
  let _audioState = { amplitude: 0, bass: 0, mid: 0, treble: 0, dominant: 0 };
  let _p2Threshold = 0.55;
  let _p2Cooldown = 0;
  let _p2CooldownFrames = 80;

  // Callbacks
  let _onEventCb = null;
  let _onP2TriggerCb = null;
  let _onReconnectCb = null;

  // Simulation mode (no mic)
  let _simPhase = 0;
  let _simActive = false;


  // ----------------------------------------------------------
  // UTILITIES
  // ----------------------------------------------------------

  /**
   * Deterministic hash of an event for tiebreaking.
   * XOR-folds instanceId + timestamp + type + JSON data.
   */
  function _hashEvent(evt) {
    const str = `${evt.instanceId}|${evt.timestamp}|${evt.type}|${JSON.stringify(evt.data)}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h;
  }

  /**
   * Compare two events for provenance ordering.
   * Returns -1 if a is first, 1 if b is first, 0 if identical.
   */
  function _compareProvenance(a, b) {
    if (a.block !== b.block) return a.block - b.block;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    // Tiebreak: lower hash wins (deterministic across all tabs)
    return _hashEvent(a) - _hashEvent(b);
  }


  // ----------------------------------------------------------
  // CHAIN
  // ----------------------------------------------------------

  function _appendToChain(evt) {
    _chain.push(evt);
    // Keep chain bounded — older than 500 blocks can be pruned
    if (_chain.length > 500) _chain.shift();

    // Update player history for ghost prediction
    if (evt.playerId) {
      if (!_playerHistories[evt.playerId]) _playerHistories[evt.playerId] = [];
      _playerHistories[evt.playerId].push({
        timestamp: evt.timestamp,
        block: evt.block,
        type: evt.type,
        data: evt.data
      });
      if (_playerHistories[evt.playerId].length > HISTORY_DEPTH) {
        _playerHistories[evt.playerId].shift();
      }
    }
  }


  // ----------------------------------------------------------
  // BROADCAST CHANNEL (P2P between tabs)
  // ----------------------------------------------------------

  function _initChannel() {
    _channel = new BroadcastChannel(`oracle-harmonic:${_gameId}`);

    _channel.onmessage = (msg) => {
      const { type, payload } = msg.data;

      if (type === 'EVENT') {
        _appendToChain(payload);
        if (_onEventCb) _onEventCb(payload);
      }

      if (type === 'RECONNECT_REQUEST') {
        // A tab came back online — send it our chain state
        _channel.postMessage({
          type: 'RECONNECT_RESPONSE',
          payload: {
            toInstanceId: payload.instanceId,
            chain: _chain.slice(-100), // send last 100 blocks
            blockHeight: _blockHeight
          }
        });
      }

      if (type === 'RECONNECT_RESPONSE') {
        if (payload.toInstanceId !== _instanceId) return;
        // Merge incoming chain — insert any blocks we're missing
        payload.chain.forEach(evt => {
          const exists = _chain.some(e => e.block === evt.block && e.instanceId === evt.instanceId);
          if (!exists) _appendToChain(evt);
        });
        // Sync block height to highest known
        if (payload.blockHeight > _blockHeight) _blockHeight = payload.blockHeight;
        _chain.sort(_compareProvenance);
        if (_onReconnectCb) _onReconnectCb(_chain.length);
      }
    };
  }


  // ----------------------------------------------------------
  // PUBLIC: INIT
  // ----------------------------------------------------------

  /**
   * @param {string} gameId     - e.g. 'sim3colts' or 'retro-ruliad'
   * @param {string} instanceId - unique per tab, e.g. crypto.randomUUID()
   */
  function init(gameId, instanceId) {
    _gameId = gameId;
    _instanceId = instanceId || (
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    );
    _initChannel();
  }


  // ----------------------------------------------------------
  // PUBLIC: BROADCAST
  // ----------------------------------------------------------

  /**
   * Write a provenance event to the chain and broadcast to all tabs.
   *
   * @param {string} type      - e.g. 'POCKET', 'TELEPORT', 'P2_SHOT'
   * @param {string} playerId  - e.g. 'p1', 'p2', 'colt0'
   * @param {object} data      - game-specific payload (coordinates, velocity, etc.)
   * @returns {object}         - the event that was written
   */
  function broadcast(type, playerId, data = {}) {
    _blockHeight++;
    const evt = {
      block:      _blockHeight,
      timestamp:  performance.now(),
      instanceId: _instanceId,
      gameId:     _gameId,
      playerId,
      type,
      data
    };

    _appendToChain(evt);
    _channel.postMessage({ type: 'EVENT', payload: evt });

    if (_onEventCb) _onEventCb(evt);
    return evt;
  }


  // ----------------------------------------------------------
  // PUBLIC: onEvent
  // ----------------------------------------------------------

  /**
   * Register a callback for ALL chain events (local + remote).
   * @param {function} cb - receives the event object
   */
  function onEvent(cb) {
    _onEventCb = cb;
  }


  // ----------------------------------------------------------
  // PUBLIC: whoWasFirst
  // ----------------------------------------------------------

  /**
   * Query the chain for the first occurrence of an event type,
   * optionally filtered by playerId or data predicate.
   *
   * @param {string}   eventType  - e.g. 'POCKET'
   * @param {object}   opts
   * @param {string}   opts.playerId   - filter by player
   * @param {function} opts.where      - (evt) => bool predicate on evt.data
   * @returns {object|null}            - the winning event, or null
   */
  function whoWasFirst(eventType, opts = {}) {
    const candidates = _chain.filter(evt => {
      if (evt.type !== eventType) return false;
      if (opts.playerId && evt.playerId !== opts.playerId) return false;
      if (opts.where && !opts.where(evt.data)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // Sort by provenance order — lowest wins
    candidates.sort(_compareProvenance);
    return candidates[0];
  }


  // ----------------------------------------------------------
  // PUBLIC: getGhost
  // ----------------------------------------------------------

  /**
   * Predict the next state for a player based on their history.
   * Returns a game-agnostic delta object — each game maps to its
   * own coordinate system.
   *
   * @param {string} playerId
   * @returns {object} { predictedDelta, confidence, lastSeen }
   *   predictedDelta: { x, y, vx, vy } — normalised -1..1
   *   confidence: 0..1 (based on history depth)
   *   lastSeen: timestamp of last event
   */
  function getGhost(playerId) {
    const history = _playerHistories[playerId];
    if (!history || history.length < 2) {
      return { predictedDelta: { x: 0, y: 0, vx: 0, vy: 0 }, confidence: 0, lastSeen: null };
    }

    // Compute average velocity from position deltas in history
    let sumDx = 0, sumDy = 0, count = 0;
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1].data;
      const b = history[i].data;
      if (typeof a.x === 'number' && typeof b.x === 'number') {
        sumDx += b.x - a.x;
        sumDy += b.y - a.y;
        count++;
      }
    }

    const avgDx = count > 0 ? sumDx / count : 0;
    const avgDy = count > 0 ? sumDy / count : 0;
    const last = history[history.length - 1];
    const confidence = Math.min(1, history.length / HISTORY_DEPTH);

    return {
      predictedDelta: {
        x:  (last.data.x || 0) + avgDx,
        y:  (last.data.y || 0) + avgDy,
        vx: avgDx,
        vy: avgDy
      },
      confidence,
      lastSeen: last.timestamp
    };
  }


  // ----------------------------------------------------------
  // PUBLIC: reconnect
  // ----------------------------------------------------------

  /**
   * Call when a tab becomes active again after dormancy.
   * Requests chain state from any peer tabs.
   * @param {function} cb - called when sync is complete
   */
  function reconnect(cb) {
    _onReconnectCb = cb;
    _channel.postMessage({
      type: 'RECONNECT_REQUEST',
      payload: { instanceId: _instanceId }
    });
    // If no peers respond in 500ms, we're alone — still call cb
    setTimeout(() => { if (cb) cb(_chain.length); }, 500);
  }


  // ----------------------------------------------------------
  // HARMONIC SUNRISE: AUDIO ENGINE
  // ----------------------------------------------------------

  function _runAudioLoop() {
    if (_analyser && _dataArray) {
      // Real mic
      _analyser.getByteFrequencyData(_dataArray);

      let sum = 0;
      _dataArray.forEach(v => sum += v);
      _audioState.amplitude = sum / (_dataArray.length * 255);

      // Bass: bins 0-8
      let bassSum = 0;
      for (let i = 0; i < 8; i++) bassSum += _dataArray[i];
      _audioState.bass = bassSum / (8 * 255);

      // Mid: bins 8-32
      let midSum = 0;
      for (let i = 8; i < 32; i++) midSum += _dataArray[i];
      _audioState.mid = midSum / (24 * 255);

      // Treble: bins 32-64
      let trebleSum = 0;
      for (let i = 32; i < 64; i++) trebleSum += (_dataArray[i] || 0);
      _audioState.treble = trebleSum / (32 * 255);

      // Dominant frequency bin (0..1 normalised)
      let maxAmp = 0, domBin = 0;
      _dataArray.forEach((v, i) => { if (v > maxAmp) { maxAmp = v; domBin = i; } });
      _audioState.dominant = domBin / _dataArray.length;

    } else if (_simActive) {
      // Simulation mode — organic wave
      _simPhase += 0.06;
      _audioState.amplitude = 0.35 + Math.sin(_simPhase * 0.4) * 0.25 + Math.random() * 0.08;
      _audioState.bass      = 0.25 + Math.sin(_simPhase * 0.2) * 0.2;
      _audioState.mid       = 0.2  + Math.cos(_simPhase * 0.3) * 0.15;
      _audioState.treble    = 0.15 + Math.sin(_simPhase * 0.5) * 0.1;
      _audioState.dominant  = (Math.sin(_simPhase * 0.1) + 1) / 2;
    }

    // P2 trigger gate
    if (_p2Cooldown > 0) {
      _p2Cooldown--;
    } else if (_audioState.amplitude > _p2Threshold) {
      _p2Cooldown = _p2CooldownFrames;
      const triggerEvt = broadcast('P2_AUDIO_TRIGGER', 'p2', {
        amplitude: _audioState.amplitude,
        bass:      _audioState.bass,
        mid:       _audioState.mid,
        treble:    _audioState.treble,
        dominant:  _audioState.dominant
      });
      if (_onP2TriggerCb) _onP2TriggerCb(_audioState, triggerEvt);
    }

    requestAnimationFrame(_runAudioLoop);
  }

  /**
   * Start the Harmonic Sunrise audio engine.
   * Requests mic access; falls back to simulation if denied.
   * @returns {Promise<'mic'|'sim'>}
   */
  async function startAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
      _analyser  = _audioCtx.createAnalyser();
      _analyser.fftSize = 256;
      _dataArray = new Uint8Array(_analyser.frequencyBinCount);
      _audioCtx.createMediaStreamSource(stream).connect(_analyser);
      _micActive = true;
      _runAudioLoop();
      return 'mic';
    } catch (e) {
      // No mic — run simulation so P2 still behaves
      _simActive = true;
      _runAudioLoop();
      return 'sim';
    }
  }

  /**
   * Register callback for when Harmonic Sunrise triggers P2.
   * @param {function} cb - receives (audioState, chainEvent)
   */
  function onP2Trigger(cb) {
    _onP2TriggerCb = cb;
  }

  /**
   * Get current audio analysis state.
   * @returns {{ amplitude, bass, mid, treble, dominant }}
   */
  function getAudioState() {
    return { ..._audioState };
  }

  /**
   * Set the amplitude threshold at which Harmonic Sunrise triggers P2.
   * @param {number} threshold - 0..1, default 0.55
   */
  function setP2Threshold(threshold) {
    _p2Threshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Set cooldown frames between P2 triggers (prevents spam).
   * @param {number} frames - default 80
   */
  function setP2Cooldown(frames) {
    _p2CooldownFrames = Math.max(1, frames);
  }


  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------

  return {
    init,
    broadcast,
    onEvent,
    whoWasFirst,
    getGhost,
    reconnect,
    startAudio,
    onP2Trigger,
    getAudioState,
    setP2Threshold,
    setP2Cooldown,

    // Read-only diagnostics (for games that want to surface internals)
    get instanceId()   { return _instanceId; },
    get blockHeight()  { return _blockHeight; },
    get micActive()    { return _micActive; },
    get simActive()    { return _simActive; },
    get chainLength()  { return _chain.length; }
  };

})();

// Export for both browser (global) and module environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OracleHarmonic;
}
