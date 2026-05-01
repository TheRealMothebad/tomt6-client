// shared/game.ts
var Player = class {
  name;
  order;
  cards = [];
  frozen = false;
  folded = false;
  lost = false;
  second_chances = 0;
  score = 0;
  connected = false;
  constructor(name, order) {
    this.name = name;
    this.order = order;
  }
};
var Game = class {
  uuid;
  name;
  host_order;
  players = [];
  //equal to how many cards have been drawn
  //this is shared with the client so that it can know/show when the draw pile is empty, and being shuffled
  top_card_index = 0;
  //similar to the "state" of the state machine
  expected_action = "start_game";
  //index in the players array
  expected_action_player = 0;
  //tracks whose turn it is, this needs to be separate from the next_action_player bc draw three could make that be anyone
  current_turn = 0;
  //the order number of the winner of the game
  winner_order = null;
  //top card of the discard pile
  discard_top = null;
  //which player is being forced to draw a card [order, draws_remaining, source_player_order]
  //this last parameter is needed for the extremely rare case that a draw three forces
  //a player to draw both another draw three and an additional action card, both need to be
  //played before normal play is resumed
  //this can cause chains which need to be tracked by this stack structure
  forced_draws = [];
  round_number = 1;
  //game is deterministic (once seeded randomness is added), it should be able to replay from just these inputs
  //a client can use these + a list of server responses to replay a game as well
  actions_log = [];
  constructor(game_uuid, game_name, host_name) {
    this.uuid = game_uuid;
    this.name = game_name;
    this.host_order = this.add_player(host_name).order;
    this.expected_action_player = this.host_order;
  }
  start() {
    return "";
  }
  seven_cards_animation(player) {
  }
  death_animation(player, card) {
  }
  new_round_animation() {
  }
  game_over(winner_order) {
  }
  add_player(name) {
    const player = new Player(name, this.players.length);
    this.players[player.order] = player;
    console.log("added", name, "to game", this.name);
    return player;
  }
  //handle the consequences a non-forced draw
  regular_draw(card) {
    const player = this.players[this.expected_action_player];
    if (!this.check_handle_dead(player, card)) {
      player.cards.push(card);
      if (this.is_action_card(card)) {
        this.expected_action = "use";
      } else {
        this.check_handle_round_over();
      }
    }
    if (card != "f") {
      this.current_turn = this.next_in_turn_order();
    }
    console.log("current_turn has moved to", this.players[this.current_turn].order);
    if (!this.is_action_card(card)) {
      this.expected_action_player = this.current_turn;
    }
  }
  //handle the consequences a forced draw
  //note that while forced draws are happening, current_turn is already on the
  //player that play will resume with after the forced draws are completed
  //TODO: explore restructuring this, it's not clean :(
  force_draw(card) {
    const player = this.players[this.expected_action_player];
    if (this.check_handle_dead(player, card)) {
      this.queue_unplayed_action_cards();
      return;
    }
    player.cards.push(card);
    this.forced_draws[this.forced_draws.length - 1][1]--;
    if (this.check_handle_round_over()) {
      this.expected_action_player = this.current_turn;
      this.expected_action = "draw_or_fold";
      return;
    }
    if (this.forced_draws[this.forced_draws.length - 1][1] < 1) {
      if (this.has_action_card(player)) {
        this.expected_action = "use";
      } else {
        this.queue_unplayed_action_cards();
      }
    }
  }
  queue_unplayed_action_cards() {
    while (this.forced_draws.length > 0) {
      let top_forced_draw = this.forced_draws.pop();
      if (this.has_action_card(this.players[top_forced_draw[2]]) && is_active(this.players[top_forced_draw[2]])) {
        this.expected_action_player = top_forced_draw[2];
        this.expected_action = "use";
        return;
      }
    }
    this.expected_action_player = this.current_turn;
    this.expected_action = "draw_or_fold";
  }
  fold() {
    try {
      const player = this.players[this.expected_action_player];
      player.folded = true;
      this.check_handle_round_over();
      this.current_turn = this.next_in_turn_order();
      this.expected_action_player = this.current_turn;
      return "o";
    } catch (e) {
      console.log(e);
      return "e";
    }
  }
  use(target_order) {
    const player = this.players[this.expected_action_player];
    const target = this.players[target_order];
    let action_card = "";
    for (let card of player.cards) {
      if ([
        "f",
        "s",
        "d"
      ].includes(card)) {
        action_card = card;
        break;
      }
    }
    console.log(player.name, "using", action_card, "on", target.name);
    const action_card_index = player.cards.indexOf(action_card);
    if (action_card_index > -1) {
      let card = player.cards.splice(action_card_index, 1)[0];
      console.log("removed played", card, "from", player.order);
      this.discard(card);
    }
    switch (action_card) {
      case "f":
        target.frozen = true;
        console.log(target.name, "is frozen");
        this.check_handle_round_over();
        this.current_turn = this.next_in_turn_order();
        break;
      case "s":
        target.second_chances++;
        console.log(target.name, " now has", target.second_chances, "second changes");
        break;
      case "d":
        this.forced_draws.push([
          target_order,
          3,
          player.order
        ]);
        this.expected_action_player = target_order;
        this.expected_action = "force_draw";
        console.log(target.name, "needs to draw 3");
        break;
    }
    if (action_card != "d" && !this.has_action_card(player)) {
      this.expected_action_player = this.current_turn;
      this.expected_action = "draw_or_fold";
    }
    return target_order.toString();
  }
  //check for and handle the death of a player from a bad draw (forced or non-forced)
  check_handle_dead(player, card) {
    if (this.is_action_card(card)) {
      return false;
    }
    if (player.cards.includes(card)) {
      console.log("killing", player.name);
      this.discard(card);
      if (player.second_chances > 0) {
        player.second_chances--;
      } else {
        this.deadify(player);
        this.death_animation(player, card);
        this.check_handle_round_over();
      }
      return true;
    }
    return false;
  }
  deadify(player) {
    player.lost = true;
    while (player.cards.length > 0) {
      this.discard(player.cards.shift());
    }
  }
  next_in_turn_order() {
    console.log("finding next turn player");
    let next_player = this.current_turn;
    do {
      next_player = (next_player + 1) % this.players.length;
    } while (!this.active(next_player));
    console.log(next_player, "should go next");
    return next_player;
  }
  active(order) {
    let p = this.players[order];
    return !(p.frozen || p.folded || p.lost);
  }
  is_action_card(card) {
    return card == "f" || card == "s" || card == "d";
  }
  has_action_card(p) {
    return p.cards.includes("f") || p.cards.includes("s") || p.cards.includes("d");
  }
  count_normal_cards(player) {
    let card_count = 0;
    player.cards.forEach((card) => {
      if (isFinite(Number(card)) && !card.startsWith("+")) {
        card_count++;
      }
    });
    return card_count;
  }
  discard(card) {
    this.discard_top = card;
  }
  check_handle_round_over() {
    let all_dead = true;
    let seven_cards = false;
    console.log("checking round over");
    for (let p of this.players) {
      if (this.active(p.order)) {
        console.log(p.order, "is still kicking");
        all_dead = false;
      }
      if (!seven_cards) {
        seven_cards = this.count_normal_cards(p) > 6;
      }
    }
    if (all_dead || seven_cards) {
      console.log("round is over!");
      this.sum_scores();
      this.reset_players();
      this.round_number++;
      if (this.check_handle_game_over()) {
        if (this.winner_order !== null) {
          console.log("Game is over", this.players[this.winner_order].name, "won");
          this.game_over(this.winner_order);
        }
        console.log("after game over");
      } else {
        this.new_round_animation();
      }
      console.log("returning true");
      return true;
    }
    return false;
  }
  check_handle_game_over() {
    let highest_scoring_player = 0;
    for (let i = 1; i < this.players.length; i++) {
      if (this.players[i].score > this.players[highest_scoring_player].score) {
        highest_scoring_player = i;
      }
    }
    if (this.players[highest_scoring_player].score >= 200) {
      this.winner_order = highest_scoring_player;
      return true;
    }
    return false;
  }
  sum_scores() {
    for (let p of this.players) {
      p.score += this.calc_score(p);
      if (this.count_normal_cards(p) > 6) {
        console.log(p.name, "got 7 cards! that's +15");
        this.seven_cards_animation(p);
        p.score += 15;
      }
    }
  }
  reset_players() {
    for (let p of this.players) {
      while (p.cards.length > 0) {
        this.discard(p.cards.shift());
      }
      p.second_chances = 0;
      p.lost = false;
      p.frozen = false;
      p.folded = false;
    }
    this.forced_draws = [];
  }
  calc_score(player) {
    let score = 0;
    let multiplier = 1;
    for (let card of player.cards) {
      if (card === "x2") {
        multiplier = 2;
      }
      if (!isNaN(Number(card))) {
        score += parseInt(card);
      }
    }
    return score * multiplier;
  }
  static build_deck() {
    let deck = [];
    for (let i = 0; i < 3; i++) {
      deck.push("f");
      deck.push("s");
      deck.push("d");
    }
    deck.push("x2");
    for (let i = 2; i <= 10; i += 2) {
      deck.push("+" + i);
    }
    deck.push("0");
    for (let i = 1; i <= 12; i++) {
      for (let j = 0; j < i; j++) {
        deck.push(String(i));
      }
    }
    return deck;
  }
};
