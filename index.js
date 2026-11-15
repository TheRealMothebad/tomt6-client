"use strict";
//Server browser: pick a username, then join or create a lobby.

console.log("client starting");
let api_url = "https://tomt6-api.umbriac.com";
if (window.IS_DEV) {
  console.log('Development environment detected, using localhost.');
  api_url = 'http://localhost:8080';
}

const page = document.getElementById("lobby-page");
const name_card = document.getElementById("name-card");
const name_input = document.getElementById("username");
const browser = document.getElementById("browser");
const lobby_name_input = document.getElementById("new_lobby_name");
const list_container = document.getElementById("game-list-container");
const live_status = document.getElementById("live-status");
const errors = document.getElementById("errors");

const reduced_motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
//what the lobby list last showed, so it is only redrawn when something changed
let last_list = null;
let entering = false;

// ---------- stage 1: choose a username ----------

//remember the name from last time, the player just has to press enter
name_input.value = load_name();
name_input.focus();
name_input.select();

document.getElementById("name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = name_input.value.trim();
  if (!username) {
    name_input.focus();
    return;
  }
  name_input.value = username;
  save_name(username);
  if (page.classList.contains("stage-name")) {
    show_browser();
  } else {
    //already browsing, enter just confirms an edited name
    name_input.blur();
  }
});

//the suggested lobby name follows the username until the player types a lobby name of their own
let suggested_lobby_name = "";
function suggest_lobby_name() {
  const username = name_input.value.trim();
  if (lobby_name_input.value === suggested_lobby_name) {
    suggested_lobby_name = username ? `${username}'s game`.slice(0, 25) : "";
    lobby_name_input.value = suggested_lobby_name;
  }
}
name_input.addEventListener("input", suggest_lobby_name);

//the name stays editable in the header after the first stage
name_input.addEventListener("change", () => {
  if (name_input.value.trim()) {
    save_name(name_input.value.trim());
  }
});

function load_name() {
  try {
    return localStorage.getItem("username") || "";
  } catch (e) {
    return "";
  }
}

function save_name(username) {
  try {
    localStorage.setItem("username", username);
  } catch (e) {}
}

// ---------- the glide from stage 1 to stage 2 ----------

function show_browser() {
  const before = name_card.getBoundingClientRect().top;

  page.classList.replace("stage-name", "stage-browse");
  document.getElementById("name-label").textContent = "Playing as";
  browser.hidden = false;
  browser.classList.add("entering");
  suggest_lobby_name();

  //the prompt is now laid out at the top of the page. start it back where it was and let it glide up
  const after = name_card.getBoundingClientRect().top;
  if (!reduced_motion) {
    name_card.animate(
      [{ transform: `translateY(${before - after}px)` }, { transform: "translateY(0)" }],
      { duration: 650, easing: "cubic-bezier(.4,0,.2,1)" }
    );
  }
  //the lobby list fades in underneath once the prompt is on its way
  void browser.offsetWidth;
  browser.classList.remove("entering");
  name_input.blur();
}

// ---------- stage 2: the lobby list ----------

get_lobbies();
setInterval(get_lobbies, 1000);

async function get_lobbies() {
  try {
    const response = await fetch(`${api_url}/games`);
    if (!response.ok) {
      throw new Error("bad response " + response.status);
    }
    const data = await response.json();
    render_lobbies(data.lobbies || []);
    live_status.textContent = "Live";
    live_status.classList.remove("down");
  } catch (error) {
    console.error("Error fetching lobby list:", error);
    live_status.textContent = "Can't reach the server";
    live_status.classList.add("down");
    render_lobbies(null);
  }
}

function render_lobbies(lobbies) {
  const key = JSON.stringify(lobbies);
  if (key === last_list) {
    return;
  }
  last_list = key;
  list_container.innerHTML = "";

  if (!lobbies || lobbies.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    const title = document.createElement("strong");
    title.textContent = lobbies ? "No open lobbies right now" : "Lobby list unavailable";
    const hint = document.createElement("span");
    hint.textContent = lobbies ? "Start one below and share the name with your friends." : "Trying again every second...";
    empty.append(title, hint);
    list_container.appendChild(empty);
    return;
  }

  for (const lobby of lobbies) {
    const row = document.createElement("div");
    row.className = "lobby-row";
    const info = document.createElement("div");
    info.className = "lobby-info";
    const name = document.createElement("div");
    name.className = "lobby-name";
    name.textContent = lobby.name;
    const players = document.createElement("div");
    players.className = "lobby-players";
    players.textContent = `${lobby.playerCount} player${lobby.playerCount === 1 ? "" : "s"} waiting`;
    info.append(name, players);

    const join_button = document.createElement("button");
    join_button.type = "button";
    join_button.className = "btn primary";
    join_button.textContent = "Join";
    join_button.onclick = () => enter_lobby('join', lobby.uuid);

    row.append(info, join_button);
    list_container.appendChild(row);
  }
}

document.getElementById("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  enter_lobby('create');
});

function show_error(text) {
  errors.textContent = text || "";
}

async function enter_lobby(action, game_uuid = null) {
  if (entering) {
    return;
  }
  const username = name_input.value.trim();
  if (!username) {
    show_error("Please enter a username.");
    name_input.focus();
    return;
  }
  save_name(username);

  let body;
  if (action === 'create') {
    const game_name = lobby_name_input.value.trim();
    if (!game_name) {
      show_error("Please enter a lobby name.");
      lobby_name_input.focus();
      return;
    }
    body = { game_name: game_name, username: username };
  } else if (action === 'join') {
    if (!game_uuid) {
      show_error("Lobby UUID is missing.");
      return;
    }
    body = { game_uuid: game_uuid, username: username };
  } else {
    //bad, should not get here
    return;
  }

  entering = true;
  show_error("");
  try {
    const response = await fetch(`${api_url}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-type": "application/json; charset=UTF-8" },
    });
    if (!response.ok) {
      show_error(await response.text());
      return;
    }
    const data = await response.json();
    console.log(`Received data from /${action}:`, data);
    const uuid = data.host_uuid || data.player_uuid;
    if (!uuid) {
      console.error("UUID not found in server response.");
      show_error("Failed to get a valid ID from the server.");
      return;
    }
    localStorage.setItem("uuid", uuid);
    sessionStorage.setItem("uuid", uuid);
    window.location.href = `game.html?uuid=${uuid}`;
  } catch (error) {
    console.error(`Error ${action}ing lobby:`, error);
    show_error(action === 'create' ? "Could not create the lobby." : "Could not join the lobby.");
  } finally {
    entering = false;
  }
}
