# Turn Over More Than 6: client

The browser UI for Turn Over More Than 6, a multiplayer push-your-luck card game. This repository is
published with GitHub Pages at [tomt6.umbriac.com](https://tomt6.umbriac.com).

It holds the contents of the `client/` directory of the main repository,
[Turn-Over-More-Than-6](https://github.com/TheRealMothebad/Turn-Over-More-Than-6), which also contains
the server, the game rules and a fuller description of the project.

## The game

On your turn you either draw a card or fold. Number cards are worth their value, but drawing a number
you already hold busts you for the round. Folding banks your points. Action cards (Freeze, Draw Three,
Second Chance) are played on any player still in the round. Seven different number cards ends the round
with a 15 point bonus, and the game ends after the first round in which someone reaches 200 points.

## How it works

Plain HTML, CSS and JavaScript, with no build step and no dependencies.

```
index.html, index.js, lobby.css    choose a username, then join or create a lobby
game.html, game.js, table.css      the waiting room and the card table
game.shared.js                     the game rules, bundled from shared/game.ts in the main repository
demo.js                            an offline game against bots: game.html?demo
```

The rules in `game.shared.js` are the same code the server runs. The server sends only what happened on
each move (the card drawn, a fold, the target of an action card), and the client applies it to its own
copy of the game to stay in step. `game.shared.js` is generated, so change the rules in the main
repository rather than here, and deploy the server and this client together when they change.

## Credits

The game logic, server and protocol were written by John Umbriac. The user interface was written by
Claude, Anthropic's AI model, working to John's direction.
