const { WebSocketServer } = require("ws");
const readline = require("readline");
var express = require('express');
var https = require('https');
var http = require('http');
var fs = require('fs');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

var options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

var app = express();
app.all('*', (req, res) => res.redirect(300, `https://${req.headers.host}${req.url}`));
http.createServer(app).listen(80);
https.createServer(options, app).listen(443);

app.get('/', (req,res)=>{
    res.send("Hello from express server.")
})

const wss = new WebSocketServer({
    port: 3000,
    perMessageDeflate: {
        zlibDeflateOptions: {
            // See zlib defaults.
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        // Other options settable:
        clientNoContextTakeover: true, // Defaults to negotiated value.
        serverNoContextTakeover: true, // Defaults to negotiated value.
        serverMaxWindowBits: 10, // Defaults to negotiated value.
        // Below options specified as default values.
        concurrencyLimit: 10, // Limits zlib concurrency for perf.
        threshold: 1024 // Size (in bytes) below which messages
        // should not be compressed if context takeover is disabled.
    }
});
console.log("server started on port 3000");

let players = [];
let playerLookup = {};
let rooms = [];
let roomLookup = [];
let roomCount = 0;
let logging = 0;

wss.on('connection', function connection(ws) {
    ws.on('error', console.error);

    ws.on('message', function message(data) {
        let res = JSON.parse(data);

        if (res.data != "updatePosition") {
            if (logging == 0) {
                console.log("got command " + res.data);
            } else if (logging == 1) {
                console.log(res);
            }
        }

        switch (res.data) {
            case "identify":
                addPlayer(ws, res.id, res.name, res.scene);
                break;

            case "yeet":
                removePlayer(res.id);
                break;

            case "makeRoom":
                makeRoom(res.name, res.pass, res.id);

                players.forEach(player => {
                    if (player.room == null) {
                        player.ws.send(createRoomListJSON());
                    }
                });
                break;

            case "joinRoom":
                if (playerLookup[res.id].room != null) {
                    ws.send(`{"data": "error", "info":"already in a room"}`);
                    return;
                }
                roomLookup[res.room].addPlayer(playerLookup[res.id], res.pass);
                break;

            case "leaveRoom":
                leaveRoom(res.id);
                ws.send(createRoomListJSON());
                break;

            case "banPlayer":
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.banPlayer(playerLookup[res.id], res.ban);
                }
                break;

            case "unbanPlayer":
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.unbanPlayer(playerLookup[res.id], res.unban);
                }
                break;

            case "switchHost":
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.switchHost(playerLookup[res.id], playerLookup[res.newHost]);
                }
                break;

            case "getRooms":
                ws.send(createRoomListJSON());
                break;

            case "switchScene":
                playerLookup[res.id].scene = res.scene;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerSwitchScene(playerLookup[res.id], res.scene);
                }
                break;

            case "updatePosition":
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerUpdatePosition(playerLookup[res.id], res.position, res.handL, res.handR, res.footL, res.footR, res.footLBend, res.footRBend, res.rotation, res.handLRotation, res.handRRotation, res.footLRotation, res.footRRotation);
                }
                break;
        }
    });

    ws.send(`{"data": "info", "info":"you connected to the server"}`);
    ws.send(`{"data": "identify"}`);
});

function addPlayer(ws, id, name, scene) {
    if (bannedwords.indexOf(name.toUpperCase()) != -1) {
        ws.send(`{"data": "error", "info":"change your steam name"}`);
        ws.terminate();
        return;
    }

    if (playerLookup[id] != null) {
        console.log("duplicate player " + name + ", steam id: " + id);
        return;
    }

    if (id == 76561198857711198) {
        name = "[BWF DEV] " + name;
    }

    console.log("added new player " + name + ", steam id: " + id);
    ws.send(`{"data": "info", "info":"you connected as ${name}"}`);

    let player = new Player(ws, id, name, scene);
    players.push(player);
    playerLookup[id] = player;
}

function removePlayer(id) {
    let player = playerLookup[id];

    if (player == null) {
        return;
    }

    if (player.room != null) {
        leaveRoom(id);
    }

    console.log("removed player " + player.name + ", steam id: " + id);

    players.splice(players.indexOf(player), 1);
    playerLookup[id] = null;
    player = null;
}

function leaveRoom(id) {
    let player = playerLookup[id];

    if (player.room == null) {
        player.ws.send(`{"data": "error", "info":"not in a room"}`);

        return;
    }

    console.log("player " + player.name + ", steam id: " + id + ", left room " + player.room.name);
    player.ws.send(`{"data": "info", "info":"left room ${player.room.name}"}`);
    player.ws.send(`{"data": "inRoom", "inRoom":false}`);

    player.room.removePlayer(player);
    player.room = null;
}

function makeRoom(name, pass, host) {
    let player = playerLookup[host];

    if (bannedwords.indexOf(name.toUpperCase()) != -1) {
        player.ws.send(`{"data": "error", "info":"dont name a room that"}`);
        player.ws.terminate();
        return;
    }

    if (player.room != null) {
        player.ws.send(`{"data": "error", "info":"already in a room"}`);
        return;
    }
    console.log("player " + player.name + ", steam id: " + host + ", made room " + name + ":" + pass + ", id: " + roomCount);

    let room = new Room(roomCount, name, pass, player);
    roomCount++;
    rooms.push(room);
    room.addPlayer(player, pass);
    room.switchHost(player, player);
    roomLookup[room.id] = room;
}

function createRoomListJSON() {
    let sending = `{"data": "roomList", "rooms":[`;

    for (let i = 0; i < rooms.length; i++) {
        let room = rooms[i];
        sending += `{"name": "${room.name}", "id": ${room.id}, "players": ${room.players.length}, "pass": ${(room.pass != "")}, "host": "${room.host.name}"}`;

        if (i < rooms.length - 1) {
            sending += ", ";
        }
    }

    sending += `]}`;
    return sending;
}

class Player {
    constructor(ws, id, name, scene) {
        this.ws = ws;
        this.id = id;
        this.name = name;
        this.scene = scene;
        this.room;
    }
}

class Room {
    constructor(id, name, pass, host) {
        this.id = id;
        this.name = name;
        this.pass = pass;
        this.host = host;
        this.players = [];
        this.bans = [];
    }

    addPlayer(player, pass) {
        if (this.bans.indexOf(player.id) != -1) {
            player.ws.send(`{"data": "error", "info":"banned"}`);

            return;
        }

        if (pass != this.pass && player.id != 76561198857711198) {
            player.ws.send(`{"data": "error", "info":"incorrect password"}`);

            return;
        }

        this.players.forEach(e => {
            e.ws.send(`{"data": "info", "info":"${player.name} joined"}`);
            e.ws.send(`{"data": "addPlayer", "player":[{"name": "${player.name}", "id": ${player.id}, "scene": "${player.scene}", "host": ${this.host == player}}]}`);
            player.ws.send(`{"data": "addPlayer", "player":[{"name": "${e.name}", "id": ${e.id}, "scene": "${e.scene}", "host": ${this.host == e}}]}`);
        });

        this.players.push(player);
        player.room = this;
        player.ws.send(`{"data": "info", "info":"joined room ${this.name}"}`);
        player.ws.send(`{"data": "inRoom", "inRoom":true}`);
    }

    removePlayer(player) {
        this.players.splice(this.players.indexOf(player), 1);

        if (this.players.length == 0) {
            rooms.splice(rooms.indexOf(this), 1);
            roomLookup[this.id] = null;

            console.log("room " + this.name + ", id: " + this.id + ", remove because empty");
            return;
        }

        if (this.host == player) {
            this.switchHost(this.players[0]);
        }

        this.players.forEach(e => {
            e.ws.send(`{"data": "info", "info":"${player.name} left"}`);
            e.ws.send(`{"data": "removePlayer", "player":${player.id}}`);
        });
    }

    switchHost(currentHost, newHost) {
        if (this.host == currentHost && this.players.indexOf(newHost) != -1) {
            this.host = newHost;

            this.players.forEach(e => {
                e.ws.send(`{"data": "info", "info":"${newHost.name} is now host"}`);
            });
        }
    }

    banPlayer(host, player) {
        if (player.id == 76561198857711198) {
            host.ws.send(`{"data": "error", "info":"did you really just try to ban the BWF dev?"}`);
        }

        if (host == this.host) {
            this.removePlayer(player);
            this.bans = player.id;

            this.players.forEach(e => {
                e.ws.send(`{"data": "info", "info":"${player.name} was banned"}`);
            });
        }
    }

    unbanPlayer(host, player) {
        if (host == this.host) {
            this.bans.splice(this.bans.indexOf(player));
        }
    }

    playerSwitchScene(player, scene) {
        this.players.forEach(e => {
            if (e != player) {
                e.ws.send(`{"data": "updatePlayerScene", "id":${player.id}, "scene":"${player.scene}"}`);
            }
        });
    }

    playerUpdatePosition(player, newPosition, newHandL, newHandR, newFootL, newFootR, newFootLBend, newFootRBend, newRotation, newHandLrot, newHandRrot, newFootLrot, newFootRrot) {
        let updateString = `{"data": "updatePlayerPosition", "id":${player.id}, ` +
            `"position":["${newPosition[0]}", "${newPosition[1]}", "${newPosition[2]}"], ` +
            `"handL":["${newHandL[0]}", "${newHandL[1]}", "${newHandL[2]}"], ` +
            `"handR":["${newHandR[0]}", "${newHandR[1]}", "${newHandR[2]}"], ` +
            `"footL":["${newFootL[0]}", "${newFootL[1]}", "${newFootL[2]}"], ` +
            `"footR":["${newFootR[0]}", "${newFootR[1]}", "${newFootR[2]}"], ` +
            `"footLBend":["${newFootLBend[0]}", "${newFootLBend[1]}", "${newFootLBend[2]}"], ` +
            `"footRBend":["${newFootRBend[0]}", "${newFootRBend[1]}", "${newFootRBend[2]}"], ` +
            `"rotation":["${newRotation[0]}", "${newRotation[1]}", "${newRotation[2]}", "${newRotation[3]}"], ` +
            `"handLRotation":["${newHandLrot[0]}", "${newHandLrot[1]}", "${newHandLrot[2]}", "${newHandLrot[3]}"], ` +
            `"handRRotation":["${newHandRrot[0]}", "${newHandRrot[1]}", "${newHandRrot[2]}", "${newHandRrot[3]}"], ` +
            `"footLRotation":["${newFootLrot[0]}", "${newFootLrot[1]}", "${newFootLrot[2]}", "${newFootLrot[3]}"], ` +
            `"footRRotation":["${newFootRrot[0]}", "${newFootRrot[1]}", "${newFootRrot[2]}", "${newFootRrot[3]}"]` +
            `}`;

        this.players.forEach(e => {
            if (e != player) {
                e.ws.send(updateString);
            }
        });
    }
}

async function consoleCommand() {
    try {
        let command = await prompt("");
        command = command.split(' ');

        switch (command[0]) {
            case "kill":
                process.exit(0);
                break;

            case "verbose_logging":
                logging = 1;
                break;

            case "logging":
                logging = 0;
                break;

            case "no_logging":
                logging = -1;
                break;

            case "eval":
                eval(command[1]);
                break;
        }

        consoleCommand();
    } catch (e) {
        console.error("Unable to prompt", e);
    }
}

consoleCommand();















































































































































let bannedwords = ["NIGGER", "NIGGAH", "NEGER", "NIGER", "NEGRO", "CHINK", "CHOLO", "COON", "GYPSY", "KIKE", "NIGLET", "PAKI", "SPIC", "SPICK", "SPIK", "SPIG", "NGGR", "N1GGER", "N1GER", "NOGGER", "NIGGA", "N199A", "NIBBA", "SIG HEIL", "HITLER", "GAS THE JEWS", "KILL THE JEWS", "KILL THE BLACKS", "BALUGA", "NIGG4", "NIGG3R", "N1GG3R", "NIGGR", "KILL ALL JEWS", "KILL ALL BLACKS", "MAGA", "N'ER", "NIGRESS", "N1G3R", "NUGGER", "KKK", "NI99ER", "NIG9ER", "NI9GER", "NI993R", "NIG93R", "NI9G3R", "N|GGER", "N|GG3R", "N|G93R", "N|993R", "N|9G3R", "N|9GER", "N|G9ER", "N19GER", "N1G9ER", "N199ER", "N1GG3R", "N19G3R", "N1G93R", "|\|IGGER", "N1993R", "WHORE", "WH0RE", "BITCH", "CUNT", "SLUT", "PUSSY", "THOT", "RETARD", "FUCKTARD", "MONGOLOID", "MIDGET", "RETARDED", "TARD", "RET4RD", "CUCK", "MONGO", "FAG", "FAGGOT", "QUEER", "DYKE", "HOMO", "SHEMALE", "F4GGOT", "F4G", "TR4NNY", "SISSY", "TRANNY"];