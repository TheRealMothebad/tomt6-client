"use strict";
//Offline demo: game.html?demo runs a whole game in the browser against bots, no server needed.
//DemoSocket stands in for the WebSocket and speaks the exact same protocol as server/main.ts,
//so the UI code cannot tell the difference.
//
//  ?demo            you + 3 bots
//  ?demo=6          6 players in total (2-12)
//  &seed=123        repeatable shuffles
//  &skip=40         play 40 moves instantly before showing the table
//  &auto            a bot plays your seat too
//  &lobby           start in the waiting room instead of mid-game
//  &win=180         everyone starts on 180 points (to reach the end screen quickly)
//  &speed=3         faster animations and bots

class DemoGame extends Game {
  deck = [];
  pile = [];
  random = Math.random;

  start() {
    this.deck = Game.build_deck();
    this.shuffle();
    this.expected_action = "draw_or_fold";
    this.expected_action_player = 0;
    return "g";
  }

  player_draw() {
    const actions = [];
    if (this.top_card_index >= this.deck.length) {
      this.deck = [...this.pile];
      this.pile = [];
      this.shuffle();
      this.top_card_index = 0;
      actions.push("shuffle");
    }
    const card = this.deck[this.top_card_index];
    this.top_card_index++;
    if (this.expected_action == "draw_or_fold") {
      this.regular_draw(card);
    } else {
      this.force_draw(card);
    }
    actions.push(card);
    return actions;
  }

  discard(card) {
    this.pile.push(card);
  }

  shuffle() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  serialize(player_order) {
    return JSON.stringify({
      players: this.players,
      you: player_order,
      expected_action: this.expected_action,
      expected_action_player: this.expected_action_player,
      discard_top: this.pile.length > 0 ? this.pile[this.pile.length - 1] : null,
      deck_count: this.deck.length - this.top_card_index,
      discard_count: this.pile.length,
      current_turn: this.current_turn,
      forced_draws: this.forced_draws,
      round_number: this.round_number,
      host_order: this.host_order,
      actions_log: this.actions_log,
    });
  }
}

class DemoSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;

  constructor(params) {
    const names = ["Ada", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit"];
    const count = Math.max(2, Math.min(12, parseInt(params.get("demo")) || 4));
    this.auto = params.has("auto");
    this.random = params.has("seed") ? DemoSocket.seeded(+params.get("seed")) : Math.random;

    //keep the shared game logic's console chatter out of the way while the demo server thinks
    this.game = this.quietly(() => new DemoGame("demo", "Demo game", "You"));
    this.game.random = this.random;
    for (let i = 1; i < count; i++) {
      this.game.players.push(new Player(names[i - 1], i));
    }
    for (const p of this.game.players) {
      p.connected = true;
      p.score = parseInt(params.get("win")) || 0;
    }
    if (!params.has("lobby")) {
      this.quietly(() => this.game.start());
      for (let i = parseInt(params.get("skip")) || 0; i > 0 && this.game.winner_order == null; i--) {
        this.quietly(() => this.bot_move());
      }
    }

    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }

  static seeded(seed) {
    //mulberry32
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  quietly(fn) {
    const real = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = real;
    }
  }

  emit(messages) {
    for (const m of messages) {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: m });
      }, 0);
    }
    setTimeout(() => this.schedule_bot(), 0);
  }

  close() {
    this.readyState = 3;
  }

  //mirrors the message handling in server/main.ts
  send(msg) {
    const game = this.game;
    if (msg === "demo" || msg === "r") {
      this.emit([game.serialize(0)]);
      return;
    }
    if (game.expected_action_player !== 0 || game.winner_order != null) {
      return;
    }
    if (game.expected_action === "start_game") {
      if (msg === "s") {
        this.emit([this.quietly(() => game.start())]);
      }
      return;
    }
    this.emit(this.quietly(() => this.act(msg)));
  }

  act(msg) {
    const game = this.game;
    if (msg === "d" && game.expected_action !== "use") {
      return game.player_draw();
    }
    if (msg === "f" && game.expected_action === "draw_or_fold") {
      return [game.fold()];
    }
    if (game.expected_action === "use" && !isNaN(+msg) && +msg < game.players.length) {
      return [game.use(+msg)];
    }
    return [];
  }

  //what a bot would send in the current state
  bot_choice() {
    const game = this.game;
    const me = game.players[game.expected_action_player];
    if (game.expected_action === "force_draw") {
      return "d";
    }
    if (game.expected_action === "draw_or_fold") {
      const points = game.calc_score(me);
      const brave = me.second_chances > 0 ? 14 : 0;
      return points >= 18 + brave + this.random() * 14 ? "f" : "d";
    }
    //playing an action card
    const card = me.cards.find(c => game.is_action_card(c));
    const others = game.players.filter(p => p.order !== me.order && game.active(p.order));
    if (card === "s" || others.length === 0) {
      return String(me.order);
    }
    //freeze and draw three go to whoever is doing best this round
    others.sort((a, b) => game.calc_score(b) - game.calc_score(a));
    return String(others[0].order);
  }

  bot_move() {
    return this.act(this.bot_choice());
  }

  //bots wait for the table to finish animating, then think for a moment
  schedule_bot() {
    clearTimeout(this.bot_timer);
    const game = this.game;
    if (this.readyState !== 1 || game.winner_order != null || game.expected_action === "start_game") {
      return;
    }
    if (game.expected_action_player === 0 && !this.auto) {
      return;
    }
    this.bot_timer = setTimeout(() => {
      if (typeof ui_idle === "function" && !ui_idle()) {
        this.schedule_bot();
        return;
      }
      this.emit(this.quietly(() => this.bot_move()));
    }, 550 / (parseFloat(new URLSearchParams(window.location.search).get("speed")) || 1));
  }
}
