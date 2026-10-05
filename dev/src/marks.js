// Marks: "that's a card" moments saved from the player (video, time, optional note), copied out for Anki.
var Marks = (function () {
  var KEY = 'shelf.v3.marks'; // small, mirrored to the phone

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // One line of text: tabs and line breaks would split an Anki row
  function flat(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function link(m) { return 'https://www.youtube.com/watch?v=' + m.vid + (m.t >= 1 ? '&t=' + Math.floor(m.t) + 's' : ''); }
  // A drafted card (Mo's style: a short case and one or two questions; one sentence each, then Versus and Why)
  // as one Anki line. Line breaks become <br> (Anki's import reads HTML), **bold** becomes <b>.
  function html(s) { return flat(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); }
  function cardLine(c) {
    if (!c || !c.answer) return '';
    var qs = (Array.isArray(c.questions) ? c.questions : [c.questions]).map(html).filter(Boolean);
    var front = (flat(c.stem) ? html(c.stem) + '<br><br>' : '') + qs.join('<br>');
    var back = html(c.answer) + (flat(c.management) ? '<br>' + html(c.management) : '') + (flat(c.vs) ? '<br><br>' + html(c.vs) : '') + (flat(c.why) ? '<br><br><i>Why: ' + html(c.why).replace(/^Why:\s*/i, '') + '</i>' : '');
    return front ? front + '\t' + back : '';
  }
  // Anki's text import: front<TAB>back, one card a line. A mark with a drafted card exports the card.
  function anki(list) {
    return list.map(function (m) {
      return cardLine(m.card) || flat(m.title || 'YouTube video') + ' @ ' + fmt(m.t) + (flat(m.note) ? ': ' + flat(m.note) : '') + '\t' + link(m);
    }).join('\n');
  }

  // io: { load(key), save(key, string), now() }
  function create(io) {
    var now = io.now || Date.now, state = read();
    function read() {
      var s = null;
      try { s = JSON.parse(io.load(KEY) || 'null'); } catch (e) { s = null; }
      if (!s || !Array.isArray(s.items)) s = { items: [] };
      s.items = s.items.filter(function (m) { return m && typeof m === 'object' && m.id && m.vid; });
      return s;
    }
    function save() { state.saved = now(); io.save(KEY, JSON.stringify(state)); }
    function list() { return state.items.slice().sort(function (a, b) { return b.at - a.at; }); }
    function get(id) { return state.items.filter(function (m) { return m.id === id; })[0] || null; }
    function add(o) {
      var at = now(), m = { id: 'm' + at.toString(36) + Math.floor(Math.random() * 1296).toString(36), vid: o.vid, title: flat(o.title), t: Math.max(0, Math.floor(o.t || 0)), note: flat(o.note), course: flat(o.course), at: at };
      state.items.push(m); save();
      return m;
    }
    function setNote(id, note) { var m = get(id); if (!m) return null; m.note = flat(note); save(); return m; }
    function setCard(id, card) { var m = get(id); if (!m) return null; if (card) m.card = card; else delete m.card; save(); return m; }
    function remove(id) { var m = get(id); if (!m) return null; state.items = state.items.filter(function (x) { return x !== m; }); save(); return m; }
    function restore(m) { if (m && !get(m.id)) { state.items.push(m); save(); } }
    return { list: list, get: get, add: add, setNote: setNote, setCard: setCard, remove: remove, restore: restore, anki: function () { return anki(list()); }, get count() { return state.items.length; } };
  }
  return { create: create, KEY: KEY, anki: anki, cardLine: cardLine, fmt: fmt, link: link };
})();
if (typeof module !== 'undefined') module.exports = Marks;
