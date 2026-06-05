const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 8;
const CATCH_DIST = 30;
const TICK_RATE = 30;
const MAP_W = 3000, MAP_H = 2000;

const walls = [
  // Big blocks
  {x:400,y:200,w:200,h:120},{x:900,y:100,w:180,h:100},{x:1500,y:300,w:220,h:140},
  {x:2200,y:200,w:180,h:120},{x:2600,y:500,w:160,h:100},
  {x:300,y:800,w:200,h:100},{x:800,y:700,w:160,h:120},{x:1400,y:700,w:200,h:100},
  {x:2000,y:800,w:180,h:140},{x:2500,y:900,w:200,h:100},
  {x:500,y:1300,w:180,h:120},{x:1100,y:1200,w:200,h:100},{x:1700,y:1300,w:160,h:140},
  {x:2300,y:1200,w:200,h:100},{x:100,y:1600,w:180,h:120},
  {x:700,y:1700,w:200,h:100},{x:1300,y:1600,w:180,h:120},{x:1900,y:1700,w:200,h:100},
  {x:2600,y:1600,w:160,h:120},
  // L-shaped walls
  {x:200,y:400,w:8,h:120},{x:200,y:516,w:100,h:8},
  {x:700,y:400,w:100,h:8},{x:700,y:400,w:8,h:100},
  {x:1200,y:500,w:8,h:140},{x:1200,y:636,w:120,h:8},
  {x:1800,y:400,w:120,h:8},{x:1916,y:400,w:8,h:100},
  {x:2400,y:350,w:8,h:120},{x:2400,y:350,w:100,h:8},
  {x:350,y:1050,w:120,h:8},{x:350,y:1050,w:8,h:100},
  {x:950,y:1000,w:8,h:120},{x:950,y:1116,w:100,h:8},
  {x:1600,y:1000,w:100,h:8},{x:1696,y:1000,w:8,h:120},
  {x:2100,y:1050,w:8,h:100},{x:2100,y:1050,w:120,h:8},
  {x:2700,y:1100,w:100,h:8},{x:2700,y:1100,w:8,h:120},
  {x:400,y:1500,w:8,h:100},{x:400,y:1596,w:100,h:8},
  {x:1000,y:1500,w:120,h:8},{x:1000,y:1500,w:8,h:100},
  {x:1600,y:1500,w:8,h:120},{x:1600,y:1616,w:100,h:8},
  {x:2200,y:1500,w:100,h:8},{x:2296,y:1500,w:8,h:100},
  // Horizontal barriers
  {x:550,y:600,w:150,h:8},{x:1050,y:900,w:180,h:8},
  {x:1800,y:600,w:160,h:8},{x:2400,y:750,w:140,h:8},
  {x:200,y:1200,w:160,h:8},{x:850,y:1400,w:140,h:8},
  {x:2000,y:1400,w:160,h:8},{x:2500,y:1300,w:140,h:8},
  // Vertical barriers
  {x:600,y:150,w:8,h:120},{x:1100,y:350,w:8,h:100},
  {x:2000,y:150,w:8,h:120},{x:2800,y:300,w:8,h:140},
  {x:150,y:950,w:8,h:100},{x:1500,y:950,w:8,h:120},
  {x:2800,y:1400,w:8,h:120},{x:600,y:1800,w:8,h:120},
  {x:1200,y:1800,w:8,h:100},{x:2100,y:1800,w:8,h:120},
];

const spawns = [
  {x:100,y:100},{x:1500,y:100},{x:2900,y:100},{x:100,y:1900},
  {x:1500,y:1900},{x:2900,y:1900},{x:100,y:1000},{x:2900,y:1000}
];

const rooms = new Map();
let pidCounter = 0;

function circleRect(cx,cy,cr,rx,ry,rw,rh){const clx=Math.max(rx,Math.min(cx,rx+rw)),cly=Math.max(ry,Math.min(cy,ry+rh)),dx=cx-clx,dy=cy-cly;return dx*dx+dy*dy<cr*cr}
function canMove(x,y,r){if(x-r<0||x+r>MAP_W||y-r<0||y+r>MAP_H)return false;for(const w of walls)if(circleRect(x,y,r,w.x,w.y,w.w,w.h))return false;return true}

class Room {
  constructor(id,title,password,hostId){this.id=id;this.title=title;this.password=password||null;this.hostId=hostId;this.players=new Map();this.state='waiting';this.seekerId=null;this.gameTimer=null;this.startTime=0}

  addPlayer(ws,name,charIdx){const id=ws._pid;this.players.set(id,{id,ws,name,charIdx,ready:false,x:0,y:0,angle:0,isSeeker:false,caught:false,radius:14});ws._roomId=this.id;this.broadcastLobby()}

  removePlayer(id){this.players.delete(id);if(this.players.size===0){this.cleanup();rooms.delete(this.id);return}if(this.hostId===id)this.hostId=this.players.keys().next().value;if(this.state==='playing'){if(this.seekerId===id)this.endGame('술래가 나갔습니다');else this.checkWin()}this.broadcastLobby()}

  startGame(){
    if(this.players.size<2)return;this.state='playing';
    const ids=[...this.players.keys()];this.seekerId=ids[Math.floor(Math.random()*ids.length)];
    let si=0;
    for(const[id,p]of this.players){p.isSeeker=(id===this.seekerId);p.caught=false;p.radius=p.isSeeker?16:14;const sp=spawns[si%spawns.length];si++;p.x=sp.x;p.y=sp.y;p.angle=0}
    this.startTime=Date.now();
    for(const[id,p]of this.players){this.sendTo(id,{type:'game_start',yourId:id,seekerId:this.seekerId,isSeeker:p.isSeeker,players:this.getState(),walls,mapW:MAP_W,mapH:MAP_H})}
    this.gameTimer=setInterval(()=>this.tick(),1000/TICK_RATE);
  }

  tick(){
    if(this.state!=='playing')return;const seeker=this.players.get(this.seekerId);if(!seeker)return;
    for(const[id,p]of this.players){if(id===this.seekerId||p.caught)continue;const dx=seeker.x-p.x,dy=seeker.y-p.y;if(Math.sqrt(dx*dx+dy*dy)<CATCH_DIST){p.caught=true;this.broadcast({type:'caught',playerId:id});this.checkWin()}}
    this.broadcast({type:'sync',players:this.getState(),elapsed:((Date.now()-this.startTime)/1000).toFixed(1)});
  }

  handleInput(id,data){
    const p=this.players.get(id);if(!p||this.state!=='playing')return;if(p.caught&&!p.isSeeker)return;
    const speed=p.isSeeker?5:3.5;let dx=0,dy=0;
    if(data.moveX!==undefined){dx=data.moveX*speed;dy=data.moveY*speed}
    if(data.dash&&p.isSeeker&&!p._dashCd){const ds=12;const ddx=Math.cos(p.angle)*ds,ddy=Math.sin(p.angle)*ds;for(let i=0;i<10;i++){if(canMove(p.x+ddx,p.y,p.radius))p.x+=ddx;if(canMove(p.x,p.y+ddy,p.radius))p.y+=ddy}p._dashCd=120;this.sendTo(id,{type:'dash_cd',cd:120})}
    if(p._dashCd>0)p._dashCd--;
    if(data.angle!==undefined)p.angle=data.angle;
    const steps=Math.ceil(Math.max(Math.abs(dx),Math.abs(dy)));
    for(let i=0;i<steps;i++){const sx=dx/steps,sy=dy/steps;if(canMove(p.x+sx,p.y,p.radius))p.x+=sx;if(canMove(p.x,p.y+sy,p.radius))p.y+=sy}
  }

  checkWin(){if([...this.players.values()].filter(p=>!p.isSeeker).every(p=>p.caught))this.endGame('술래 승리! '+((Date.now()-this.startTime)/1000).toFixed(1)+'초')}
  endGame(reason){this.state='waiting';if(this.gameTimer){clearInterval(this.gameTimer);this.gameTimer=null}for(const[,p]of this.players)p.ready=false;this.broadcast({type:'game_end',reason});this.broadcastLobby()}
  getState(){return[...this.players.values()].map(p=>({id:p.id,name:p.name,charIdx:p.charIdx,x:p.x,y:p.y,angle:p.angle,isSeeker:p.isSeeker,caught:p.caught,radius:p.radius}))}
  broadcastLobby(){const players=[...this.players.values()].map(p=>({id:p.id,name:p.name,charIdx:p.charIdx,ready:p.ready}));this.broadcast({type:'room_update',room:{id:this.id,title:this.title,hostId:this.hostId,locked:!!this.password,state:this.state},players})}
  broadcast(d){const m=JSON.stringify(d);for(const[,p]of this.players)if(p.ws.readyState===1)p.ws.send(m)}
  sendTo(id,d){const p=this.players.get(id);if(p&&p.ws.readyState===1)p.ws.send(JSON.stringify(d))}
  cleanup(){if(this.gameTimer){clearInterval(this.gameTimer);this.gameTimer=null}}
  toListItem(){return{id:this.id,title:this.title,host:this.players.get(this.hostId)?.name||'?',count:this.players.size,max:MAX_PLAYERS,status:this.state==='playing'?'playing':'waiting',locked:!!this.password}}
}

wss.on('connection',ws=>{
  const pid='p'+(++pidCounter);ws._pid=pid;ws._roomId=null;ws._name='';
  ws.on('message',raw=>{try{const d=JSON.parse(raw);switch(d.type){
    case 'set_name':ws._name=String(d.name).slice(0,12);break;
    case 'list_rooms':{const l=[];for(const[,r]of rooms)l.push(r.toListItem());ws.send(JSON.stringify({type:'room_list',rooms:l}));break}
    case 'create_room':{const id=String(Math.floor(1000+Math.random()*9000));const r=new Room(id,String(d.title).slice(0,20),d.password,pid);rooms.set(id,r);r.addPlayer(ws,ws._name,d.charIdx||0);ws.send(JSON.stringify({type:'room_joined',roomId:id,isHost:true,yourId:pid}));break}
    case 'join_room':{const r=rooms.get(d.roomId);if(!r){ws.send(JSON.stringify({type:'error',msg:'방을 찾을 수 없어요'}));break}if(r.state==='playing'){ws.send(JSON.stringify({type:'error',msg:'게임 진행 중'}));break}if(r.players.size>=MAX_PLAYERS){ws.send(JSON.stringify({type:'error',msg:'방이 가득 찼어요'}));break}if(r.password&&d.password!==r.password){ws.send(JSON.stringify({type:'error',msg:'비밀번호가 틀렸어요'}));break}r.addPlayer(ws,ws._name,d.charIdx||0);ws.send(JSON.stringify({type:'room_joined',roomId:r.id,isHost:r.hostId===pid,yourId:pid}));break}
    case 'leave_room':{const r=rooms.get(ws._roomId);if(r){r.removePlayer(pid);ws._roomId=null}break}
    case 'update_char':{const r=rooms.get(ws._roomId);if(r){const p=r.players.get(pid);if(p){p.charIdx=d.charIdx;r.broadcastLobby()}}break}
    case 'toggle_ready':{const r=rooms.get(ws._roomId);if(r){const p=r.players.get(pid);if(p){p.ready=!p.ready;r.broadcastLobby()}}break}
    case 'start_game':{const r=rooms.get(ws._roomId);if(r&&r.hostId===pid){const others=[...r.players.values()].filter(p=>p.id!==pid);if(others.length>0&&others.every(p=>p.ready))r.startGame()}break}
    case 'input':{const r=rooms.get(ws._roomId);if(r)r.handleInput(pid,d);break}
    case 'update_name':{ws._name=String(d.name).slice(0,12);const r=rooms.get(ws._roomId);if(r){const p=r.players.get(pid);if(p){p.name=ws._name;r.broadcastLobby()}}break}
  }}catch(e){}});
  ws.on('close',()=>{const r=rooms.get(ws._roomId);if(r)r.removePlayer(pid)});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Tagger on port '+PORT));
