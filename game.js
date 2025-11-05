
const uuid = getParam("uuid");
let your_tile_color = "purple";
let socket;
let socket_url = "wss://tomt6.umbriac.com/game";
if (window.IS_DEV) {
  console.log('Development environment detected, using localhost.');
  socket_url = 'ws://localhost:8080/game';
}


const lobby_screen = document.getElementById("lobby-screen");
const game_screen = document.getElementById("game-screen");

socket = new WebSocket(socket_url);
const message = JSON.stringify({"uuid": uuid});
socket.onopen = () => {
  socket.send(message);
  socket.send(JSON.stringify({"action":"state"}));
};

socket.onmessage = (e) => {
  let parsed = JSON.parse(e.data);
  console.log("Received:", parsed);

  //check if this is a lobby
  if (parsed.game && !parsed.game.started) {
    document.getElementById("welcomeMessage").textContent = `Welcome ${parsed.game.players[parsed.game.you].name}, waiting for game to start...`;
    const player_list = document.getElementById("player-list");
    //reset player list to blank so it can be repopulated
    player_list.innerHTML = "";
    parsed.game.players.forEach(p => {
      console.log(p);
      const player_line = document.createElement("p")
      player_line.textContent = `${p.connected ? "🔗" : "🔌"} ${p.name} ${parsed.game.host == p.order ? "👑" : ""}`;
      player_list.appendChild(player_line);
    });
    if (parsed.game.host == parsed.game.you) {
      document.getElementById("start-game-button").style.display = "block";
    }
    //only handle lobby stuff
    return;
  }

  lobby_screen.style.display = "none";
  game_screen.style.display = "block";

  const actionFeed = document.getElementById("action-feed");

  if (parsed.action) { // A single new action
    const newMessage = document.createElement("p");
    newMessage.textContent = generate_action_message(parsed.action, parsed.game);
    actionFeed.prepend(newMessage);
  } else if (parsed.game && parsed.game.actions_log) { // Initial state with action log
    actionFeed.innerHTML = ''; // Clear the feed before populating
    for (const action of parsed.game.actions_log) {
      const newMessage = document.createElement("p");
      newMessage.textContent = generate_action_message(action, parsed.game);
      actionFeed.prepend(newMessage);
    }
  }

  pretty_print(parsed.game);
  //document.getElementById("not_pretty").textContent = JSON.stringify(parsed);
};

function generate_action_message(action, game) {
  if (!action) {
    return "";
  }

  const actorName = game.players[action.actor] ? game.players[action.actor].name : "Unknown Player";

  switch (action.action) {
    case "start":
      return `The game has started. ${actorName} goes first`;
    case "draw":
      return `${actorName} drew the card ${fancy_name(action.card)}.`;
    case "fold":
      return `${actorName} folded.`;
    case "use":
      const targetName = game.players[action.target] ? game.players[action.target].name : "Unknown Player";
      return `${actorName} used ${fancy_name(action.card)} on ${targetName}.`;
    case "shuffle":
      return "The discard pile was shuffled into the deck.";
    case "connect":
      if (action.target == 1) {
        return `${actorName} connected.`;
      }
      else {
        return `${actorName} disconnected.`;
      }
    case "die":
      return `${actorName} died from drawing another ${fancy_name(action.card)}`
    case "end":
      return `Game has ended! ${actorName} won with a score of ${game.players[action.actor].score}!`
    default:
      return ``;
  }
}

function start_game() {
  console.log("attempting to start game");
  socket.send(JSON.stringify({"action":"start"}));
}

function draw() {
  console.log("attempting draw");
  socket.send(JSON.stringify({"action":"draw"}));
}
function fold() {
  console.log("attempting fold");
  socket.send(JSON.stringify({"action":"fold"}));
}
function use(order_target) {
  console.log("use on", order_target);
  socket.send(JSON.stringify({"action":"use", "target":order_target}));
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

function pretty_print(game) {
  const playersContainer = document.getElementById("players-container");
  playersContainer.innerHTML = ""; // Clear previous content

  for (const player of game.players) {
    const playerContainer = document.createElement("div");
    playerContainer.classList.add("player-box");

    const nameHeader = document.createElement("h3");
    let nameText = player.name;
    if (game.forced_draws && game.forced_draws[0] === player.order) {
      nameText += " <- Forced Draws";
      playerContainer.classList.add("current-turn");
    } else if (player.order === game.current_player) {
      playerContainer.classList.add("current-turn");
    }

    if (player.frozen || player.folded || player.lost) {
      nameHeader.classList.add("inactive-player");
    }

    if (player.order === game.you) {
      nameText = "(You) " + nameText;
      playerContainer.classList.add("is-you");
      playerContainer.style.backgroundColor = your_tile_color;
    }
    nameHeader.textContent = nameText;
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
    if (player.connected) {
      statusDiv.innerHTML += '<span title="Connected">🔗</span>';
    } else {
      statusDiv.innerHTML += '<span title="Disconnected">🔌</span>';
    }
    if (player.frozen) {
      statusDiv.innerHTML += '<span title="Frozen">❄️</span>';
    }
    if (player.folded) {
      statusDiv.innerHTML += '<span title="Folded">🛑</span>';
    }
    playerContainer.appendChild(statusDiv);

    // Add the "Use on this player" button
    const useButton = document.createElement("button");
    useButton.textContent = `Use on ${player.name}`;
    useButton.onclick = () => use(player.order); // Call use function with player's order
    playerContainer.appendChild(useButton);

    playersContainer.appendChild(playerContainer);
  }


  document.getElementById("not_pretty").innerHTML = `
      discard pile: ${fancy_name(game.top_discard) ?? ""}<br>
      round number: ${game.round_number}
      `;
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


