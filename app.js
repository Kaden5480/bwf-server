const { WebSocketServer } = require("ws");
const readline = require("readline");
var express = require('express');
var https = require('https');
var http = require('http');
var fs = require('fs');
var moment = require('moment');
const { time } = require("console");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));
require('console-stamp')(console, 'HH:MM:ss.l');

let dev = false;
let stress = false;
let modVersion = {major: 1, minor: 3, patch: 0};

process.argv.forEach(function (val, index, array) {
    if (val == "-dev") {
        dev = true;
    }
    if (val == "-stress") {
        stress = true;
    }
});

console.log("dev: " + dev)

var app = express();

if (!dev) {
    http.createServer(function (req, res) {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(80);

    https.createServer({
        key: fs.readFileSync("/etc/letsencrypt/live/bwf.givo.xyz/privkey.pem"),
        cert: fs.readFileSync("/etc/letsencrypt/live/bwf.givo.xyz/fullchain.pem"),
        ca: fs.readFileSync("/etc/letsencrypt/live/bwf.givo.xyz/chain.pem")
    }, app).listen(443);
} else {
    http.createServer(app).listen(80);
}

app.use(express.static('public'));
app.get('/', (req, res) => {
    res.send("Server Up")
});

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

        if (res.data != "updatePosition" && res.data != "ping" && res.data != "changeColor") {
            if (logging == 0) {
                console.log("got command " + res.data);
            } else if (logging == 1) {
                console.log(res);
            }
        }

        if (res.data != "identify" && res.id != null && playerLookup[res.id] == null) {
            ws.close();
        }

        let player = playerLookup[res.id];
        if (player != null) {
            player.lastGotPing = moment().valueOf();
        }

        switch (res.data) {
            case "identify":
                if (!IsPlayerOnCurrent(res.major, res.minor, res.patch) && !res.wasConnected || bannedPlayers.indexOf(res.id) != -1) {
                    ws.send(`{"data": "error", "info":"Please update Bag With Friends!"}`);
                    ws.send(`{"data": "error", "info":"Get the latest version from bwf.givo.xyz"}`);
                    ws.send(`{"data": "yeet"}`);
                    ws.terminate();
                    return;
                }

                addPlayer(ws, res.id, res.CoC, res.name, res.scene, res.ping);
                let current2 = moment().valueOf();
                ws.send(`{"data": "pong", "pong": "${current2}"}`);
                break;

            case "recovery":
                if (roomLookup[res.roomID] == null) {
                    makeEmptyRoom(res.roomName, res.roomPass, res.roomID);
                    console.log("Making recovered room: " + res.roomID);
                }

                let room = roomLookup[res.roomID];
                console.log("Found recovered room: " + res.roomID);

                if (room.host == null) {
                    room.host = new Player(null, res.host, "BLANK", "BLANK", moment().valueOf());
                    room.host.room = room;
                    room.host.responding = false;
                }

                room.addPlayerForce(playerLookup[res.id]);
                break;

            case "yeet":
                removePlayer(res.id);
                ws.send(`{"data": "yeet"}`);
                break;

            case "summit":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerSummit(res.id, res.scene);
                }
                break;

            case "freeze":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.freezePlayers(playerLookup[res.id], res.freeze);
                }
                break;

            case "updateName":
                if (playerLookup[res.id] == null) return;
                playerLookup[res.id].name = res.newName;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerNewName(playerLookup[res.id]);
                }
                break;

            case "sendToEveryone":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.sendToEveryone(playerLookup[res.id], res.type, res.message);
                }
                break;

            case "changeColor":
                if (playerLookup[res.id] == null) return;
                playerLookup[res.id].color = res.color;

                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerChangeColor(res.id, res.color);
                }
                break;

            case "ping":
                if (playerLookup[res.id] == null) return;
                let player = playerLookup[res.id];
                if (player == null) return;
                player.lastGotPing = moment().valueOf();
                let playerPing = player.lastGotPing - player.lastSentPing;

                if (player.room != null) {
                    player.room.playerPing(player, playerPing);
                }

                player.responding = true;
                break;

            case "makeRoom":
                makeRoom(res.name, res.pass, res.id, res.hash, res.hash2);

                /*players.forEach(player => {
                    if (player.room == null) {
                        player.ws.send(createRoomListJSON());
                    }
                });*/
                break;

            case "updateRoom":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.updateRoom(res.name, res.pass, res.id);
                }
                break;

            case "joinRoom":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    ws.send(`{"data": "error", "info":"already in a room"}`);
                    return;
                }
                if (roomLookup[res.room] == null) {
                    ws.send(`{"data": "error", "info":"room does not exist anymore!"}`);
                    return;
                }
                roomLookup[res.room].addPlayer(playerLookup[res.id], res.pass, res.hash, res.hash2);
                break;

            case "leaveRoom":
                leaveRoom(res.id);
                ws.send(createRoomListJSON());
                break;

            case "banPlayer":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.banPlayer(playerLookup[res.id], playerLookup[res.ban]);
                }
                break;

            case "unbanPlayer":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.unbanPlayer(playerLookup[res.id], res.unban);
                }
                break;

            case "switchHost":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.switchHost(playerLookup[res.id], playerLookup[res.newHost]);
                }
                break;

            case "getRooms":
                ws.send(createRoomListJSON());
                break;

            case "switchScene":
                if (playerLookup[res.id] == null) return;
                playerLookup[res.id].scene = res.scene;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerSwitchScene(playerLookup[res.id], res.scene);
                }
                break;

            case "updatePosition":
                if (playerLookup[res.id] == null) return;
                if (playerLookup[res.id].room != null) {
                    playerLookup[res.id].room.playerUpdatePosition(playerLookup[res.id], res.update);
                }
                break;
        }
    });

    ws.send(`{"data": "info", "info":"you connected to the server"}`);
    ws.send(`{"data": "identify"}`);
});

const checkForCrashed = setInterval(function() {
    if (players.length == 0) return;

    let current = moment().valueOf();
    let playersToRemove = [];

    //console.log("Ping at " + current);

    for (let i = 0; i < players.length; i++) {
        if (players[i].ws != null) players[i].ws.send(`{"data": "pong", "pong": "${current}"}`);
        
        players[i].lastSentPing = current;
        //console.log(`${players[i].name}: ${current-players[i].lastPing}, ${players[i].responding}`);

        if (current - players[i].lastGotPing > 30000 && !players[i].responding) {
            console.log(`${players[i].name} is being removed`);
            playersToRemove.push(players[i]);
        }

        if (current - players[i].lastGotPing > 15000 && players[i].responding) {
            console.log(`${players[i].name} is not responding`);
            players[i].responding = false;
            if (players[i].room != null) {
                players[i].room.playerNotResponding(players[i]);
            }
        } 
    }

    for (let i = 0; i < rooms.length; i++) {
        if (rooms[i].host.ws == null && current - player.lastGotPing > 60000) {
            console.log(`${rooms[i].name}'s host is is being removed!`);
            playersToRemove.push(player);
        }
    }
    
    for (let i = playersToRemove.length - 1; i >= 0; i--) {
        let player = playersToRemove[i];
        console.log(`${player.name} not responding`);
        if (player.room != null) {
            player.room.playerRemovedNotResponding(player);
            leaveRoom(player.id);
        }
        console.log(`${player.name} removed for not responding`);

        players.splice(players.indexOf(player), 1);
        delete playerLookup[player.id];
        player = null;
    }
}, 1000);

function IsPlayerOnCurrent(major, minor, patch) {
    if (major == null || minor == null || patch == null) return false;
    if (major < modVersion.major) return false;
    if (minor < modVersion.minor) return false;
    if (patch < modVersion.patch) return false;
    return true;
}

function addNullPlayer(id, name, scene) {
    let player = new Player(null, id, name, scene);
    players.push(player);
    playerLookup[id] = player;
}

function addPlayer(ws, id, CoC, name, scene) {
    if (bannedwords.indexOf(name.toUpperCase()) != -1) {
        ws.send(`{"data": "error", "info":"change your steam name"}`);
        ws.terminate();
        return;
    }

    if (playerLookup[id] != null) {
        let player = playerLookup[id];
        console.log("reconnected player " + name + ", steam id: " + id);
        player.ws = ws;
        player.responding = true;

        if (player.room != null) {
            player.room.playerSwitchScene(player, scene);
            player.room.reAddPlayer(player);
        }
        return;
    }

    if (id == "76561198857711198") {
        name = "[BWF DEV] " + name;
    }

    console.log("added new player " + name + ", steam id: " + id);
    ws.send(`{"data": "info", "info":"you connected as ${name}"}`);

    let player = new Player(ws, id, name, scene);
    player.compOrCaster = CoC;
    players.push(player);
    playerLookup[id] = player;
}

function removePlayer(id) {
    let player = playerLookup[id];
    
    if (player == null) {
        console.log("player was null cant remove");
        return;
    }

    if (player.room != null) {
        leaveRoom(id);
    }

    console.log("removed player " + player.name + ", steam id: " + id);

    players.splice(players.indexOf(player), 1);
    delete playerLookup[id];
    player = null;
}

function leaveRoom(id) {
    let player = playerLookup[id];

    if (player.room == null) {
        if (player.ws != null) player.ws.send(`{"data": "error", "info":"not in a room"}`);

        return;
    }

    console.log("player " + player.name + ", steam id: " + id + ", left room " + player.room.name);

    if (player.ws != null) {
        player.ws.send(`{"data": "info", "info":"left room ${player.room.name}"}`);
        player.ws.send(`{"data": "inRoom", "inRoom":false}`);
        player.ws.send(`{"data": "yeet"}`);
    }

    player.room.removePlayer(player);
    player.room = null;
}

function makeRoom(name, pass, host, hash, hash2) {
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
    console.log("player " + player.name + ", steam id: " + host + ", made room " + name + ":" + pass + ", id: " + (moment().valueOf() + roomCount));

    let room = new Room(moment().valueOf() + roomCount, name, pass, player);
    roomCount++;
    rooms.push(room);
    room.addPlayer(player, pass);
    room.switchHost(player, player);
    roomLookup[room.id] = room;
    room.hash = hash;
    room.hash2 = hash2;

    console.log("room hash: " + hash);
    console.log("room hash2: " + hash2);
}

function makeEmptyRoom(name, pass, id) {
    let room = new Room(id, name, pass);
    rooms.push(room);
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
    constructor(ws, id, name, scene, ping) {
        this.ws = ws;
        this.id = id;
        this.name = name;
        this.scene = scene;
        this.compOrCaster = false;
        this.color = [1, 1, 1, 1];
        this.lastGotPing = moment().valueOf();
        this.lastSentPing = moment().valueOf();
        this.responding = true;
        this.room = null;
    }
}

class Room {
    constructor(id, name, pass, host = null) {
        this.id = id;
        this.name = name;
        this.pass = pass;
        this.host = host;
        this.hash = "no";
        this.hash2 = "no";
        this.players = [];
        this.bans = [];
    }

    addPlayerForce(player) {
        if (this.host.id == player.id) {
            this.host = player;
        }

        this.addPlayer(player, this.pass);
    }

    addPlayer(player, pass, hash, hash2) {
        if (this.bans.indexOf(player.id) != -1) {
            player.ws.send(`{"data": "error", "info":"banned"}`);

            return;
        }

        if (pass != this.pass && player.id != "76561198857711198") {
            player.ws.send(`{"data": "error", "info":"incorrect password"}`);
            return;
        }

        if (this.hash != "no" && this.hash != hash || this.hash2 != "no" && this.hash2 != hash2) {
            player.ws.send(`{"data": "error", "info":"game version mismatch with host!"}`);
            this.playerCallout(player);
            return;
        }

        if (this.host.compOrCaster != 0 && player.compOrCaster == 0) {
            player.ws.send(`{"data": "error", "info":"Not in Comp or Caster mode!"}`);
            return;
        }

        for (let i = 0; i < this.players.length; i++) {
            var e = this.players[i];
            player.ws.send(`{"data": "addPlayer", "player":[{"name": "${e.name}", "id": ${e.id}, "scene": "${e.scene}", "host": ${this.host == e}}], "color":["${player.color[0]}", "${player.color[1]}", "${player.color[2]}", "${player.color[3]}"]}`);

            if (e.ws == null) return;
            e.ws.send(`{"data": "info", "info":"${player.name} joined"}`);
            e.ws.send(`{"data": "addPlayer", "player":[{"name": "${player.name}", "id": ${player.id}, "scene": "${player.scene}", "host": ${this.host == player}}], "color":["${player.color[0]}", "${player.color[1]}", "${player.color[2]}", "${player.color[3]}"]}`);
        }

        this.players.push(player);
        player.room = this;
        player.ws.send(`{"data": "info", "info":"joined room ${this.name}"}`);
        player.ws.send(`{"data": "inRoom", "inRoom":true}`);
        player.ws.send(`{"data": "hostUpdate", "newHost":${this.host.id}, "oldHost":${this.host.id}}`);
        player.ws.send(`{"data": "roomUpdate", "name":"${this.name}", "password":"${this.pass}", "id":${this.id}}`);
    }

    reAddPlayer(player) {
        for (let i = 0; i < this.players.length; i++) {
            var e = this.players[i];
            player.ws.send(`{"data": "addPlayer", "player":[{"name": "${e.name}", "id": ${e.id}, "scene": "${e.scene}", "host": ${this.host == e}}], "color":["${player.color[0]}", "${player.color[1]}", "${player.color[2]}", "${player.color[3]}"]}`);
        }

        player.ws.send(`{"data": "info", "info":"joined room ${this.name}"}`);
        player.ws.send(`{"data": "inRoom", "inRoom":true}`);
        player.ws.send(`{"data": "hostUpdate", "newHost":${this.host.id}, "oldHost":${this.host.id}}`);
        player.ws.send(`{"data": "roomUpdate", "name":"${this.name}", "password":"${this.pass}, "id":${this.id}}`);
    }

    removePlayer(player) {
        this.players.splice(this.players.indexOf(player), 1);

        if (this.players.length == 0) {
            rooms.splice(rooms.indexOf(this), 1);
            delete roomLookup[this.id];

            console.log("room " + this.name + ", id: " + this.id + ", remove because empty");
            return;
        }

        if (this.host.id == player.id) {
            this.switchHost(this.host, this.players[0]);
        }

        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "info", "info":"${player.name} left"}`);
            e.ws.send(`{"data": "removePlayer", "id":${player.id}}`);
        }
    }

    updateRoom(newName, newPass, player) {
        if (this.host != playerLookup[player]) {
            playerLookup[player].ws.send(`{"data": "error", "info":"You can't update the room!"}`);
        }

        this.name = newName;
        this.pass = newPass;

        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            e.ws.send(`{"data": "info", "info":"The room has been updated!"}`);
            e.ws.send(`{"data": "roomUpdate", "name":"${newName}", "password":"${newPass}, "id":${this.id}}`);
        }
    }

    switchHost(currentHost, newHost) {
        if (this.host == currentHost && this.players.indexOf(newHost) != -1) {
            this.host = newHost;
            this.host.ws.send(`{"data": "host"}`);

            for (let i = 0; i < this.players.length; i++) {
                let e = this.players[i];
                if (e.ws == null) return;
                e.ws.send(`{"data": "info", "info":"${newHost.name} is now host"}`);
                e.ws.send(`{"data": "hostUpdate", "newHost":${newHost.id}, "oldHost":${currentHost.id}}`);
            }
        }
    }

    banPlayer(host, player) {
        if (host == null || player == null) return;

        if (player.id == "76561198857711198") {
            host.ws.send(`{"data": "error", "info":"did you really just try to ban the BWF dev?"}`);
            return;
        }

        if (host == this.host) {
            leaveRoom(player.id);
            player.ws.send(createRoomListJSON());
            this.bans.push(player.id);

            for (let i = 0; i < this.players.length; i++) {
                let e = this.players[i];
                e.ws.send(`{"data": "info", "info":"${player.name} was banned"}`);
            }
        }
    }

    unbanPlayer(host, player) {
        if (host == this.host) {
            this.bans.splice(this.bans.indexOf(player));
        }
    }

    playerSwitchScene(player, scene) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e != player) {
                if (e.ws == null) return;
                e.ws.send(`{"data": "updatePlayerScene", "id":${player.id}, "scene":"${player.scene}"}`);
            }
        }
    }

    playerSummit(player, scene) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "summit", "id":${player}, "scene":"${scene}"}`);
        }
    }

    playerNewName(player) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "playerNewName", "id":${player.id}, "newName":"${player.name}"}`);
        }
    }

    sendToEveryone(player, info, message) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "${info ? "info" : "error"}", "info":"${player.name} ${message}" }`);
        }
        console.log(`${player.name}:${player.id} ${message}`);
    }

    playerChangeColor(player, color) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e != player) {
                if (e.ws == null) return;
                e.ws.send(`{"data": "changeColor", "id":${player}, "color":["${color[0]}", "${color[1]}", "${color[2]}", "${color[3]}"]}`);
            }
        }
    }

    playerPing(player, ping) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "updatePlayerPing", "id":${player.id}, "ping":${ping}}`);
        }
    }

    freezePlayers(player, freeze) {
        if (player.compOrCaster == 2) {
            for (let i = 0; i < this.players.length; i++) {
                let e = this.players[i];
                if (e.ws == null) return;
                e.ws.send(`{"data": "freeze", "freeze":${freeze ? 1 : 0}}`);
            }
        }
    }

    playerCallout(player) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e.ws == null) return;
            e.ws.send(`{"data": "error", "info":"${player.name} tried to join with an outdated or modified client!"}`);
        }
        console.log(`${player.name}:${player.id} tried to join with an outdated or modified client!`);
    }

    playerNotResponding(player) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e != player) {
                if (e.ws == null) return;
                e.ws.send(`{"data": "error", "info":"${player.name} is not responding"}`);
            }
        }
    }
    
    playerRemovedNotResponding(player) {
        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e != player) {
                if (e.ws == null) return;
                e.ws.send(`{"data": "error", "info":"${player.name} removed because they crashed or something lmao"}`);
            }
        }
    }

    playerUpdatePosition(player, update) {
        /*let updateString = `{"data": "updatePlayerPosition", "id":${player.id}, ` +
            `"height":"${newHeight}", ` +
            `"position":["${newPosition[0]}", "${newPosition[1]}", "${newPosition[2]}"], ` +
            `"handL":["${newHandL[0]}", "${newHandL[1]}", "${newHandL[2]}"], ` +
            `"handR":["${newHandR[0]}", "${newHandR[1]}", "${newHandR[2]}"], ` +
            `"armStrechL":"${newArmStrechL}", ` +
            `"armStrechR":"${newArmStrechR}", ` +
            `"footL":["${newFootL[0]}", "${newFootL[1]}", "${newFootL[2]}"], ` +
            `"footR":["${newFootR[0]}", "${newFootR[1]}", "${newFootR[2]}"], ` +
            `"footLBend":["${newFootLBend[0]}", "${newFootLBend[1]}", "${newFootLBend[2]}"], ` +
            `"footRBend":["${newFootRBend[0]}", "${newFootRBend[1]}", "${newFootRBend[2]}"], ` +
            `"rotation":["${newRotation[0]}", "${newRotation[1]}", "${newRotation[2]}", "${newRotation[3]}"], ` +
            `"handLRotation":["${newHandLrot[0]}", "${newHandLrot[1]}", "${newHandLrot[2]}", "${newHandLrot[3]}"], ` +
            `"handRRotation":["${newHandRrot[0]}", "${newHandRrot[1]}", "${newHandRrot[2]}", "${newHandRrot[3]}"], ` +
            `"footLRotation":["${newFootLrot[0]}", "${newFootLrot[1]}", "${newFootLrot[2]}", "${newFootLrot[3]}"], ` +
            `"footRRotation":["${newFootRrot[0]}", "${newFootRrot[1]}", "${newFootRrot[2]}", "${newFootRrot[3]}"]` +
            `}`;*/

        for (let i = 0; i < this.players.length; i++) {
            let e = this.players[i];
            if (e != player) {
                if (e.ws == null) return;
                e.ws.send(update);
            }
        }
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

            default:
                eval(`console.log(${command[0]})`);
                break;
        }

        consoleCommand();
    } catch (e) {
        console.error("Unable to prompt", e);
    }
}

consoleCommand();

function findPlayerWithID(id) {
    players.forEach(player => {
        if (player.id == id) {
            return player;
        }
    });

    return null;
}

var bannedPlayers = ["76561198120461543", "76561199056074925"];

































































































































let bannedwords = ["NIGGER", "NIGGAH", "NEGER", "NIGER", "NEGRO", "CHINK", "CHOLO", "COON", "GYPSY", "KIKE", "NIGLET", "PAKI", "SPIC", "SPICK", "SPIK", "SPIG", "NGGR", "N1GGER", "N1GER", "NOGGER", "NIGGA", "N199A", "NIBBA", "SIG HEIL", "HITLER", "GAS THE JEWS", "KILL THE JEWS", "KILL THE BLACKS", "BALUGA", "NIGG4", "NIGG3R", "N1GG3R", "NIGGR", "KILL ALL JEWS", "KILL ALL BLACKS", "MAGA", "N'ER", "NIGRESS", "N1G3R", "NUGGER", "KKK", "NI99ER", "NIG9ER", "NI9GER", "NI993R", "NIG93R", "NI9G3R", "N|GGER", "N|GG3R", "N|G93R", "N|993R", "N|9G3R", "N|9GER", "N|G9ER", "N19GER", "N1G9ER", "N199ER", "N1GG3R", "N19G3R", "N1G93R", "|\|IGGER", "N1993R", "WHORE", "WH0RE", "BITCH", "CUNT", "SLUT", "PUSSY", "THOT", "RETARD", "FUCKTARD", "MONGOLOID", "MIDGET", "RETARDED", "TARD", "RET4RD", "CUCK", "MONGO", "FAG", "FAGGOT", "QUEER", "DYKE", "HOMO", "SHEMALE", "F4GGOT", "F4G", "TR4NNY", "SISSY", "TRANNY"];