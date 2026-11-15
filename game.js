"use strict";
//Table UI for an active game.
//
//How it fits together:
// - `game` is a local replica of the shared Game class. Every message from the server is applied to it
//   immediately, exactly like the server does, so it is always the true current state.
// - Applying a message also produces an "event" holding a snapshot of the state before and after.
//   Events go into a queue and are played back one at a time as animations.
// - The DOM only ever shows a snapshot (`shown`), never the live replica, so the table
//   never jumps ahead of the animation that explains what happened.

const params = new URLSearchParams(window.location.search);
const DEMO = params.has("demo");
const uuid = DEMO ? "demo" : get_param("uuid");

let socket_url = "wss://tomt6-api.umbriac.com/game";
if (window.IS_DEV) {
  console.log('Development environment detected, using localhost.');
  socket_url = 'ws://localhost:8080/game';
}

const $ = (id) => document.getElementById(id);
const lobby_screen = $("lobby-screen");
const game_screen = $("game-screen");
const action_feed = $("action-feed");
const fx = $("fx");
const deck_slot = $("deck-slot");
const discard_slot = $("discard-slot");
const draw_button = $("draw_button");
const fold_button = $("fold_button");

const valid_cards = new Set(Game.build_deck());
const DECK_SIZE = Game.build_deck().length;
const reduced_motion = window.matchMedia("(prefers-reduced-motion: reduce)");
//the "Normal" animation speed, change the 1.35 to taste (bigger is faster).
//the player's own speed setting and game.html?speed=2 both multiply it.
const BASE_ANIMATION_SPEED = (parseFloat(params.get("speed")) || 1) * 1.35;

// =====================================================================
// Personal settings (waiting room), saved in this browser only
// =====================================================================

const settings = { speed: 1, shortcuts: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem("tomt6_settings") || "{}"));
} catch (e) {}

function save_settings() {
  try {
    localStorage.setItem("tomt6_settings", JSON.stringify(settings));
  } catch (e) {}
  render_settings();
}

function render_settings() {
  for (const option of $("speed-setting").children) {
    option.setAttribute("aria-checked", String(+option.dataset.value === settings.speed));
  }
  $("shortcuts-setting").checked = !!settings.shortcuts;
}

$("speed-setting").addEventListener("click", (e) => {
  const option = e.target.closest("button");
  if (option) {
    settings.speed = +option.dataset.value;
    save_settings();
  }
});
$("shortcuts-setting").addEventListener("change", (e) => {
  settings.shortcuts = e.target.checked;
  save_settings();
});
render_settings();

// =====================================================================
// Local game replica
// =====================================================================

//things the shared game logic reported while applying the latest message
let hooks = {};

//The shared Game class calls these hooks in the middle of changing state.
//They only take notes here, the animations are played later from the queue.
class ClientGame extends Game {
  discard(card) {
    super.discard(card);
    if (this.discard_count != null) {
      this.discard_count++;
    }
  }

  sum_scores() {
    const before = this.players.map(p => p.score);
    super.sum_scores();
    hooks.round = {
      gains: this.players.map((p, i) => p.score - before[i]),
      seven: hooks.seven || [],
    };
  }

  seven_cards_animation(player) {
    (hooks.seven = hooks.seven || []).push(player.order);
  }

  death_animation(player, card) {
    hooks.death = { order: player.order, card: card };
  }

  new_round_animation() {}

  game_over(winner_order) {
    hooks.winner = winner_order;
  }
}

let game = null;
let socket = null;
//true between sending an action and hearing anything back, so a double click can't send twice
//(the server drops the connection of anyone who acts out of turn)
let awaiting = false;
let await_timer = null;
let got_state = false;
let reconnect_tries = 0;

function snap() {
  return JSON.parse(JSON.stringify({
    players: game.players,
    you: game.you,
    host_order: game.host_order,
    expected_action: game.expected_action,
    expected_action_player: game.expected_action_player,
    current_turn: game.current_turn,
    forced_draws: game.forced_draws,
    round_number: game.round_number,
    discard_top: game.discard_top == null ? null : game.discard_top,
    winner_order: game.winner_order == null ? null : game.winner_order,
    deck_count: game.deck_count == null ? null : game.deck_count,
    discard_count: game.discard_count == null ? null : game.discard_count,
  }));
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// =====================================================================
// Networking
// =====================================================================

function connect() {
  if (!uuid) {
    fatal("No player id found.");
    return;
  }
  socket = DEMO ? new DemoSocket(params) : new WebSocket(socket_url);

  //when the connection is opened immediately send the uuid
  socket.onopen = () => {
    socket.send(uuid);
  };

  socket.onmessage = (e) => {
    try {
      on_message(e.data);
    } catch (err) {
      console.error("Error handling message", e.data, err);
      resync();
    }
  };

  socket.onclose = () => {
    if (game && game.winner_order != null) {
      return;
    }
    reconnect_tries++;
    if (!got_state && reconnect_tries >= 3) {
      fatal("Could not join this game. It may have already ended.");
      return;
    }
    set_conn_status("Connection lost, reconnecting...");
    setTimeout(connect, Math.min(5000, 800 * reconnect_tries));
  };
}

function fatal(text) {
  const el = $("conn-status");
  el.textContent = text + " ";
  const link = document.createElement("a");
  link.href = "index.html";
  link.textContent = "Back to lobbies";
  el.appendChild(link);
  el.hidden = false;
  $("welcomeMessage").textContent = text;
}

function set_conn_status(text) {
  const el = $("conn-status");
  el.textContent = text || "";
  el.hidden = !text;
}

function resync() {
  if (socket && socket.readyState === 1) {
    socket.send("r");
  }
}

function send_action(msg) {
  if (!socket || socket.readyState !== 1 || awaiting) {
    return;
  }
  awaiting = true;
  update_controls();
  socket.send(String(msg));
  //if the server never answers, ask for the full state instead of staying stuck
  clearTimeout(await_timer);
  await_timer = setTimeout(() => {
    if (awaiting) {
      awaiting = false;
      resync();
      update_controls();
    }
  }, 5000);
}

function on_message(message) {
  console.log("Received:", message);
  if (message.length === 0) {
    console.log("ERROR: Empty message from server");
    return;
  }
  const kind = message.charAt(0);

  //full game state, sent on connect and whenever we ask for a resync
  if (kind === "{") {
    const parsed = JSON.parse(message);
    Object.setPrototypeOf(parsed, ClientGame.prototype);
    game = parsed;
    got_state = true;
    reconnect_tries = 0;
    awaiting = false;
    set_conn_status("");
    reset_queue();
    show_current_state();
    return;
  }

  //if the game object has not been sent then we got problems
  if (!game) {
    console.log("ERROR: Game data undefined unexpectedly");
    resync();
    return;
  }

  //events that can happen at any time
  if (kind === "c" || kind === "l") {
    const player = game.players[+message.slice(1)];
    if (player) {
      player.connected = kind === "c";
    }
    in_lobby() ? render_lobby() : update_connected();
    return;
  }
  if (kind === "p") {
    //player joined (or rejoined). mid-game the replica already knows everything about them
    if (in_lobby()) {
      const player = JSON.parse(message.slice(1));
      game.players[player.order] = player;
      render_lobby();
    }
    return;
  }

  if (in_lobby()) {
    if (message === "g") {
      //game started (go!)
      game.expected_action = "draw_or_fold";
      game.expected_action_player = 0;
      game.deck_count = DECK_SIZE;
      game.discard_count = 0;
      show_current_state();
      enqueue({ type: "start", post: snap(), text: `The game has started. ${current_player().name} goes first.` });
    }
    return;
  }

  //everything below is a move in a running game
  awaiting = false;
  hooks = {};
  const pre = snap();
  const actor = game.expected_action_player;
  const actor_name = current_player().name;

  if (message === "e") {
    return;
  }

  if (message === "shuffle") {
    game.deck_count = game.discard_count;
    game.discard_count = game.discard_count == null ? null : 0;
    game.discard_top = null;
    enqueue({ type: "shuffle", pre, post: snap(), text: "The discard pile was shuffled into the deck." });
    return;
  }

  if (message === "o") {
    if (game.expected_action !== "draw_or_fold") {
      console.log("ERROR: Unexpected fold");
      resync();
      return;
    }
    game.fold();
    enqueue({ type: "fold", player: actor, pre, post: snap(), hooks, text: `${actor_name} folded.` });
    return;
  }

  if (game.expected_action === "draw_or_fold" || game.expected_action === "force_draw") {
    if (!valid_cards.has(message)) {
      console.log("ERROR: invalid card received, instead got", message);
      resync();
      return;
    }
    if (game.deck_count != null) {
      game.deck_count--;
    }
    game.expected_action === "draw_or_fold" ? game.regular_draw(message) : game.force_draw(message);
    enqueue({ type: "draw", card: message, player: actor, pre, post: snap(), hooks, text: `${actor_name} drew ${card_name(message)}.` });
    return;
  }

  if (game.expected_action === "use") {
    if (isNaN(+message) || +message >= game.players.length) {
      console.log("ERROR: Expected use order, instead got", message);
      resync();
      return;
    }
    const card = first_action_card(current_player());
    const target = +message;
    game.use(target);
    enqueue({
      type: "use", card, player: actor, target, pre, post: snap(), hooks,
      text: `${actor_name} used ${card_name(card)} on ${target === actor ? "themself" : game.players[target].name}.`,
    });
  }
}

function in_lobby() {
  return game.expected_action === "start_game";
}

function current_player() {
  return game.players[game.expected_action_player];
}

function first_action_card(player) {
  for (let card of player.cards) {
    if (["f", "s", "d"].includes(card)) {
      return card;
    }
  }
  return null;
}

// =====================================================================
// Player actions
// =====================================================================

function start_game() {
  console.log("attempting to start game");
  socket.send("s");
}

function draw() {
  if (!draw_button.disabled) {
    send_action("d");
  }
}

function fold() {
  if (!fold_button.disabled) {
    send_action("f");
  }
}

function use(order_target) {
  send_action(order_target);
}

game_screen.addEventListener("click", (e) => {
  const area = e.target.closest(".area.targetable");
  if (area) {
    use(+area.dataset.order);
  }
  //clicking anywhere outside the log closes it
  if (!e.target.closest("#log-panel") && !e.target.closest("#log-button")) {
    set_log_open(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "d" && settings.shortcuts) {
    draw();
  } else if (key === "f" && settings.shortcuts) {
    fold();
  } else if (key === "enter" || key === " ") {
    const area = document.activeElement && document.activeElement.closest(".area.targetable");
    if (area) {
      e.preventDefault();
      use(+area.dataset.order);
    }
  } else if (key === "escape") {
    set_log_open(false);
  }
});

function toggle_log() {
  set_log_open($("log-panel").hidden);
}

function set_log_open(open) {
  $("log-panel").hidden = !open;
  $("log-button").setAttribute("aria-expanded", String(open));
  if (open) {
    $("log-panel").scrollTop = $("log-panel").scrollHeight;
  }
}

function log(text) {
  const line = document.createElement("p");
  line.textContent = text;
  action_feed.appendChild(line);
  while (action_feed.children.length > 200) {
    action_feed.firstChild.remove();
  }
  $("log-panel").scrollTop = $("log-panel").scrollHeight;
  $("last-action").textContent = text;
}

// =====================================================================
// Cards
// =====================================================================

const CARD_INFO = {
  f: { name: "Freeze", glyph: "❄︎", sub: "Freeze" },
  s: { name: "Second Chance", glyph: "♥︎", sub: "2nd chance" },
  d: { name: "Draw Three", glyph: "D3", sub: "Draw three" },
};

function card_name(card) {
  if (CARD_INFO[card]) {
    return CARD_INFO[card].name;
  }
  return /^\d+$/.test(card) ? `a ${card}` : card;
}

function is_action(card) {
  return card === "f" || card === "s" || card === "d";
}

function is_active(player) {
  return !(player.lost || player.frozen || player.folded);
}

//these reuse the shared rules so the numbers on screen always match what the server will score
function round_points(cards) {
  const p = { cards };
  return Game.prototype.calc_score.call(null, p) + (number_count(cards) > 6 ? 15 : 0);
}

function number_count(cards) {
  return Game.prototype.count_normal_cards.call(null, { cards });
}

function make_card(code, face_down) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.code = code;
  const inner = document.createElement("div");
  inner.className = "card-inner";
  const front = document.createElement("div");
  front.className = "face front";
  const back = document.createElement("div");
  back.className = "face back";
  back.textContent = "6+";

  let corner = code, big = code, sub = "";
  if (CARD_INFO[code]) {
    el.classList.add("t-" + code);
    corner = big = CARD_INFO[code].glyph;
    sub = CARD_INFO[code].sub;
  } else if (code.startsWith("+") || code === "x2") {
    el.classList.add("t-mod");
    sub = code === "x2" ? "double" : "bonus";
  } else {
    el.classList.add("t-num");
    //each number gets its own colour so duplicates are easy to spot across the table
    el.style.setProperty("--c", `hsl(${(+code * 137) % 360}, 72%, 30%)`);
  }
  for (const [cls, text] of [["corner", corner], ["big", big], ["sub", sub]]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    front.appendChild(span);
  }
  if (big.length > 2) {
    front.querySelector(".big").style.fontSize = "0.72em";
  }

  inner.appendChild(front);
  inner.appendChild(back);
  el.appendChild(inner);
  if (face_down) {
    el.classList.add("down");
  }
  return el;
}

// =====================================================================
// Rendering a snapshot
// =====================================================================

//the snapshot currently on screen
let shown = null;
//order -> the DOM pieces of that player's area
let areas = [];

function show_current_state() {
  if (in_lobby()) {
    lobby_screen.hidden = false;
    game_screen.hidden = true;
    render_lobby();
    return;
  }
  lobby_screen.hidden = true;
  game_screen.hidden = false;
  render(snap());
}

function render_lobby() {
  const me = game.players[game.you];
  $("welcomeMessage").textContent = `Welcome ${me ? me.name : ""}, waiting for game to start...`;
  const player_list = $("player-list");
  player_list.innerHTML = "";
  game.players.forEach(p => {
    const player_line = document.createElement("p");
    player_line.textContent = `${p.connected ? "🔗" : "🔌"} ${p.name} ${game.host_order === p.order ? "👑" : ""}`;
    player_list.appendChild(player_line);
  });
  $("start-game-button").hidden = game.host_order !== game.you;
}

function build_areas(s) {
  areas = [];
  $("opponents").innerHTML = "";
  $("me-slot").innerHTML = "";
  const count = s.players.length;
  const has_me = s.you != null && s.players[s.you];
  //opponents are laid out in turn order starting with whoever plays right after you
  const start = has_me ? s.you + 1 : 0;
  for (let i = 0; i < count; i++) {
    const order = (start + i) % count;
    const is_me = has_me && order === s.you;
    const root = document.createElement("section");
    root.className = "area" + (is_me ? " me" : "");
    root.dataset.order = order;
    root.innerHTML = `
      <div class="area-head">
        <span class="area-name"></span>
        ${is_me ? '<span class="area-you">YOU</span>' : ""}
        <span class="area-score"></span>
        <span class="area-gain" title="Points this round"></span>
      </div>
      <div class="hand"></div>
      <div class="area-foot">
        <div class="pips" title="Number cards toward 7"></div>
        <div class="badges"></div>
      </div>`;
    const pips = root.querySelector(".pips");
    for (let j = 0; j < 7; j++) {
      const pip = document.createElement("span");
      pip.className = "pip";
      pips.appendChild(pip);
    }
    areas[order] = {
      root,
      name: root.querySelector(".area-name"),
      score: root.querySelector(".area-score"),
      gain: root.querySelector(".area-gain"),
      hand: root.querySelector(".hand"),
      pips,
      badges: root.querySelector(".badges"),
    };
    (is_me ? $("me-slot") : $("opponents")).appendChild(root);
  }
}

function render(s) {
  shown = s;
  if (areas.length !== s.players.length || !areas.length) {
    build_areas(s);
  }
  for (const p of s.players) {
    render_area(s, p);
  }
  render_piles(s);
  $("round-chip").textContent = `Round ${s.round_number}`;
  render_banner(s);
  render_game_over(s);
  update_controls();
}

function render_area(s, p) {
  const a = areas[p.order];
  const live = game.players[p.order];
  const connected = live ? live.connected : p.connected;
  const forced = s.forced_draws[s.forced_draws.length - 1];
  const forced_here = s.expected_action === "force_draw" && forced && forced[0] === p.order;

  a.name.textContent = (s.host_order === p.order ? "👑 " : "") + p.name;
  a.score.innerHTML = `${p.score}<small> pts</small>`;

  const points = p.lost ? 0 : round_points(p.cards);
  a.gain.textContent = `+${points}`;
  a.gain.classList.toggle("zero", points === 0);
  a.gain.classList.toggle("locked", (p.folded || p.frozen) && !p.lost);

  const numbers = number_count(p.cards);
  [...a.pips.children].forEach((pip, i) => pip.classList.toggle("on", i < numbers));
  a.pips.classList.toggle("full", numbers > 6);

  const cls = a.root.classList;
  cls.toggle("acting", s.winner_order == null && s.expected_action_player === p.order);
  cls.toggle("frozen", p.frozen);
  cls.toggle("folded", p.folded);
  cls.toggle("lost", p.lost);
  cls.toggle("offline", !connected);

  a.badges.innerHTML = "";
  const badge = (text, kind) => {
    const el = document.createElement("span");
    el.className = "badge " + kind;
    el.textContent = text;
    a.badges.appendChild(el);
  };
  if (forced_here) badge(`Must draw ${forced[1]}`, "forced");
  if (p.second_chances > 0) badge(`♥︎ 2nd chance${p.second_chances > 1 ? " ×" + p.second_chances : ""}`, "chance");
  if (p.frozen) badge("❄︎ Frozen", "frozen");
  if (p.folded) badge("Folded", "folded");
  if (p.lost) badge("Bust", "lost");
  if (!connected) badge("Offline", "offline");

  sync_hand(a.hand, p.cards);
}

//make the cards in a hand match the list, reusing elements that are already right
function sync_hand(hand, cards) {
  const els = [...hand.children];
  for (let i = 0; i < cards.length; i++) {
    if (els[i] && els[i].dataset.code === cards[i]) {
      els[i].style.visibility = "";
      continue;
    }
    const el = make_card(cards[i]);
    el._fresh = true;
    if (els[i]) {
      hand.replaceChild(el, els[i]);
    } else {
      hand.appendChild(el);
    }
  }
  while (hand.children.length > cards.length) {
    hand.lastChild.remove();
  }
  layout_hand(hand);
}

//cards sit left to right in draw order and overlap once they no longer fit
function layout_hand(hand) {
  const n = hand.children.length;
  if (!n) {
    return;
  }
  const card_w = hand.firstChild.offsetWidth;
  const gap = Math.max(3, card_w * 0.08);
  const step = n > 1 ? Math.min(card_w + gap, (hand.clientWidth - card_w) / (n - 1)) : 0;
  const fresh = [];
  for (let i = 0; i < n; i++) {
    const card = hand.children[i];
    //a brand new card appears in its spot right away, only cards making room for it slide
    if (card._fresh) {
      card.style.transition = "none";
      fresh.push(card);
    }
    card.style.left = `${Math.max(0, i * step)}px`;
  }
  if (fresh.length) {
    void hand.offsetWidth;
    for (const card of fresh) {
      card.style.transition = "";
      card._fresh = false;
    }
  }
}

window.addEventListener("resize", () => {
  for (const a of areas) {
    if (a) layout_hand(a.hand);
  }
});

function render_piles(s) {
  //discard pile shows its top card
  const top = discard_slot.firstChild;
  if (!s.discard_top || s.discard_count === 0) {
    discard_slot.innerHTML = "";
  } else if (!top || top.dataset.code !== s.discard_top) {
    discard_slot.innerHTML = "";
    discard_slot.appendChild(make_card(s.discard_top));
  }
  $("discard-count").textContent = s.discard_count == null ? "" : s.discard_count;

  //deck shows a card back, with a thicker edge the more cards remain
  const empty = s.deck_count === 0;
  if (empty) {
    deck_slot.innerHTML = "";
  } else {
    if (!deck_slot.firstChild) {
      const back = make_card("0", true);
      back.style.borderRadius = "calc(var(--w) * 0.11)";
      deck_slot.appendChild(back);
    }
    const layers = s.deck_count == null ? 2 : Math.min(5, Math.ceil(s.deck_count / 18));
    const shadow = [];
    for (let i = 1; i <= layers; i++) {
      shadow.push(`${i}px ${i}px 0 ${i % 2 ? "#2c333d" : "#bdbab1"}`);
    }
    deck_slot.firstChild.style.setProperty("--stack", shadow.join(", "));
  }
  $("deck-count").textContent = s.deck_count == null ? "" : s.deck_count;
}

function render_banner(s) {
  const actor = s.players[s.expected_action_player];
  const mine = s.winner_order == null && s.expected_action_player === s.you;
  const forced = s.forced_draws[s.forced_draws.length - 1];
  const left = forced ? forced[1] : 0;
  const held = actor ? first_action_card(actor) : null;
  let text;

  if (s.winner_order != null) {
    text = `${s.players[s.winner_order].name} wins!`;
  } else if (mine) {
    if (s.expected_action === "draw_or_fold") text = "Your turn: draw or fold";
    else if (s.expected_action === "force_draw") text = `You must draw ${left} more`;
    else text = `Choose a player for your ${held ? CARD_INFO[held].name : "card"}`;
  } else {
    if (s.expected_action === "draw_or_fold") text = `${actor.name}'s turn`;
    else if (s.expected_action === "force_draw") text = `${actor.name} must draw ${left} more`;
    else text = `${actor.name} is choosing a target for ${held ? CARD_INFO[held].name : "a card"}`;
  }

  $("banner-main").textContent = text;
  document.body.classList.toggle("my-turn", mine);
  document.title = (mine ? "▶ Your turn - " : "") + "Turn Over More Than 6";
}

function render_game_over(s) {
  const box = $("game-over");
  if (s.winner_order == null) {
    box.hidden = true;
    return;
  }
  if (!box.hidden) {
    return;
  }
  const winner = s.players[s.winner_order];
  const card = document.createElement("div");
  card.className = "game-over-card";
  const title = document.createElement("h2");
  title.textContent = s.winner_order === s.you ? "You win!" : `${winner.name} wins!`;
  const sub = document.createElement("p");
  sub.textContent = `Finished in ${s.round_number - 1} round${s.round_number - 1 === 1 ? "" : "s"}`;
  const list = document.createElement("ol");
  [...s.players].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const li = document.createElement("li");
    const place = document.createElement("span");
    place.className = "place";
    place.textContent = i === 0 ? "👑" : `${i + 1}.`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = p.name + (p.order === s.you ? " (you)" : "");
    const score = document.createElement("span");
    score.textContent = p.score;
    li.append(place, who, score);
    list.appendChild(li);
  });
  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Play again";
  again.onclick = () => {
    DEMO ? window.location.reload() : window.location.href = "index.html";
  };
  card.append(title, sub, list, again);
  box.innerHTML = "";
  box.appendChild(card);
  box.hidden = false;
}

function update_connected() {
  if (shown && !game_screen.hidden) {
    for (const p of shown.players) {
      render_area(shown, p);
    }
    update_controls();
  }
}

//buttons and targets only light up once the table has caught up with the real game state
function update_controls() {
  const s = shown;
  if (!s) {
    return;
  }
  const idle = ui_idle() && !awaiting;
  const mine = s.winner_order == null && s.expected_action_player === s.you;
  const can_fold = idle && mine && s.expected_action === "draw_or_fold";
  const forced = mine && s.expected_action === "force_draw";
  draw_button.disabled = !(can_fold || (idle && forced));
  fold_button.disabled = !can_fold;

  const left = forced ? s.forced_draws[s.forced_draws.length - 1][1] : 0;
  draw_button.textContent = forced ? `Draw (${left} left)` : "Draw";

  const targeting = idle && mine && s.expected_action === "use";
  for (const p of s.players) {
    const root = areas[p.order].root;
    const on = targeting && is_active(p);
    root.classList.toggle("targetable", on);
    if (on) {
      root.tabIndex = 0;
      root.setAttribute("role", "button");
    } else {
      root.removeAttribute("tabindex");
      root.removeAttribute("role");
    }
  }
}

// =====================================================================
// Animation queue
// =====================================================================

const queue = [];
let running = false;
//bumped whenever the queue is thrown away, so animations that are mid-flight know to stop
let generation = 0;
const CANCELLED = Symbol("cancelled");

function ui_idle() {
  return !running && queue.length === 0;
}

function enqueue(ev) {
  queue.push(ev);
  if (!running) {
    run_queue();
  }
}

function reset_queue() {
  generation++;
  queue.length = 0;
  running = false;
  fx.innerHTML = "";
  $("announce").innerHTML = "";
  document.querySelectorAll(".flash").forEach(el => el.remove());
}

async function run_queue() {
  const my_generation = generation;
  running = true;
  update_controls();
  try {
    while (queue.length) {
      await play(queue.shift());
    }
  } catch (err) {
    if (my_generation !== generation) {
      return;
    }
    if (err !== CANCELLED) {
      //an animation bug must never leave the table showing the wrong state
      console.error("animation failed", err);
      queue.length = 0;
      fx.innerHTML = "";
    }
  }
  if (my_generation === generation) {
    running = false;
    render(snap());
  }
}

//wait for something, then stop this animation if the queue was reset in the meantime
async function wait(promise) {
  const g = generation;
  await promise;
  if (g !== generation) {
    throw CANCELLED;
  }
}

//animations speed up when the table is falling behind the real game
function T(ms) {
  let speed = 1;
  if (queue.length >= 4) speed = 0.35;
  else if (queue.length >= 2) speed = 0.6;
  if (reduced_motion.matches) speed *= 0.4;
  return Math.max(1, ms * speed / (BASE_ANIMATION_SPEED * (settings.speed || 1)));
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const pause = (ms) => wait(sleep(T(ms)));

async function play(ev) {
  if (ev.text) {
    log(ev.text);
  }
  //nobody is watching, so skip straight to the result
  if (document.hidden) {
    log_outcome(ev);
    render(ev.post);
    return;
  }
  switch (ev.type) {
    case "start": await anim_start(ev); break;
    case "shuffle": await anim_shuffle(ev); break;
    case "draw": await anim_draw(ev); break;
    case "fold": await anim_fold(ev); break;
    case "use": await anim_use(ev); break;
  }
  render(ev.post);
}

//log lines for the things that happen as a consequence of a move
function log_outcome(ev) {
  const h = ev.hooks || {};
  const names = ev.post.players.map(p => p.name);
  if (h.death) {
    log(`${names[h.death.order]} went bust with a second ${h.death.card}.`);
  }
  if (h.round) {
    for (const order of h.round.seven) {
      log(`${names[order]} turned over 7 number cards for a 15 point bonus!`);
    }
    const scores = h.round.gains.map((g, i) => `${names[i]} +${g}`).join(", ");
    log(`Round ${ev.post.round_number - 1} is over: ${scores}.`);
  }
  if (h.winner != null) {
    log(`Game over! ${names[h.winner]} won with ${ev.post.players[h.winner].score} points.`);
  }
}

// ---------- animation building blocks ----------

//centre point and width of an element on screen
function rect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
}

function transform_for(el, st) {
  const w = el._w, h = w * 1.4;
  return `translate(${st.x - w / 2}px, ${st.y - h / 2}px) scale(${st.s})`;
}

//create a card in the animation layer, sitting exactly over `from`.
//base_w is the largest size it will be shown at, so it stays sharp when it grows.
function spawn(code, from, face_down, base_w) {
  const el = make_card(code, face_down);
  el.classList.add("flying");
  el._w = base_w || from.w;
  el._st = { x: from.x, y: from.y, s: from.w / el._w };
  el.style.setProperty("--w", el._w + "px");
  el.style.transform = transform_for(el, el._st);
  fx.appendChild(el);
  return el;
}

//glide a flying card to a new centre point and width
function move(el, to, ms, easing) {
  const st = { x: to.x, y: to.y, s: to.w ? to.w / el._w : el._st.s };
  const anim = el.animate(
    [{ transform: transform_for(el, el._st) }, { transform: transform_for(el, st) }],
    { duration: T(ms), easing: easing || "cubic-bezier(.3,.7,.2,1)" }
  );
  el._st = st;
  el.style.transform = transform_for(el, st);
  return anim.finished;
}

function flip_up(el, ms) {
  const anim = el.firstChild.animate(
    [{ transform: "rotateY(180deg)" }, { transform: "rotateY(0deg)" }],
    { duration: T(ms), easing: "ease-in-out" }
  );
  el.classList.remove("down");
  return anim.finished;
}

//pop a short message over a player's area
function flash(order, text, kind, ms) {
  const el = document.createElement("div");
  el.className = "flash " + (kind || "");
  el.textContent = text;
  const dur = T(ms || 1400);
  el.style.setProperty("--dur", dur + "ms");
  areas[order].root.appendChild(el);
  setTimeout(() => el.remove(), dur + 50);
}

function shake(order) {
  const root = areas[order].root;
  root.classList.remove("shake");
  void root.offsetWidth;
  root.classList.add("shake");
  setTimeout(() => root.classList.remove("shake"), 500);
}

function announce(text, ms) {
  const el = document.createElement("div");
  el.className = "announce-text";
  el.textContent = text;
  const dur = T(ms || 1300);
  el.style.setProperty("--dur", dur + "ms");
  $("announce").innerHTML = "";
  $("announce").appendChild(el);
  setTimeout(() => el.remove(), dur + 50);
  return wait(sleep(dur));
}

//fly cards to the discard pile one after another.
//`cards` may be cards already in flight or cards sitting in a hand. `mid` is kept in step.
async function to_discard(cards, mid) {
  const g = generation;
  const target = rect(discard_slot);
  const flights = cards.map((card, i) => {
    let el = card;
    if (!card.classList.contains("flying")) {
      const from = rect(card);
      el = spawn(card.dataset.code, from, false, from.w);
      card.style.visibility = "hidden";
    }
    return sleep(T(i * 45))
      .then(() => g === generation && move(el, target, 420))
      .then(() => {
        if (g !== generation) return;
        el.remove();
        mid.discard_top = el.dataset.code;
        if (mid.discard_count != null) mid.discard_count++;
        render_piles(mid);
      });
  });
  await wait(Promise.all(flights));
}

function reveal_width() {
  return Math.max(84, Math.min(150, window.innerWidth * 0.26, window.innerHeight * 0.22));
}

// ---------- the animations themselves ----------

async function anim_start(ev) {
  render(ev.post);
  await announce("Round 1");
}

async function anim_shuffle(ev) {
  const from = rect(discard_slot);
  const to = rect(deck_slot);
  const count = Math.min(8, ev.pre.discard_count == null ? 6 : ev.pre.discard_count);
  //the discard pile empties as its cards fly over to the deck
  render_piles(Object.assign(clone(ev.pre), { discard_top: null, discard_count: 0 }));
  const flights = [];
  for (let i = 0; i < count; i++) {
    const el = spawn("0", from, true, from.w);
    flights.push(sleep(T(i * 60)).then(() => move(el, to, 380)).then(() => el.remove()));
  }
  await wait(Promise.all(flights));
  render_piles(ev.post);
  await pause(200);
}

async function anim_draw(ev) {
  const { pre, post, card, player } = ev;
  const h = ev.hooks;
  const mid = clone(pre);
  mid.deck_count = post.deck_count;

  //rise out of the deck face down, then flip over so everyone can see it
  const deck = rect(deck_slot);
  const big = reveal_width();
  const el = spawn(card, deck, true, big);
  render_piles(mid);
  const reveal = {
    x: Math.min(window.innerWidth - big / 2 - 10, Math.max(big / 2 + 10, deck.x - big * 0.15)),
    y: Math.max(big * 0.7 + 10, deck.y - deck.w * 0.7 - big * 0.7 - 14),
    w: big,
  };
  await wait(move(el, reveal, 400));
  await wait(flip_up(el, 380));
  await pause(520);

  const hand = areas[player].hand;
  const duplicate = !is_action(card) && pre.players[player].cards.includes(card);

  if (!duplicate) {
    //safe: slide into the next free spot in the drawer's area
    mid.players[player].cards.push(card);
    render(mid);
    const slot = hand.lastElementChild;
    slot.style.visibility = "hidden";
    await wait(move(el, rect(slot), 460));
    slot.style.visibility = "";
    el.remove();
  } else {
    //duplicate: hover over the card it matches
    const twin = rect(hand.children[pre.players[player].cards.indexOf(card)]);
    await wait(move(el, { x: twin.x + twin.w * 0.3, y: twin.y - twin.w * 0.3, w: twin.w * 1.15 }, 460));
    if (h.death) {
      flash(player, "BUST!", "bad");
      shake(player);
      log(`${pre.players[player].name} went bust with a second ${card}.`);
      await pause(800);
      mid.players[player].lost = true;
      await to_discard([el, ...hand.children], mid);
      mid.players[player].cards = [];
    } else {
      flash(player, "Second chance!", "heart");
      log(`${pre.players[player].name} was saved by a Second Chance.`);
      await pause(800);
      mid.players[player].second_chances--;
      await to_discard([el], mid);
    }
    render(mid);
  }

  if (h.round) {
    await anim_round_end(ev, mid);
  }
}

async function anim_fold(ev) {
  const mid = clone(ev.pre);
  const p = mid.players[ev.player];
  p.folded = true;
  render(mid);
  flash(ev.player, `Folded, banked +${round_points(p.cards)}`, "", 1100);
  await pause(ev.hooks.round ? 1100 : 700);
  if (ev.hooks.round) {
    await anim_round_end(ev, mid);
  }
}

async function anim_use(ev) {
  const { pre, post, card, player, target } = ev;
  const mid = clone(pre);
  const index = pre.players[player].cards.indexOf(card);
  const source = areas[player].hand.children[index];

  //the action card leaves its owner's hand and lands on the target's area
  const from = rect(source);
  const big = reveal_width() * 0.8;
  const el = spawn(card, from, false, Math.max(big, from.w));
  source.style.visibility = "hidden";
  const area = areas[target].root.getBoundingClientRect();
  await wait(move(el, { x: area.left + area.width / 2, y: area.top + area.height / 2, w: big }, 520));

  mid.players[player].cards.splice(index, 1);
  const t = mid.players[target];
  if (card === "f") {
    t.frozen = true;
    flash(target, "❄︎ Frozen", "ice");
  } else if (card === "s") {
    t.second_chances++;
    flash(target, "♥︎ Second chance", "heart");
  } else {
    mid.forced_draws = post.forced_draws;
    mid.expected_action = "force_draw";
    mid.expected_action_player = target;
    flash(target, "Draw 3!", "gold");
  }
  render(mid);
  await pause(750);
  await to_discard([el], mid);

  if (ev.hooks.round) {
    await anim_round_end(ev, mid);
  }
}

//score tally, every hand swept into the discard pile, then the next round (or the winner)
async function anim_round_end(ev, mid) {
  const { post } = ev;
  const round = ev.hooks.round;
  log_outcome({ hooks: { round, winner: ev.hooks.winner }, post });

  mid.players.forEach((p, i) => {
    const bonus = round.seven.includes(i);
    flash(i, `+${round.gains[i]}${bonus ? " (7 cards!)" : ""}`, bonus ? "gold" : round.gains[i] > 0 ? "good" : "", 1900);
    p.score = post.players[i].score;
    areas[i].score.innerHTML = `${p.score}<small> pts</small>`;
  });
  await pause(1900);

  const cards = [];
  for (const p of mid.players) {
    cards.push(...areas[p.order].hand.children);
  }
  if (cards.length) {
    await to_discard(cards, mid);
  }
  for (const p of mid.players) {
    p.cards = [];
    p.frozen = p.folded = p.lost = false;
    p.second_chances = 0;
  }
  mid.forced_draws = [];
  mid.expected_action = post.expected_action;
  mid.expected_action_player = post.expected_action_player;
  render(mid);

  if (ev.hooks.winner == null) {
    await announce(`Round ${post.round_number}`);
  } else {
    await pause(400);
  }
}

// =====================================================================

function get_param(param) {
  let res = params.get(param);
  if (res) {return res;}
  console.log("Could not get", param, "from url, trying localStorage");
  res = localStorage.getItem(param);
  if (res) {return res;}
  console.log("Could not get", param, "from localStorage, trying sessionStorage");
  res = sessionStorage.getItem(param);
  return res;
}

connect();
