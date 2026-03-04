const uuid = getParam("uuid");
let your_tile_color = "purple";
let socket_url = "wss://tomt6.umbriac.com/game";
if (window.IS_DEV) {
  console.log('Development environment detected, using localhost.');
  socket_url = 'ws://localhost:8080/game';
}

const lobby_screen = document.getElementById("lobby-screen");
const game_screen = document.getElementById("game-screen");
const actionFeed = document.getElementById("action-feed");


let socket = new WebSocket(socket_url);
let game;
let valid_cards = new Set(Game.build_deck());

//when the connection is opened immediately send the uuid
socket.onopen = () => {
  socket.send(uuid);
};

socket.onmessage = (e) => {
  let message  = e.data;
  console.log("Received:", message);

  if (message.length === 0) {
      console.log("ERROR: Empty message from server");
      return;
  }

  //events that can happen at any time
  switch(message.charAt(0)) {
    case "{":
      //game data
      let parsed_game = JSON.parse(message);
      Object.setPrototypeOf(parsed_game, Game.prototype);
      game = parsed_game;
      console.log("got new game data", game);
      break;
    case "c":
      //player connected
      game.players[+message.slice(1)].connected = true;
      break;
    case "l":
      //player disconnected (left)
      game.players[+message.slice(1)].connected = false;
      break;
  }

  //if the game object has not been sent then we got problems
  if (!game) {
    console.log("ERROR: Game data undefined unexpectedly");
    //send the reset message (maybe the socket should be closed instead? not sure)
    socket.send("r");
    return;
  }

  if (game.expected_action === "start_game" && !message.startsWith("{")) {
    //events that can only happen in lobby mode
    switch (message.charAt(0)) {
      case "p":
        //new player joined
        //get the player data (this is quite inefficient, will need to be reworked soon
        let player = JSON.parse(message.slice(1))
        game.players[player.order] = player;
        break;
      case "g":
        //game started (go!)
        game.expected_action = "draw_or_fold";
        game.expected_action_player = 0;
        emmit_action_message(`The game has started. ${current_player().name} goes first`);
        break;
    }
  }
  else {
    //events that can only happen when the game is running
    switch (message) {
      case "shuffle":
        //deck is shuffled
        emmit_action_message("The discard pile was shuffled into the deck.");
        //play an animation here or smth
        break;
      case "o":
        //fail if a fold is not expected here
        if (game.expected_action !== "draw_or_fold") {
          console.log("ERROR: Unexpected fold")
          socket.send("r");
          return;
        }
        //player folded
        emmit_action_message(`${game.players[game.expected_action_player].name} folded.`);
        game.fold();
        break;
      default:
        //don't attempt to handle the non-game messages we already handled above
        //total spaghetti, needs to be refactored
        if (message.startsWith("{") || message.startsWith("c") || message.startsWith("l")) {
          break;
        }
        //likely a drawn card, or a player order number for use, check for each
        if (game.expected_action === "draw_or_fold" || game.expected_action === "force_draw") {
          if (valid_cards.has(message)) {
            emmit_action_message(`${current_player().name} drew the card ${fancy_name(message)}.`);
            game.expected_action === "draw_or_fold" ? game.regular_draw(message) : game.force_draw(message);
          }
          else {
            console.log("ERROR: invalid card received, instead got", message);
            socket.send("r");
            return;
          }
        }
        else if (game.expected_action === "use") {
          if (!isNaN(+message) && +message < game.players.length) {
            emmit_action_message(`${current_player().name} used ${fancy_name(first_action_card(current_player()))} on ${game.players[+message].name}.`);
            console.log("using on", +message)
            game.use(+message);
          }
          else {
            console.log("ERROR: Expected use order, instead got", message);
            socket.send("r");
            return;
          }
        }
    }
  }

  //check if this is a lobby
  if (game.expected_action === "start_game") {
    document.getElementById("welcomeMessage").textContent = `Welcome ${game.players[game.you].name}, waiting for game to start...`;
    const player_list = document.getElementById("player-list");
    //reset player list to blank so it can be repopulated
    player_list.innerHTML = "";
    console.log(game.players);
    game.players.forEach(p => {
      console.log(p);
      const player_line = document.createElement("p")
      player_line.textContent = `${p.connected ? "🔗" : "🔌"} ${p.name} ${game.host_order === p.order ? "👑" : ""}`;
      player_list.appendChild(player_line);
    });
    if (game.host_order === game.you) {
      document.getElementById("start-game-button").style.display = "block";
    }
    //only handle lobby stuff
    return;
  }

  lobby_screen.style.display = "none";
  game_screen.style.display = "block";

  pretty_print(game);
  return;

  if (game && game.actions_log) { // Initial state with action log
    actionFeed.innerHTML = ''; // Clear the feed before populating
    for (const action of game.actions_log) {
      const newMessage = document.createElement("p");
      newMessage.textContent = generate_action_message(action, game);
      actionFeed.appendChild(newMessage);
    }
    if (actionFeed.lastChild) {
      actionFeed.lastChild.classList.add("highlight");
    }
    actionFeed.scrollTop = actionFeed.scrollHeight;
  }

  pretty_print(game);
  //document.getElementById("not_pretty").textContent = JSON.stringify(parsed);
};

function emmit_action_message(message) {
  const old_highlight = document.querySelector(".highlight");
  if (old_highlight) {
    old_highlight.classList.remove("highlight");
  }
  const newMessage = document.createElement("p");
  newMessage.textContent = message;
  newMessage.classList.add("highlight");
  actionFeed.appendChild(newMessage);
  actionFeed.scrollTop = actionFeed.scrollHeight;
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

function start_game() {
  console.log("attempting to start game");
  socket.send("s");
}

function draw() {
  console.log("attempting draw");
  socket.send("d");
}
function fold() {
  console.log("attempting fold");
  socket.send("f");
}
function use(order_target) {
  console.log("use on", order_target);
  socket.send(order_target);
}

function change_color(color) {
  const isYouBox = document.querySelector('.is-you');
  if (isYouBox) {
    isYouBox.style.backgroundColor = color;
  }
  your_tile_color = color;
}

function fancy_name(card) {
  switch(card) {
    case "f":
      return "freeze";
    case "d":
      return "draw three";
    case "s":
      return "second life";
  }
  return card;
}

function is_active(player) {
  return !(player.lost || player.frozen || player.folded)
}

function pretty_print(game) {
  const playersContainer = document.getElementById("players-container");
  playersContainer.innerHTML = ""; // Clear previous content

  const drawButton = document.getElementById("draw_button");
  const foldButton = document.getElementById("fold_button");

  if (drawButton) drawButton.disabled = true;
  if (foldButton) foldButton.disabled = true;

  if (game.expected_action_player === game.you && drawButton && foldButton) {
    if (game.expected_action === "draw_or_fold" || game.expected_action === "force_draw") {
      drawButton.disabled = false;
    }
    if (game.expected_action === "draw_or_fold") {
      foldButton.disabled = false;
    }
  }

  for (const player of game.players) {
    const playerContainer = document.createElement("div");
    playerContainer.classList.add("player-box");

    if (game.expected_action_player === player.order) {
      playerContainer.classList.add("current-turn");
    }

    const nameHeader = document.createElement("h3");
    let nameText = player.name;
    let active_forced_draw = game.forced_draws[game.forced_draws.length - 1]
    if (active_forced_draw &&  active_forced_draw[0] === player.order) {
      nameText += ` <- ${active_forced_draw[1]} Forced Draw${active_forced_draw[1] > 1 ? "s" : ""}`;
    }

    if (!is_active(player)) {
      nameHeader.classList.add("inactive-player");
    }

    if (player.order === game.you) {
      nameText = "(You) " + nameText;
      playerContainer.classList.add("is-you");
      playerContainer.style.backgroundColor = your_tile_color;
    }
    nameHeader.textContent = (player.connected ? "🔗" : "🔌") + nameText;
    playerContainer.appendChild(nameHeader);

    const attributesP = document.createElement("p");
    attributesP.innerHTML = `
          Cards: ${player.cards.map(fancy_name).join(", ")}<br>
          Second Chances: ${player.second_chances}<br>
          Score: ${player.score}
        `;
    playerContainer.appendChild(attributesP);

    const statusDiv = document.createElement("div");
    statusDiv.classList.add("player-status-icons");
    if (player.frozen) {
      statusDiv.innerHTML += '<span title="Frozen">❄️</span>';
    }
    if (player.folded) {
      statusDiv.innerHTML += '<span title="Folded">🛑</span>';
    }
    if (player.lost) {
      statusDiv.innerHTML += '<span title="Lost">💀</span>';
    }
    if (player.second_chances > 0) {
      statusDiv.innerHTML += `<span title="Second Chances">♥️x${player.second_chances}</span>`;
    }
    playerContainer.appendChild(statusDiv);

    if (game.expected_action_player === game.you &&
      game.expected_action === "use" &&
      is_active(player)) {
      const useButton = document.createElement("button");
      useButton.textContent = `Use on ${player.name}`;
      useButton.onclick = () => use(player.order); // Call use function with player's order
      playerContainer.appendChild(useButton);
    }

    playersContainer.appendChild(playerContainer);
  }

  document.getElementById("not_pretty").innerHTML = `
      discard pile: ${fancy_name(game.discard_top) ?? ""}<br>
      round number: ${game.round_number}
      `;
}

Game.prototype.seven_cards_animation = function(player) {
  emmit_action_message(`${player.name} drew 7 number cards and ended the round with 15 extra points!`);
  //do nothing
}

Game.prototype.death_animation = function(player, card) {
  emmit_action_message(`${player.name} died from drawing another ${fancy_name(card)}`)
  //do nothing
}

Game.prototype.new_round_animation = function () {
  emmit_action_message(`Round ${game.round_number - 1} has ended, starting round ${game.round_number}`)
}

Game.prototype.game_over = function(winner_order) {
  console.log(game.players[winner_order].name, "won!");
  emmit_action_message(`Game has ended! ${game.players[winner_order].name} won with a score of ${game.players[winner_order].score}!`);
  
  document.getElementById("draw_button").style.display = "none";
  document.getElementById("fold_button").style.display = "none";
  
  let button_box = document.getElementById("controls");
  let gameOverDiv = document.getElementById("game-over-message");
  if (!gameOverDiv) {
    gameOverDiv = document.createElement("div");
    gameOverDiv.id = "game-over-message";
    button_box.appendChild(gameOverDiv);
  }
  
  gameOverDiv.innerHTML = `Game has ended, ${game.players[winner_order].name} has won! <button type="button" onclick="window.location.href='index.html'">Play again</button>`;
  //do nothing
}

function getParam(param) {
  const urlParams = new URLSearchParams(window.location.search);
  let res = urlParams.get(param);
  if (res) {return res;}
  console.log("Could not get", param, "from url, trying localStorage");
  res = localStorage.getItem(param)
  if (res) {return res;}
  console.log("Could not get", param, "from localStorage, trying sessionStorage");
  res = sessionStorage.getItem(param);
  if (res) {return res;}
  console.log("Could not get", param, "from session storage. I guess that's it then");
  return res;
}


