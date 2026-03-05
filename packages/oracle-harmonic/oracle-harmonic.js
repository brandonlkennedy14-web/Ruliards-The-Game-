/**
 * ORACLE-HARMONIC MODULE v2
 * ============================================================
 * Shared cog: Sim3Colts + Retro Ruliad Billiards
 *
 * — 0 Ping Oracle: P2P provenance chain via BroadcastChannel
 * — Harmonic Sunrise: Audio-driven Player 2 (shared across games)
 * — Ghost prediction: Game-agnostic state extrapolation
 * — Cross-game causality: Events in one game ripple into the other
 * — Shared leaderboard: Provenance settled across both games
 *
 * No server. No encryption. First block wins.
 * User is P1 in both games simultaneously.
 * Their audio IS P2 in both games simultaneously.
 * ============================================================
 */

const OracleHarmonic = (() => {

  // ----------------------------------------------------------
  // INTERNAL STATE
  // ----------------------------------------------------------

  let _instanceId   = null;
  let _gameId       = null;
  let _channel      = null;   // shared across ALL game ids
  let _chain        = [];
  let _blockHeight  = 0;
  let _playerHistories = {};
  const HISTORY_DEPTH = 30;

  // Cross-game causality map
  // { sourceGameId: { eventType: [{ targetGameId, effectType, transform }] } }
  const CROSS_GAME_EFFECTS = {
    'sim3colts': {
      'POCKET':    [{ targetGameId: 'retro-ruliad', effectType: 'FORCE_PULSE',     transform: d => ({ magnitude: 8 + d.speed * 4, x: d.x, y: d.y }) }],
      'TELEPORT':  [{ targetGameId: 'retro-ruliad', effectType: 'WORMHOLE',        transform: d => ({ duration: 120, x: d.x, y: d.y }) }],
    },
    'retro-ruliad': {
      'DIMENSION_SHIFT': [{ targetGameId: 'sim3colts', effectType: 'GEO_MORPH',   transform: d => ({ dimension: d.dimension }) }],
      'BOUNCE_CHAIN':    [{ targetGameId: 'sim3colts', effectType: 'SPEED_SURGE',  transform: d => ({ boost: Math.min(d.bounces * 0.08, 1.2) }) }],
    },
    '*': {
      'P2_AUDIO_TRIGGER': [
        { targetGameId: 'sim3colts',   effectType: 'P2_MOVE', transform: d => d },
        { targetGameId: 'retro-ruliad',effectType: 'P2_MOVE', transform: d => d },
      ],
      'PSYCHOSIS': [
        { targetGameId: 'sim3colts',   effectType: 'PSYCHOSIS', transform: d => d },
        { targetGameId: 'retro-ruliad',effectType: 'PSYCHOSIS', transform: d => d },
      ]
    }
  };

  // Leaderboard: { playerId+gameId -> { pockets, firsts, score } }
  let _leaderboard = {};

  // Callbacks
  let _onEventCb       = null;
  let _onP2TriggerCb   = null;
  let _onCrossGameCb   = null;
  let _onReconnectCb   = null;
  let _onLeaderboardCb = null;

  // Audio
  let _audioCtx  = null;
  let _analyser  = null;
  let _dataArray = null;
  let _micActive = false;
  let _simActive = false;
  let _simPhase  = 0;
  let _audioLoopRunning = false;

  let _audioState = { amplitude: 0, bass: 0, mid: 0, treble: 0, dominant: 0 };
  let _p2Threshold      = 0.52;
  let _p2CooldownFrames = 80;
  let _p2Cooldown       = 0;


  // ----------------------------------------------------------
  // UTILITIES
  // ----------------------------------------------------------

  function _hashEvent(evt) {
    const str = `${evt.instanceId}|${evt.timestamp}|${evt.type}|${JSON.stringify(evt.data)}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h;
  }

  function _compareProvenance(a, b) {
    if (a.block !== b.block)         return a.block - b.block;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return _hashEvent(a) - _hashEvent(b);
  }

  function _uid() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }


  // ----------------------------------------------------------
  // LEADERBOARD
  // ----------------------------------------------------------

  function _updateLeaderboard(evt) {
    const key = `${evt.playerId}:${evt.gameId}`;
    if (!_leaderboard[key]) {
      _leaderboard[key] = { playerId: evt.playerId, gameId: evt.gameId, pockets: 0, firsts: 0, score: 0 };
    }
    const entry = _leaderboard[key];

    if (evt.type === 'POCKET')          { entry.pockets++; entry.score += 10; }
    if (evt.type === 'DIMENSION_SHIFT') { entry.score += 25; }
    if (evt.type === 'TELEPORT')        { entry.score += 5; }
    if (evt.type === 'FIRST')           { entry.firsts++; entry.score += 50; }

    if (_onLeaderboardCb) _onLeaderboardCb(_getLeaderboardSorted());
  }

  function _getLeaderboardSorted() {
    return Object.values(_leaderboard).sort((a, b) => b.score - a.score);
  }


  // ----------------------------------------------------------
  // CROSS-GAME CAUSALITY
  // ----------------------------------------------------------

  function _processCrossGameEffects(evt) {
    // Check specific game effects
    const gameEffects = CROSS_GAME_EFFECTS[evt.gameId] || {};
    const universalEffects = CROSS_GAME_EFFECTS['*'] || {};

    const allEffects = [
      ...(gameEffects[evt.type] || []),
      ...(universalEffects[evt.type] || [])
    ];

    allEffects.forEach(effect => {
      // Don't echo back to the same game that fired
      if (effect.targetGameId === evt.gameId) return;

      const crossEvt = {
        block:        _blockHeight,
        timestamp:    performance.now(),
        instanceId:   _instanceId,
        sourceGameId: evt.gameId,
        gameId:       effect.targetGameId,
        playerId:     evt.playerId,
        type:         effect.effectType,
        causedBy:     evt.block,
        data:         effect.transform(evt.data || {})
      };

      // Broadcast the cross-game effect
      _channel.postMessage({ type: 'CROSS_GAME_EFFECT', payload: crossEvt });

      if (_onCrossGameCb) _onCrossGameCb(crossEvt);
    });
  }


  // ----------------------------------------------------------
  // CHAIN
  // ----------------------------------------------------------

  function _appendToChain(evt) {
    // Deduplicate
    const exists = _chain.some(e =>
      e.block === evt.block && e.instanceId === evt.instanceId && e.type === evt.type
    );
    if (exists) return;

    _chain.push(evt);
    if (_chain.length > 800) _chain.shift();

    // Player history for ghost
    if (evt.playerId) {
      if (!_playerHistories[evt.playerId]) _playerHistories[evt.playerId] = [];
      _playerHistories[evt.playerId].push({
        timestamp: evt.timestamp,
        block:     evt.block,
        type:      evt.type,
        gameId:    evt.gameId,
        data:      evt.data
      });
      if (_playerHistories[evt.playerId].length > HISTORY_DEPTH) {
        _playerHistories[evt.playerId].shift();
      }
    }

    _updateLeaderboard(evt);
  }


  // ----------------------------------------------------------
  // BROADCAST CHANNEL
  // ----------------------------------------------------------

  function _initChannel() {
    // Single shared channel across ALL games in the monorepo
    _channel = new BroadcastChannel('ruliards-oracle');

    _channel.onmessage = (msg) => {
      const { type, payload } = msg.data;

      if (type === 'EVENT') {
        _appendToChain(payload);
        _processCrossGameEffects(payload);
        if (_onEventCb) _onEventCb(payload);
      }

      if (type === 'CROSS_GAME_EFFECT') {
        // Only process if this instance is the target game
        if (payload.gameId === _gameId) {
          if (_onCrossGameCb) _onCrossGameCb(payload);
        }
      }

      if (type === 'RECONNECT_REQUEST') {
        _channel.postMessage({
          type: 'RECONNECT_RESPONSE',
          payload: {
            toInstanceId: payload.instanceId,
            chain:        _chain.slice(-150),
            blockHeight:  _blockHeight,
            leaderboard:  _leaderboard
          }
        });
      }

      if (type === 'RECONNECT_RESPONSE') {
        if (payload.toInstanceId !== _instanceId) return;
        payload.chain.forEach(evt => _appendToChain(evt));
        if (payload.blockHeight > _blockHeight) _blockHeight = payload.blockHeight;
        if (payload.leaderboard) {
          Object.assign(_leaderboard, payload.leaderboard);
        }
        _chain.sort(_compareProvenance);
        if (_onReconnectCb) _onReconnectCb(_chain.length);
        if (_onLeaderboardCb) _onLeaderboardCb(_getLeaderboardSorted());
      }

      // Dashboard spectator — relay all events regardless of gameId
      if (type === 'SPECTATE_REQUEST') {
        _channel.postMessage({
          type: 'SPECTATE_SNAPSHOT',
          payload: {
            chain:       _chain.slice(-200),
            leaderboard: _leaderboard,
            blockHeight: _blockHeight
          }
        });
      }
    };
  }


  // ----------------------------------------------------------
  // PUBLIC: INIT
  // ----------------------------------------------------------

  function init(gameId, instanceId) {
    _gameId     = gameId;
    _instanceId = instanceId || _uid();
    _initChannel();
    return _instanceId;
  }


  // ----------------------------------------------------------
  // PUBLIC: BROADCAST
  // ----------------------------------------------------------

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
    _processCrossGameEffects(evt);
    _channel.postMessage({ type: 'EVENT', payload: evt });
    if (_onEventCb) _onEventCb(evt);
    return evt;
  }


  // ----------------------------------------------------------
  // PUBLIC: WHO WAS FIRST
  // ----------------------------------------------------------

  function whoWasFirst(eventType, opts = {}) {
    const candidates = _chain.filter(evt => {
      if (evt.type !== eventType) return false;
      if (opts.playerId && evt.playerId !== opts.playerId) return false;
      if (opts.gameId   && evt.gameId   !== opts.gameId)   return false;
      if (opts.where    && !opts.where(evt.data))           return false;
      return true;
    });
    if (candidates.length === 0) return null;
    candidates.sort(_compareProvenance);
    return candidates[0];
  }


  // ----------------------------------------------------------
  // PUBLIC: GET GHOST
  // ----------------------------------------------------------

  function getGhost(playerId) {
    const history = _playerHistories[playerId];
    if (!history || history.length < 2) {
      return { predictedDelta: { x: 0, y: 0, vx: 0, vy: 0 }, confidence: 0, lastSeen: null };
    }

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
    const last  = history[history.length - 1];

    return {
      predictedDelta: {
        x:  (last.data.x || 0) + avgDx,
        y:  (last.data.y || 0) + avgDy,
        vx: avgDx,
        vy: avgDy
      },
      confidence: Math.min(1, history.length / HISTORY_DEPTH),
      lastSeen:   last.timestamp,
      lastGameId: last.gameId
    };
  }


  // ----------------------------------------------------------
  // PUBLIC: RECONNECT
  // ----------------------------------------------------------

  function reconnect(cb) {
    _onReconnectCb = cb;
    _channel.postMessage({ type: 'RECONNECT_REQUEST', payload: { instanceId: _instanceId } });
    setTimeout(() => { if (cb) cb(_chain.length); }, 600);
  }


  // ----------------------------------------------------------
  // PUBLIC: SPECTATE (dashboard use)
  // ----------------------------------------------------------

  function requestSpectateSnapshot(cb) {
    const handler = (msg) => {
      if (msg.data.type === 'SPECTATE_SNAPSHOT') {
        _channel.removeEventListener('message', handler);
        cb(msg.data.payload);
      }
    };
    _channel.addEventListener('message', handler);
    _channel.postMessage({ type: 'SPECTATE_REQUEST' });
    setTimeout(() => _channel.removeEventListener('message', handler), 1000);
  }


  // ----------------------------------------------------------
  // HARMONIC SUNRISE: AUDIO ENGINE
  // ----------------------------------------------------------

  function _runAudioLoop() {
    if (_analyser && _dataArray) {
      _analyser.getByteFrequencyData(_dataArray);

      let sum = 0;
      _dataArray.forEach(v => sum += v);
      _audioState.amplitude = sum / (_dataArray.length * 255);

      let bassSum = 0;
      for (let i = 0; i < 8; i++) bassSum += _dataArray[i];
      _audioState.bass = bassSum / (8 * 255);

      let midSum = 0;
      for (let i = 8; i < 32; i++) midSum += _dataArray[i];
      _audioState.mid = midSum / (24 * 255);

      let trebleSum = 0;
      for (let i = 32; i < 64; i++) trebleSum += (_dataArray[i] || 0);
      _audioState.treble = trebleSum / (32 * 255);

      let maxAmp = 0, domBin = 0;
      _dataArray.forEach((v, i) => { if (v > maxAmp) { maxAmp = v; domBin = i; } });
      _audioState.dominant = domBin / _dataArray.length;

    } else if (_simActive) {
      _simPhase += 0.055;
      _audioState.amplitude = 0.38 + Math.sin(_simPhase * 0.37) * 0.22 + Math.random() * 0.07;
      _audioState.bass      = 0.28 + Math.sin(_simPhase * 0.19) * 0.18;
      _audioState.mid       = 0.22 + Math.cos(_simPhase * 0.28) * 0.14;
      _audioState.treble    = 0.16 + Math.sin(_simPhase * 0.51) * 0.11;
      _audioState.dominant  = (Math.sin(_simPhase * 0.09) + 1) / 2;
    }

    // P2 trigger gate — fires in ALL games simultaneously via broadcast
    if (_p2Cooldown > 0) {
      _p2Cooldown--;
    } else if (_audioState.amplitude > _p2Threshold) {
      _p2Cooldown = _p2CooldownFrames;

      // Broadcast with gameId '*' so cross-game effect hits both
      _blockHeight++;
      const triggerEvt = {
        block:      _blockHeight,
        timestamp:  performance.now(),
        instanceId: _instanceId,
        gameId:     '*',           // universal — hits all games
        playerId:   'p2',
        type:       'P2_AUDIO_TRIGGER',
        data: { ..._audioState }
      };

      _channel.postMessage({ type: 'EVENT', payload: triggerEvt });
      _appendToChain(triggerEvt);

      // Also fire locally for this game instance
      if (_onP2TriggerCb) _onP2TriggerCb(_audioState, triggerEvt);
      if (_onEventCb)     _onEventCb(triggerEvt);
    }

    requestAnimationFrame(_runAudioLoop);
  }

  async function startAudio() {
    if (_audioLoopRunning) return _micActive ? 'mic' : 'sim';
    _audioLoopRunning = true;

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
      _simActive = true;
      _runAudioLoop();
      return 'sim';
    }
  }


  // ----------------------------------------------------------
  // PUBLIC CALLBACKS
  // ----------------------------------------------------------

  function onEvent(cb)       { _onEventCb = cb; }
  function onP2Trigger(cb)   { _onP2TriggerCb = cb; }
  function onCrossGame(cb)   { _onCrossGameCb = cb; }
  function onLeaderboard(cb) { _onLeaderboardCb = cb; }
  function getAudioState()   { return { ..._audioState }; }
  function setP2Threshold(t) { _p2Threshold = Math.max(0, Math.min(1, t)); }
  function setP2Cooldown(f)  { _p2CooldownFrames = Math.max(1, f); }
  function getLeaderboard()  { return _getLeaderboardSorted(); }


  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------

  return {
    init,
    broadcast,
    onEvent,
    onP2Trigger,
    onCrossGame,
    onLeaderboard,
    whoWasFirst,
    getGhost,
    reconnect,
    startAudio,
    getAudioState,
    setP2Threshold,
    setP2Cooldown,
    getLeaderboard,
    requestSpectateSnapshot,

    get instanceId()  { return _instanceId; },
    get blockHeight() { return _blockHeight; },
    get micActive()   { return _micActive; },
    get simActive()   { return _simActive; },
    get chainLength() { return _chain.length; },
    get gameId()      { return _gameId; }
  };

})();

if (typeof module !== 'undefined' && module.exports) module.exports = OracleHarmonic;
