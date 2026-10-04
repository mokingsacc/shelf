// Podcast engine with a fake <audio> element and a fake clock.
const assert = require('assert');
global.Core = require('../src/core.js');
global.SleepTimer = require('../src/timer.js');
const AudioEngine = require('../src/audio.js');

function fakeAudio() {
  const ls = {};
  const el = {
    src: '', currentTime: 0, duration: NaN, paused: true, readyState: 0, volume: 1, playbackRate: 1,
    addEventListener: (n, f) => { (ls[n] = ls[n] || []).push(f); },
    removeEventListener: (n, f) => { ls[n] = (ls[n] || []).filter((x) => x !== f); },
    fire: (n) => (ls[n] || []).slice().forEach((f) => f()),
    load() {},
    play() { el.paused = false; el.fire('playing'); return Promise.resolve(); },
    pause() { el.paused = true; el.fire('pause'); },
    meta(d) { el.duration = d; el.readyState = 1; el.fire('loadedmetadata'); el.fire('durationchange'); el.fire('seeked'); },
    run(sec, clock) { for (let i = 0; i < sec; i++) { if (el.paused) return; el.currentTime += 1; clock.t += 1000; el.fire('timeupdate'); } }
  };
  return el;
}
function setup() {
  const db = {}, clock = { t: Date.parse('2026-10-04T22:00:00Z') };
  const session = { handlers: {}, setActionHandler(k, f) { this.handlers[k] = f; }, setPositionState(p) { this.pos = p; } };
  class MM { constructor(o) { Object.assign(this, o); } }
  const el = fakeAudio();
  const eng = AudioEngine.create({ el, load: (g) => db[g] || null, save: (g, r) => { db[g] = r; }, now: () => clock.t, mediaSession: session, MediaMetadata: MM });
  return { el, eng, db, clock, session };
}
const EP = { guid: 'ep213', url: 'https://example.com/213.mp3', title: 'Ep. 213: The Emu War', podcast: 'Fin vs History', image: 'https://example.com/a.jpg', duration: 3600 };

(async () => {
  // Starts after metadata, saves every 5 s, shows on the lock screen
  let { el, eng, db, clock, session } = setup();
  const p = eng.play(EP);
  assert.strictEqual(el.paused, false, 'plays straight away, inside the tap');
  el.meta(3600); await p;
  assert.strictEqual(el.paused, false);
  assert.strictEqual(session.metadata.title, EP.title);
  assert.strictEqual(session.metadata.artist, 'Fin vs History');
  assert.ok(session.handlers.seekbackward && session.handlers.seekforward && session.handlers.seekto);
  assert.strictEqual(session.pos.duration, 3600);
  el.run(12, clock);
  assert.ok(db.ep213 && db.ep213.t >= 10, 'saved while playing');
  el.pause();
  assert.strictEqual(db.ep213.t, 12);

  // Resume 3 s before the saved spot on the next play
  ({ el, eng, db, clock, session } = setup());
  db.ep213 = { t: 600, dur: 3600, done: false };
  el.meta(3600);
  await eng.play(EP);
  assert.strictEqual(el.currentTime, 597);

  // Resume when metadata arrives after the tap: seeks then, and trusts the spot after the seek
  {
    const r2 = setup(); r2.db.ep213 = { t: 600, dur: 3600, done: false };
    const pp = r2.eng.play(EP); r2.el.meta(3600); await pp;
    assert.strictEqual(r2.el.currentTime, 597, 'deferred seek to the saved spot');
    r2.el.run(6, r2.clock);
    assert.ok(r2.db.ep213.t >= 602, 'saves after a deferred seek (' + r2.db.ep213.t + ')');
  }

  // Lock-screen buttons
  session.handlers.seekbackward(); assert.strictEqual(el.currentTime, 582);
  session.handlers.seekforward(); assert.strictEqual(el.currentTime, 612);
  session.handlers.seekto({ seekTime: 100 }); assert.strictEqual(el.currentTime, 100);
  session.handlers.pause(); assert.strictEqual(el.paused, true);
  session.handlers.play(); assert.strictEqual(el.paused, false);

  // A stray timeupdate at 0 before playback is trusted doesn't wipe the spot
  ({ el, eng, db, clock } = setup());
  db.ep213 = { t: 900, dur: 3600, done: false };
  el.play = function () { el.paused = false; return Promise.resolve(); }; // 'playing' not fired yet
  el.meta(3600); await eng.play(EP);
  el.currentTime = 0; clock.t += 6000; el.fire('timeupdate');
  assert.strictEqual(db.ep213.t, 900);

  // Sleep timer: fades in the last minute, pauses and saves at zero, driven by timeupdate alone (phone locked)
  ({ el, eng, db, clock } = setup());
  el.meta(3600); await eng.play(EP);
  eng.setTimer(1);
  assert.strictEqual(eng.state().timerLabel, '1:00 left');
  assert.ok(/^about \d+:\d\d (am|pm)$/.test(eng.state().timerClock));
  el.run(30, clock);
  assert.ok(el.volume > 0.4 && el.volume < 0.6, 'half volume half way through the last minute');
  el.run(40, clock);
  assert.strictEqual(el.paused, true, 'paused by the timer');
  assert.strictEqual(el.volume, 1, 'volume restored for next time');
  assert.strictEqual(eng.state().timer, null);
  assert.strictEqual(eng.state().message, 'Sleep timer stopped it.');
  assert.strictEqual(db.ep213.t, 60);

  // "End of episode" timer
  ({ el, eng, db, clock } = setup());
  el.meta(3600); await eng.play(EP);
  eng.setTimer('end');
  assert.strictEqual(eng.state().timerLabel, 'Stops at the end');
  el.currentTime = 3600; el.paused = true; el.fire('ended');
  assert.strictEqual(db.ep213.done, true);
  assert.strictEqual(eng.state().timer, null);

  // Switching episodes saves the old one first
  ({ el, eng, db, clock } = setup());
  el.meta(3600); await eng.play(EP);
  el.run(20, clock);
  delete db.ep213;
  await eng.play(Object.assign({}, EP, { guid: 'ep214', url: 'https://example.com/214.mp3' }));
  assert.strictEqual(db.ep213.t, 20);

  // Broken audio -> plain-words message
  ({ el, eng } = setup());
  el.meta(3600); await eng.play(EP);
  el.fire('error');
  assert.ok(/Couldn't play this episode/.test(eng.state().message));

  // Autoplay refused -> asks for a tap instead of failing silently
  ({ el, eng } = setup());
  el.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  el.meta(3600); await eng.play(EP);
  assert.ok(/Tap play/.test(eng.state().message));

  console.log('audio: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
