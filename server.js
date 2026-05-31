const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Game Config ──
const TICK_RATE = 20; // server ticks per second
const MAX_PLAYERS = 8;
const CATCH_DIST = 18;
const MAP_W = 900, MAP_H = 580;

// ── Walls ──
const walls = [
  {x:250,y:80,w:140,h:60},{x:500,y:80,w:150,h:60},{x:700,y:250,w:120,h:60},
  {x:100,y:180,w:5,h:80},{x:100,y:255,w:70,h:5},
  {x:80,y:350,w:5,h:100},{x:80,y:350,w:60,h:5},
  {x:200,y:300,w:5,h:90},{x:300,y:280,w:120,h:5},
  {x:650,y:170,w:80,h:5},{x:650,y:170,w:5,h:70},
  {x:380,y:380,w:5,h:80},{x:380,y:380,w:100,h:5},
  {x:750,y:120,w:5,h:70},
  {x:600,y:420,w:100,h:5},{x:700,y:420,w:5,h:60},
  {x:200,y:460,w:150,h:5}
];

// ── Rooms ──
const rooms = new Map();

function genRoomId() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function getSpawnPoints() {
  return [
    {x:150,y:150},{x:750,y:150},{x:750,y:450},{x:150,y:450},
    {x:450,y:300},{x:300,y:200},{x:600,y:400},{x:400,y:480}
  ];
}

function circleRect(cx, cy, cr, rx, ry, rw, rh) {
  const clx = Math.max(rx, Math.min(cx, rx + rw));
  const cly = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - clx, dy = cy - cly;
  return dx * dx + dy * dy < cr * cr;
}

function canMove(x, y, r) {
  if (x - r < 0 || x + r > MAP_W || y - r < 0 || y + r > MAP_H) return false;
  for (const w of walls) {
    if (circleRect(x, y, r, w.x, w.y, w.w, w.h)) return false;
  }
  return true;
}

// ── Room class ──
class Room {
  constructor(id, title, password, hostId) {
    this.id = id;
    this.title = title;
    this.password = password || null;
    this.hostId = hostId;
    this.players = new Map(); // id -> player
    this.state = 'waiting'; // waiting | playing | ended
    this.seekerId = null;
    this.gameTimer = null;
    this.startTime = 0;
  }

  addPlayer(ws, name, charIdx) {
    const id = ws._pid;
    this.players.set(id, {
      id, ws, name, charIdx,
      ready: false,
      x: 0, y: 0, angle: 0,
      isSeeker: false, caught: false,
      radius: 6
    });
    ws._roomId = this.id;
    this.broadcastLobby();
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size === 0) {
      this.cleanup();
      rooms.delete(this.id);
      return;
    }
    // Transfer host if host left
    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value;
    }
    if (this.state === 'playing') {
      // Check if seeker left
      if (this.seekerId === id) {
        this.endGame('술래가 나갔습니다');
      } else {
        // Check if all runners caught
        this.checkWin();
      }
    }
    this.broadcastLobby();
  }

  startGame() {
    if (this.players.size < 2) return;
    this.state = 'playing';

    // Random seeker
    const ids = [...this.players.keys()];
    this.seekerId = ids[Math.floor(Math.random() * ids.length)];

    // Assign positions
    const spawns = getSpawnPoints();
    let si = 0;
    for (const [id, p] of this.players) {
      p.isSeeker = (id === this.seekerId);
      p.caught = false;
      p.radius = p.isSeeker ? 8 : 6;
      const sp = spawns[si % spawns.length];
      p.x = sp.x;
      p.y = sp.y;
      p.angle = 0;
      si++;
    }

    this.startTime = Date.now();

    // Broadcast game start
    for (const [id, p] of this.players) {
      this.sendTo(id, {
        type: 'game_start',
        yourId: id,
        seekerId: this.seekerId,
        isSeeker: p.isSeeker,
        players: this.getPlayersState(),
        walls
      });
    }

    // Start game loop
    this.gameTimer = setInterval(() => this.gameTick(), 1000 / TICK_RATE);
  }

  gameTick() {
    if (this.state !== 'playing') return;

    const seeker = this.players.get(this.seekerId);
    if (!seeker) return;

    // Check catches
    for (const [id, p] of this.players) {
      if (id === this.seekerId || p.caught) continue;
      const dx = seeker.x - p.x;
      const dy = seeker.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < CATCH_DIST) {
        p.caught = true;
        this.broadcast({ type: 'player_caught', playerId: id });
        this.checkWin();
      }
    }

    // Broadcast positions
    this.broadcast({
      type: 'game_state',
      players: this.getPlayersState(),
      elapsed: ((Date.now() - this.startTime) / 1000).toFixed(1)
    });
  }

  checkWin() {
    const runners = [...this.players.values()].filter(p => !p.isSeeker);
    const allCaught = runners.every(p => p.caught);
    if (allCaught) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      this.endGame('술래 승리! ' + elapsed + '초');
    }
  }

  endGame(reason) {
    this.state = 'waiting';
    if (this.gameTimer) { clearInterval(this.gameTimer); this.gameTimer = null; }
    // Reset ready
    for (const [, p] of this.players) { p.ready = false; }
    this.broadcast({ type: 'game_end', reason });
    this.broadcastLobby();
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || this.state !== 'playing') return;
    if (p.caught && !p.isSeeker) return;

    const speed = p.isSeeker ? 3 : 1.5;
    let dx = 0, dy = 0;

    if (data.moveX !== undefined && data.moveY !== undefined) {
      dx = data.moveX * speed;
      dy = data.moveY * speed;
    }

    // Dash (seeker only)
    if (data.dash && p.isSeeker && !p._dashCd) {
      const dashSpeed = 12;
      const dashDx = Math.cos(p.angle) * dashSpeed;
      const dashDy = Math.sin(p.angle) * dashSpeed;
      // Apply 10 frames of dash instantly
      for (let i = 0; i < 10; i++) {
        const nx = p.x + dashDx;
        const ny = p.y + dashDy;
        if (canMove(nx, p.y, p.radius)) p.x = nx;
        if (canMove(p.x, ny, p.radius)) p.y = ny;
      }
      p._dashCd = 120;
      this.sendTo(id, { type: 'dash_cd', cd: 120 });
    }
    if (p._dashCd > 0) p._dashCd--;

    if (data.angle !== undefined) p.angle = data.angle;

    const nx = p.x + dx;
    const ny = p.y + dy;
    if (canMove(nx, p.y, p.radius)) p.x = nx;
    if (canMove(p.x, ny, p.radius)) p.y = ny;
  }

  getPlayersState() {
    const out = [];
    for (const [id, p] of this.players) {
      out.push({
        id, name: p.name, charIdx: p.charIdx,
        x: p.x, y: p.y, angle: p.angle,
        isSeeker: p.isSeeker, caught: p.caught,
        radius: p.radius
      });
    }
    return out;
  }

  broadcastLobby() {
    const players = [];
    for (const [id, p] of this.players) {
      players.push({ id, name: p.name, charIdx: p.charIdx, ready: p.ready });
    }
    this.broadcast({
      type: 'room_update',
      room: { id: this.id, title: this.title, hostId: this.hostId, locked: !!this.password, state: this.state },
      players
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const [, p] of this.players) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    }
  }

  sendTo(id, data) {
    const p = this.players.get(id);
    if (p && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(data));
    }
  }

  cleanup() {
    if (this.gameTimer) { clearInterval(this.gameTimer); this.gameTimer = null; }
  }

  toListItem() {
    return {
      id: this.id, title: this.title, host: this.players.get(this.hostId)?.name || '???',
      count: this.players.size, max: MAX_PLAYERS,
      status: this.state === 'playing' ? 'playing' : 'waiting',
      locked: !!this.password
    };
  }
}

// ── WebSocket ──
let pidCounter = 0;

wss.on('connection', (ws) => {
  const pid = 'p' + (++pidCounter);
  ws._pid = pid;
  ws._roomId = null;
  ws._name = '';

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      switch (data.type) {

        case 'set_name':
          ws._name = String(data.name).slice(0, 12);
          break;

        case 'list_rooms': {
          const list = [];
          for (const [, r] of rooms) list.push(r.toListItem());
          ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
          break;
        }

        case 'create_room': {
          const id = genRoomId();
          const room = new Room(id, String(data.title).slice(0, 20), data.password, pid);
          rooms.set(id, room);
          room.addPlayer(ws, ws._name, data.charIdx || 0);
          ws.send(JSON.stringify({ type: 'room_joined', roomId: id, isHost: true, yourId: pid }));
          break;
        }

        case 'join_room': {
          const room = rooms.get(data.roomId);
          if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '방을 찾을 수 없어요' })); break; }
          if (room.state === 'playing') { ws.send(JSON.stringify({ type: 'error', msg: '게임이 진행 중이에요' })); break; }
          if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼어요' })); break; }
          if (room.password && data.password !== room.password) { ws.send(JSON.stringify({ type: 'error', msg: '비밀번호가 틀렸어요' })); break; }
          room.addPlayer(ws, ws._name, data.charIdx || 0);
          ws.send(JSON.stringify({ type: 'room_joined', roomId: room.id, isHost: room.hostId === pid, yourId: pid }));
          break;
        }

        case 'leave_room': {
          const room = rooms.get(ws._roomId);
          if (room) { room.removePlayer(pid); ws._roomId = null; }
          break;
        }

        case 'update_char': {
          const room = rooms.get(ws._roomId);
          if (!room) break;
          const p = room.players.get(pid);
          if (p) { p.charIdx = data.charIdx; room.broadcastLobby(); }
          break;
        }

        case 'toggle_ready': {
          const room = rooms.get(ws._roomId);
          if (!room) break;
          const p = room.players.get(pid);
          if (p) { p.ready = !p.ready; room.broadcastLobby(); }
          break;
        }

        case 'start_game': {
          const room = rooms.get(ws._roomId);
          if (!room || room.hostId !== pid) break;
          const others = [...room.players.values()].filter(p => p.id !== pid);
          if (others.length === 0) break;
          if (!others.every(p => p.ready)) break;
          room.startGame();
          break;
        }

        case 'input': {
          const room = rooms.get(ws._roomId);
          if (room) room.handleInput(pid, data);
          break;
        }

        case 'update_name': {
          ws._name = String(data.name).slice(0, 12);
          const room = rooms.get(ws._roomId);
          if (room) {
            const p = room.players.get(pid);
            if (p) { p.name = ws._name; room.broadcastLobby(); }
          }
          break;
        }
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    const room = rooms.get(ws._roomId);
    if (room) room.removePlayer(pid);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Tagger server on port ' + PORT));
