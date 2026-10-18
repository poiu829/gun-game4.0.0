'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const WORLD_W = 4800, TILE = 12, COLS = WORLD_W / TILE, ROWS = 76, WORLD_H = TILE * ROWS;
const BLUE = 1, RED = 2, MAX_SHADOW = 100;
// ステージ定義は stages/*.json に分離。サーバーが読み込み、部屋の全員に同じステージを適用する。
const STAGES_DIR = path.join(ROOT, 'stages');
function cleanObjects(input){
  if(!Array.isArray(input)) return [];
  return input.filter(o=>['wall','abyss','dry','area'].includes(o.type)&&[o.x,o.y,o.w,o.h].every(Number.isFinite)&&o.w>0&&o.h>0).map(o=>({id:String(o.id||''),type:o.type,x:Math.max(0,Math.min(WORLD_W-o.w,o.x)),y:Math.max(0,Math.min(WORLD_H-o.h,o.y)),w:o.w,h:o.h}));
}
function loadStages(){
  const list=[];
  try { for(const file of fs.readdirSync(STAGES_DIR).filter(n=>n.endsWith('.json')).sort()){
    const raw=JSON.parse(fs.readFileSync(path.join(STAGES_DIR,file),'utf8'));
    if(!raw.id || !raw.name || !raw.rules || typeof raw.rules!=='object') continue;
    // オブジェクトは必ずルールごとに定義し、共通 objects へのフォールバックは行わない。
    const rules={
      standard:{objects:cleanObjects(raw.rules.standard?.objects)},
      area:{objects:cleanObjects(raw.rules.area?.objects)}
    };
    list.push({id:String(raw.id),name:String(raw.name),description:String(raw.description||''),rules});
  }} catch(err){ console.error('Stage loading failed:',err.message); }
  return list;
}
const STAGES = loadStages();
if(!STAGES.length) throw new Error('No valid stages found in stages/*.json');
function getStage(id,mode='standard'){const s=STAGES.find(s=>s.id===id)||STAGES[0];const rule=s.rules?.[mode]||s.rules.standard;return {...s,objects:(rule?.objects||[]).map(o=>({...o}))};}
const rooms = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') { res.writeHead(200, {'content-type':'text/plain; charset=utf-8'}); return res.end('ok'); }
  let pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT,'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    res.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store'}); res.end(data);
  });
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
function send(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { for (const ws of room.clients.values()) send(ws, obj); }
function cleanName(s) { return String(s || 'Player').replace(/[<>\n\r]/g,'').trim().slice(0,16) || 'Player'; }
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code; do { code = ''; for (let i=0;i<5;i++) code += chars[crypto.randomInt(chars.length)]; } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return { code:room.code, hostId:room.hostId, status:room.status, selectedMode:room.selectedMode || 'standard', selectedStage:room.selectedStage || STAGES[0].id, stages:STAGES.map(s=>({id:s.id,name:s.name,description:s.description})), weapons:WEAPONS.map((w,index)=>({index,id:w.id,name:w.name,charge:w.charge,range:w.range,interval:w.interval,damage:w.damage,cost:w.cost,speed:w.speed,paintRadius:w.paintRadius,impactPaintRadius:w.impactPaintRadius,bulletRadius:w.bulletRadius,...(w.charge?{maxCharge:w.maxCharge,cameraAimLookaheadCharged:w.cameraAimLookaheadCharged}: {})})),
    players:[...room.clients.values()].map(ws=>({id:ws.session.id,name:ws.session.name,host:ws.session.id===room.hostId})),
    maxPlayers:6, gameMode:room.gameMode || null };
}
function sendRoom(room) { broadcast(room, {type:'room', room:publicRoom(room)}); }
function getClientRoom(ws) { return ws.session && ws.session.roomCode ? rooms.get(ws.session.roomCode) : null; }
function assignTeams(humans, fillBots) {
  const counts = { [BLUE]:0, [RED]:0 }, list=[];
  let tieTeam = BLUE;
  for (const h of humans) {
    let team;
    if (counts[BLUE] < counts[RED]) team=BLUE;
    else if (counts[RED] < counts[BLUE]) team=RED;
    else { team=tieTeam; tieTeam = tieTeam===BLUE?RED:BLUE; }
    counts[team]++;
    list.push(createPlayer({id:h.session.id,name:h.session.name,team,isCpu:false}));
  }
  if (fillBots) {
    let n=1;
    while (list.length<6) {
      const team = counts[BLUE] < counts[RED] ? BLUE : counts[RED] < counts[BLUE] ? RED : (tieTeam===BLUE?RED:BLUE);
      tieTeam = team===BLUE?RED:BLUE; counts[team]++;
      list.push(createPlayer({id:`cpu-${n}-${crypto.randomBytes(3).toString('hex')}`,name:`CPU ${n++}`,team,isCpu:true}));
    }
  }
  for (const team of [BLUE,RED]) {
    const pack=list.filter(p=>p.team===team);
    pack.forEach((p,i)=>{
      p.index=i; p.spawnX=team===BLUE?WORLD_W*.12:WORLD_W*.88;
      const frac=pack.length===1?.5:(.22+i*(.56/(pack.length-1)));
      p.spawnY=WORLD_H*frac; p.x=p.spawnX+(Math.random()-.5)*18; p.y=p.spawnY+(Math.random()-.5)*30;
      p.angle=team===BLUE?0:Math.PI;
    });
  }
  return list;
}
function createPlayer({id,name,team,isCpu}) {
  return {id,name,team,isCpu:!!isCpu,index:0,x:0,y:0,spawnX:0,spawnY:0,r:15,angle:team===BLUE?0:Math.PI,
    shadow:MAX_SHADOW,alive:true,respawn:0,cooldown:Math.random()*.2,kills:0,deaths:0,
    input:{moveX:0,moveY:0,aim:team===BLUE?0:Math.PI,aimX:null,aimY:null,fire:false},weaponId:0,loadoutPending:false,chargeTime:0,wasFiring:false,pendingCharge:0,strafe:Math.random()<.5?-1:1,aiHistory:[],aiGoal:null,aiThink:0};
}
function startGame(room, fillBots) {
  if (room.status!=='lobby') return;
  const humans=[...room.clients.values()]; if (!humans.length) return;
  const selectedMode = room.selectedMode === 'area' ? 'area' : 'standard';
  const stage = getStage(room.selectedStage, selectedMode); room.selectedStage=stage.id;
  room.gameMode=selectedMode;
  const players=assignTeams(humans,fillBots);
  for (const p of players) { p.loadoutPending = !p.isCpu; p.input.fire = false; p.input.moveX = 0; p.input.moveY = 0; }
  const g={worldW:WORLD_W,worldH:WORLD_H,tile:TILE,cols:COLS,rows:ROWS,objects:stage.objects.map(o=>({...o})),areas:stage.objects.filter(o=>o.type==='area').map(o=>({...o,owner:0,contested:false,progress:50,progressTeam:0,blueCount:0,redCount:0})),stageId:stage.id,stageName:stage.name,players,bullets:[],territory:new Int8Array(COLS*ROWS),scores:{blue:0,red:0},pushPosition:0,timeLeft:180,ended:false,events:[],paintChanges:[],tick:0,mode:selectedMode};
  room.game=g;room.status='running';
  for (const p of players) for (let yy=-10;yy<=10;yy++) for(let xx=-10;xx<=10;xx++) paintCell(g,p.spawnX+xx*TILE,p.spawnY+yy*TILE,p.team);
  const seed=[]; for(let i=0;i<g.territory.length;i++) if(g.territory[i]) seed.push([i,g.territory[i]]);
  for(const ws of room.clients.values()) send(ws,{type:'gameStart',meId:ws.session.id,worldW:g.worldW,worldH:g.worldH,tile:g.tile,cols:g.cols,rows:g.rows,territory:seed,mode:room.gameMode,areas:g.areas,objects:g.objects,stageId:stage.id,stageName:stage.name});
  sendRoom(room); broadcast(room,{type:'state',state:snapshot(g)});
}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function cellIndex(x,y){const tx=Math.floor(x/TILE),ty=Math.floor(y/TILE);if(tx<0||ty<0||tx>=COLS||ty>=ROWS)return -1;return ty*COLS+tx;}
function isDryCell(g,x,y){return (g.objects||[]).some(o=>o.type==='dry'&&x>=o.x&&x<o.x+o.w&&y>=o.y&&y<o.y+o.h);}
function circleRectHit(x,y,r,o){const cx=clamp(x,o.x,o.x+o.w),cy=clamp(y,o.y,o.y+o.h);return Math.hypot(x-cx,y-cy)<r;}
function blockedAt(g,x,y,r){return (g.objects||[]).some(o=>o.type==='wall'&&circleRectHit(x,y,r,o));}
// 奈落はプレイヤーの当たり判定全体が内側に入ったときだけ死亡。
function fullyInsideAbyss(g,p){return (g.objects||[]).some(o=>o.type==='abyss'&&p.x-p.r>=o.x&&p.x+p.r<=o.x+o.w&&p.y-p.r>=o.y&&p.y+p.r<=o.y+o.h);}
function paintCell(g,x,y,team){if(isDryCell(g,x,y))return;const idx=cellIndex(x,y);if(idx<0||g.territory[idx]===team)return;g.territory[idx]=team;g.paintChanges.push([idx,team]);}
function paintBrush(g,x,y,team,radius=TILE*1.6){const minX=Math.max(0,Math.floor((x-radius)/TILE)),maxX=Math.min(COLS-1,Math.floor((x+radius)/TILE)),minY=Math.max(0,Math.floor((y-radius)/TILE)),maxY=Math.min(ROWS-1,Math.floor((y+radius)/TILE));for(let ty=minY;ty<=maxY;ty++)for(let tx=minX;tx<=maxX;tx++){const left=tx*TILE,right=left+TILE,top=ty*TILE,bottom=top+TILE,cx=clamp(x,left,right),cy=clamp(y,top,bottom);if(Math.hypot(x-cx,y-cy)<=radius)paintCell(g,tx*TILE+1,ty*TILE+1,team);}}
function paintLine(g,x1,y1,x2,y2,team,radius=TILE*1.6){const d=Math.hypot(x2-x1,y2-y1),steps=Math.max(1,Math.ceil(d/(TILE*.3)));for(let i=0;i<=steps;i++)paintBrush(g,x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps,team,radius);}
function tileAt(g,x,y){if(isDryCell(g,x,y))return 0;const idx=cellIndex(x,y);return idx<0?0:g.territory[idx]||0;}
function nearestEnemy(g,p){let best=null,dist=Infinity;for(const q of g.players){if(q.team===p.team||!q.alive)continue;/* CPU detection matches what a human opponent can see: a player at max transparency is hidden only while standing on their own territory. */const visuallyHidden=tileAt(g,q.x,q.y)===q.team&&q.shadow>=99.3;if(visuallyHidden)continue;const d=Math.hypot(q.x-p.x,q.y-p.y);if(d<dist){dist=d;best=q;}}return best?{p:best,d:dist}:null;}
// 武器性能は weapons/*.json から読み込む。特殊な挙動の処理は引き続き server.js 側に置く。
const WEAPONS_DIR = path.join(ROOT, 'weapons');
function loadWeapons(){
 const list=[];
 for(const file of fs.readdirSync(WEAPONS_DIR).filter(n=>n.endsWith('.json')).sort()){
  const raw=JSON.parse(fs.readFileSync(path.join(WEAPONS_DIR,file),'utf8'));
  if(!raw.id || !raw.name) continue;
  for(const key of ['range','interval','damage','cost','speed','paintRadius','impactPaintRadius','bulletRadius']){
   if(!Number.isFinite(raw[key]) || raw[key]<0) throw new Error('Invalid weapon '+file+': '+key);
  }
  if(raw.interval<=0 || raw.speed<=0) throw new Error('Invalid weapon '+file+': interval/speed must be positive');
  if(typeof raw.charge!=='boolean') throw new Error('Invalid weapon '+file+': charge must be boolean');
  if(raw.charge && (!Number.isFinite(raw.maxCharge)||raw.maxCharge<=0||!Number.isFinite(raw.chargeCostPerSec)||raw.chargeCostPerSec<0)) throw new Error('Invalid charged weapon '+file);
  if(raw.cameraAimLookaheadCharged !== undefined && (!Number.isFinite(raw.cameraAimLookaheadCharged) || raw.cameraAimLookaheadCharged < 0)) throw new Error('Invalid weapon '+file+': cameraAimLookaheadCharged must be a non-negative number');
  list.push({id:String(raw.id),name:String(raw.name),range:raw.range,interval:raw.interval,damage:raw.damage,cost:raw.cost,speed:raw.speed,charge:raw.charge,paintRadius:raw.paintRadius,impactPaintRadius:raw.impactPaintRadius,bulletRadius:raw.bulletRadius,...(raw.charge?{maxCharge:raw.maxCharge,chargeCostPerSec:raw.chargeCostPerSec,cameraAimLookaheadCharged:raw.cameraAimLookaheadCharged}: {})});
 }
 if(!list.length) throw new Error('No valid weapons found in weapons/*.json');
 return list;
}
const WEAPONS = loadWeapons();
function shoot(g,p,angle,charge=0,aimX=null,aimY=null){
 if(!p.alive||p.cooldown>0)return;
 const w=WEAPONS[p.weaponId]||WEAPONS[0];
 if(p.shadow<w.cost)return;
 if(w.charge&&charge<=0)return;
 p.angle=angle;
 // Every shot costs the weapon's configured cost, including charged weapons.
 p.shadow=Math.max(0,p.shadow-w.cost);
 p.cooldown=p.isCpu?(1.2+Math.random()*.25):w.interval;
 const power=w.charge?Math.max(0.55,Math.min(1,charge/(w.maxCharge||1.5))):1;
 const speed=w.speed,ox=p.x+Math.cos(angle)*(p.r+9),oy=p.y+Math.sin(angle)*(p.r+9);
 const hasAimPoint=Number.isFinite(aimX)&&Number.isFinite(aimY);
 if(hasAimPoint){angle=Math.atan2(aimY-oy,aimX-ox);p.angle=angle;}
 const maxDistance=Math.max(1,speed*0.45*w.range);
 const targetDistance=hasAimPoint?Math.hypot(aimX-ox,aimY-oy):maxDistance;
 const travelDistance=Math.max(1,Math.min(targetDistance,maxDistance));
 g.bullets.push({x:ox,y:oy,px:ox,py:oy,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,team:p.team,ownerId:p.id,life:travelDistance/speed,damage:w.damage*power,r:w.bulletRadius??(w.charge?9:8.5),paintRadius:w.paintRadius??TILE*1.6,impactPaintRadius:w.impactPaintRadius??0});
}
function kill(g,victim,killer){if(!victim.alive)return;victim.alive=false;victim.deaths++;victim.shadow=0;victim.respawn=1.7;if(killer&&killer.team!==victim.team){killer.kills++;if(g.mode!=='area')g.scores[killer.team===BLUE?'blue':'red']++;g.events.push({text:`${killer.name} が ${victim.name} を倒した`,team:killer.team});}}
function spawn(p){p.alive=true;p.shadow=80;p.respawn=0;p.x=p.spawnX+(Math.random()-.5)*80;p.y=p.spawnY+(Math.random()-.5)*60;p.cooldown=.5;}
function estimateVelocity(q,now){
  const h=q.aiHistory||[]; if(h.length<2)return {vx:0,vy:0};
  const newest=h[h.length-1]; let old=h[0];
  for(const item of h){if(newest.t-item.t>=0.22){old=item;break;}}
  const span=newest.t-old.t; if(span<0.08)return {vx:0,vy:0};
  return {vx:clamp((newest.x-old.x)/span,-180,180),vy:clamp((newest.y-old.y)/span,-180,180)};
}
function predictIntercept(p,q,weapon){
  const v=estimateVelocity(q,0), dx=q.x-p.x,dy=q.y-p.y;
  const speed=Math.max(1,weapon.speed||180);
  // Iterate travel time because target motion and projectile travel depend on one another.
  let t=Math.hypot(dx,dy)/speed;
  for(let i=0;i<3;i++){
    const px=q.x+v.vx*t,py=q.y+v.vy*t;
    t=Math.min(weapon.range*0.45,Math.hypot(px-p.x,py-p.y)/speed);
  }
  const maxT=Math.max(0.08,(weapon.range||1)*0.45);
  t=Math.min(t,maxT);
  return {x:q.x+v.vx*t,y:q.y+v.vy*t,vx:v.vx,vy:v.vy,t};
}
function incomingBullet(g,p){
  let best=null,bestTime=Infinity;
  for(const b of g.bullets){
    if(b.team===p.team||b.ownerId===p.id)continue;
    const vx=b.vx,vy=b.vy, vv=vx*vx+vy*vy; if(vv<1)continue;
    const rx=p.x-b.x,ry=p.y-b.y;
    const t=clamp((rx*vx+ry*vy)/vv,0,0.48);
    const bx=b.x+vx*t,by=b.y+vy*t,dist=Math.hypot(p.x-bx,p.y-by);
    if(dist<p.r+(b.r||8)+24&&t<bestTime){best={t,dx:p.x-bx,dy:p.y-by,dist};bestTime=t;}
  }
  return best;
}
function aiStep(g,p,dt){
  if(!p.alive)return;
  const target=nearestEnemy(g,p); p.cooldown=Math.max(0,p.cooldown-dt); p.aiThink=Math.max(0,(p.aiThink||0)-dt);
  const speed=86+(p.shadow<30?8:0);
  let tx=0,ty=0;
  if(!target){
    // Remember a destination briefly instead of recalculating a random decision every frame.
    if(!p.aiGoal||Math.hypot(p.aiGoal.x-p.x,p.aiGoal.y-p.y)<45||p.aiThink<=0){
      const midX=WORLD_W/2,midY=WORLD_H/2;
      p.aiGoal={x:clamp(midX+(Math.random()-.5)*300,p.r,WORLD_W-p.r),y:clamp(midY+(Math.random()-.5)*180,p.r,WORLD_H-p.r)};
      p.aiThink=0.7+Math.random()*0.5;
    }
    tx=p.aiGoal.x-p.x;ty=p.aiGoal.y-p.y;
  }else{
    const q=target.p,dx=q.x-p.x,dy=q.y-p.y,d=target.d;
    const weapon=WEAPONS[p.weaponId]||WEAPONS[0];
    const pred=predictIntercept(p,q,weapon);
    const a=Math.atan2(dy,dx);
    // Pick a useful range for the equipped weapon; circle/strafe instead of charging straight in.
    const preferred=clamp((weapon.speed||180)*0.45*(weapon.range||1)*0.72,115,330);
    if(d>preferred+35){tx=dx;ty=dy;}
    else if(d<preferred-55){tx=-dx;ty=-dy;}
    else {tx=Math.cos(a+Math.PI/2*p.strafe)*0.9;ty=Math.sin(a+Math.PI/2*p.strafe)*0.9;}
    // Dodge a bullet only when its projected path is actually threatening.
    const threat=incomingBullet(g,p);
    if(threat){
      let ex=threat.dx,ey=threat.dy,el=Math.hypot(ex,ey)||1;ex/=el;ey/=el;
      // Combine a strong sidestep with a small move away from the predicted impact point.
      const side=p.strafe;
      tx=tx*0.25+(-ey*side)*1.25+ex*0.45;
      ty=ty*0.25+(ex*side)*1.25+ey*0.45;
      if(threat.t<0.16)p.strafe*=-1;
    }
    // Keep the aim based on the target's recent movement, not just its current location.
    const aimAngle=Math.atan2(pred.y-p.y,pred.x-p.x); p.angle=aimAngle;
    const maxDistance=(weapon.speed||180)*0.45*(weapon.range||1);
    const predDistance=Math.hypot(pred.x-p.x,pred.y-p.y);
    if(predDistance<maxDistance*0.96&&p.cooldown<=0&&p.shadow>=weapon.cost){
      const jitter=(Math.random()-.5)*Math.min(0.11,0.035+predDistance*0.00012);
      shoot(g,p,aimAngle+jitter,0,pred.x,pred.y);
    }
  }
  const len=Math.hypot(tx,ty)||1;tx/=len;ty/=len;
  const nx=clamp(p.x+tx*speed*dt,p.r,WORLD_W-p.r),ny=clamp(p.y+ty*speed*dt,p.r,WORLD_H-p.r);
  if(!blockedAt(g,nx,p.y,p.r))p.x=nx;else p.strafe*=-1;
  if(!blockedAt(g,p.x,ny,p.r))p.y=ny;else p.strafe*=-1;
  if(fullyInsideAbyss(g,p))kill(g,p,null);
}function stepGame(room,dt){const g=room.game;if(!g||g.ended)return;g.tick++;g.timeLeft=Math.max(0,g.timeLeft-dt);g.events=[];g.paintChanges=[];
  if(g.tick%3===0){const now=g.tick/30;for(const q of g.players){if(!q.alive)continue;if(!q.aiHistory)q.aiHistory=[];q.aiHistory.push({x:q.x,y:q.y,t:now});while(q.aiHistory.length>7|| (q.aiHistory.length>2&&now-q.aiHistory[0].t>0.65))q.aiHistory.shift();}}
 for(const p of g.players){p.cooldown=Math.max(0,p.cooldown);if(!p.alive){p.respawn-=dt;if(p.respawn<=0)spawn(p);continue;}p.shadow=clamp(p.shadow+6.2*dt,0,MAX_SHADOW);const ground=tileAt(g,p.x,p.y);if(ground!==0&&ground!==p.team)p.shadow=clamp(p.shadow-10.8*dt,0,MAX_SHADOW);if(p.shadow<=0)kill(g,p,null);}
 for(const p of g.players){if(!p.alive||p.loadoutPending)continue;if(p.isCpu){aiStep(g,p,dt);continue;}p.cooldown=Math.max(0,p.cooldown-dt);const i=p.input;let mx=clamp(i.moveX,-1,1),my=clamp(i.moveY,-1,1),len=Math.hypot(mx,my);if(len>1){mx/=len;my/=len;}const speed=95;const nx=clamp(p.x+mx*speed*dt,p.r,WORLD_W-p.r),ny=clamp(p.y+my*speed*dt,p.r,WORLD_H-p.r);if(!blockedAt(g,nx,p.y,p.r))p.x=nx;if(!blockedAt(g,p.x,ny,p.r))p.y=ny;if(fullyInsideAbyss(g,p))kill(g,p,null);if(!p.alive)continue;if(Number.isFinite(i.aim))p.angle=i.aim;
 const weapon=WEAPONS[p.weaponId]||WEAPONS[0];
 if(weapon.charge){
   if(i.fire){
     if(!p.wasFiring){p.chargeTime=0;p.pendingCharge=0;}
     const drain=Math.min(p.shadow,weapon.chargeCostPerSec*dt);
     p.shadow=Math.max(0,p.shadow-drain);
     p.chargeTime=Math.min(weapon.maxCharge,p.chargeTime+dt);
     if(p.shadow<=0)kill(g,p,null);
   }else if(p.wasFiring){
     if(p.chargeTime>0)p.pendingCharge=p.chargeTime;
     p.chargeTime=0;
   }
   if(!i.fire&&p.pendingCharge>0&&p.cooldown<=0){
     const charge=p.pendingCharge;
     p.pendingCharge=0;
     shoot(g,p,p.angle,charge,i.aimX,i.aimY);
   }
   p.wasFiring=!!i.fire;
 }else{
   p.chargeTime=0;p.pendingCharge=0;p.wasFiring=false;
   if(i.fire)shoot(g,p,p.angle,0,i.aimX,i.aimY);
 }}
 for(let i=g.bullets.length-1;i>=0;i--){const b=g.bullets[i];b.px=b.x;b.py=b.y;const stepDistance=Math.min(Math.hypot(b.vx,b.vy)*dt,Math.max(0,b.life)*Math.hypot(b.vx,b.vy));const velocityLength=Math.hypot(b.vx,b.vy)||1;b.x+=b.vx/velocityLength*stepDistance;b.y+=b.vy/velocityLength*stepDistance;b.life-=dt;if((g.objects||[]).some(o=>o.type==='wall'&&circleRectHit(b.x,b.y,b.r,o))){g.bullets.splice(i,1);continue;}if(b.paintRadius>0&&!(g.objects||[]).some(o=>o.type==='dry'&&b.x>=o.x&&b.x<o.x+o.w&&b.y>=o.y&&b.y<o.y+o.h))paintLine(g,b.px,b.py,b.x,b.y,b.team,b.paintRadius);let hit=null;for(const p of g.players){if(!p.alive||p.team===b.team||p.id===b.ownerId)continue;if(Math.hypot(p.x-b.x,p.y-b.y)<p.r+b.r){hit=p;break;}}if(hit){if(b.impactPaintRadius>0)paintBrush(g,b.x,b.y,b.team,b.impactPaintRadius);hit.shadow=clamp(hit.shadow-b.damage,0,MAX_SHADOW);if(hit.shadow<=0)kill(g,hit,g.players.find(p=>p.id===b.ownerId));g.bullets.splice(i,1);continue;}if(b.life<=0||b.x<0||b.y<0||b.x>WORLD_W||b.y>WORLD_H){const endpointIsDry=(g.objects||[]).some(o=>o.type==='dry'&&b.x>=o.x&&b.x<o.x+o.w&&b.y>=o.y&&b.y<o.y+o.h);if(b.impactPaintRadius>0&&!endpointIsDry&&b.x>=0&&b.y>=0&&b.x<=WORLD_W&&b.y<=WORLD_H)paintBrush(g,b.x,b.y,b.team,b.impactPaintRadius);g.bullets.splice(i,1);}}
 if(g.mode==='area'){
  let bluePoints=0,redPoints=0;
  for(const z of (g.areas||[])){
   let blue=0,red=0;
   for(const p of g.players){if(!p.alive||p.x<z.x||p.x>z.x+z.w||p.y<z.y||p.y>z.y+z.h)continue;if(p.team===BLUE)blue++;else if(p.team===RED)red++;}
   z.blueCount=blue;z.redCount=red;z.contested=blue>0&&red>0;
   const lead=blue>red?BLUE:red>blue?RED:0;
   if(lead===BLUE)z.progress=Math.min(100,z.progress+25*dt);else if(lead===RED)z.progress=Math.max(0,z.progress-25*dt);
   const previousOwner=z.owner;
   if(z.owner===BLUE){if(z.progress<=30)z.owner=RED;}else if(z.owner===RED){if(z.progress>=70)z.owner=BLUE;}else{if(z.progress>=70)z.owner=BLUE;else if(z.progress<=30)z.owner=RED;}
   z.progressTeam=z.progress>50?BLUE:z.progress<50?RED:0;
   if(z.owner&&z.owner!==previousOwner)g.events.push({text:`${z.id||'エリア'}：${z.owner===BLUE?'BLUE':'RED'} TEAM が確保！`,team:z.owner});
   if(z.owner===BLUE)bluePoints++;else if(z.owner===RED)redPoints++;
  }
  // All areas push one shared boundary. Net area ownership moves it;
  // taking areas back moves the boundary toward its starting point again.
  g.pushPosition=clamp((g.pushPosition||0)+(bluePoints-redPoints)*dt,-60,60);
  g.scores.blue=Math.max(0,g.pushPosition);
  g.scores.red=Math.max(0,-g.pushPosition);
  if(Math.abs(g.pushPosition)>=60||g.timeLeft<=0){g.ended=true;g.winner=g.pushPosition>0?'blue':g.pushPosition<0?'red':'draw';room.status='finished';}
 }else if(g.scores.blue>=20||g.scores.red>=20||g.timeLeft<=0){g.ended=true;g.winner=g.scores.blue===g.scores.red?'draw':g.scores.blue>g.scores.red?'blue':'red';room.status='finished';}
}
function snapshot(g){return {players:g.players.map(p=>({id:p.id,name:p.name,team:p.team,isCpu:p.isCpu,x:p.x,y:p.y,r:p.r,angle:p.angle,shadow:p.shadow,alive:p.alive,respawn:p.respawn,kills:p.kills,deaths:p.deaths,weaponId:p.weaponId,loadoutPending:!!p.loadoutPending,chargeTime:p.chargeTime})),bullets:g.bullets.map(b=>({x:b.x,y:b.y,px:b.px,py:b.py,r:b.r,team:b.team})),scores:g.scores,pushPosition:g.pushPosition||0,timeLeft:g.timeLeft,ended:g.ended,winner:g.winner||null,events:g.events,mode:g.mode,areas:g.areas||[],objects:g.objects||[]};}
function leaveRoom(ws){const room=getClientRoom(ws);if(!room)return;const id=ws.session.id;room.clients.delete(id);ws.session.roomCode=null;if(room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===id);if(p){p.isCpu=true;p.loadoutPending=false;p.name=`CPU (${p.name})`;p.input={moveX:0,moveY:0,aim:p.angle,fire:false};}}if(room.hostId===id){room.hostId=room.clients.keys().next().value||null;}if(room.clients.size===0){setTimeout(()=>{if(room.clients.size===0)rooms.delete(room.code);},30000);}else{sendRoom(room);}}
function onMessage(ws,data){let msg;try{msg=JSON.parse(data.toString());}catch{return send(ws,{type:'error',message:'送信内容を読み取れませんでした。'});}if(!msg||typeof msg.type!=='string')return;
 if(msg.type==='create'||msg.type==='join'){
  if (ws.session && ws.session.roomCode) leaveRoom(ws);
  let room;if(msg.type==='create'){room={code:newCode(),hostId:null,status:'lobby',clients:new Map(),game:null,gameMode:null,selectedMode:'standard',selectedStage:STAGES[0].id};rooms.set(room.code,room);}else{const code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);room=rooms.get(code);if(!room)return send(ws,{type:'error',message:'その部屋は見つかりません。部屋コードを確認してください。'});if(room.status!=='lobby')return send(ws,{type:'error',message:'その部屋はすでに試合中です。新しい部屋を作ってください。'});if(room.clients.size>=6)return send(ws,{type:'error',message:'その部屋は満員です。'});}
  const id=crypto.randomUUID();ws.session={id,name:cleanName(msg.name),roomCode:room.code};if(!room.hostId)room.hostId=id;room.clients.set(id,ws);send(ws,{type:'joined',id,code:room.code});sendRoom(room);return;
 }
 const room=getClientRoom(ws);if(!room)return;
 if(msg.type==='stageChoice'&&room.status==='lobby'){if(ws.session.id!==room.hostId)return send(ws,{type:'error',message:'ステージを変更できるのはホストです。'});const stage=getStage(String(msg.stageId||''));room.selectedStage=stage.id;sendRoom(room);return;}
 if(msg.type==='modeChoice'&&room.status==='lobby'){if(ws.session.id!==room.hostId)return send(ws,{type:'error',message:'ゲームモードを変更できるのはホストです。'});const mode=String(msg.mode||'standard');if(mode!=='standard'&&mode!=='area')return;room.selectedMode=mode;sendRoom(room);return;}
 if(msg.type==='weaponChoice'&&room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===ws.session.id&&!p.isCpu);if(!p|| (p.alive&&!p.loadoutPending))return;const id=Number(msg.weaponId);if(Number.isInteger(id)&&id>=0&&id<WEAPONS.length){p.weaponId=id;p.loadoutPending=false;p.chargeTime=0;p.wasFiring=false;p.pendingCharge=0;p.input.fire=false;p.input.moveX=0;p.input.moveY=0;send(ws,{type:'weaponSelected',weaponId:id});}return;}
 if(msg.type==='input'&&room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===ws.session.id&&!p.isCpu);if(!p)return;if(p.loadoutPending){p.input.moveX=0;p.input.moveY=0;p.input.fire=false;return;}p.input={moveX:clamp(Number(msg.moveX)||0,-1,1),moveY:clamp(Number(msg.moveY)||0,-1,1),aim:Number.isFinite(msg.aim)?msg.aim:p.angle,aimX:Number.isFinite(msg.aimX)?clamp(msg.aimX,0,WORLD_W):null,aimY:Number.isFinite(msg.aimY)?clamp(msg.aimY,0,WORLD_H):null,fire:!!msg.fire};return;}
 if(msg.type==='start'&&room.status==='lobby'){if(ws.session.id!==room.hostId)return send(ws,{type:'error',message:'試合を始められるのは部屋のホストです。'});startGame(room,!!msg.fillBots);return;}
 if(msg.type==='leave'){leaveRoom(ws);send(ws,{type:'left'});return;}
}
wss.on('connection',ws=>{ws.session=null;send(ws,{type:'connected'});ws.on('message',data=>onMessage(ws,data));ws.on('close',()=>leaveRoom(ws));ws.on('error',()=>leaveRoom(ws));});
setInterval(()=>{for(const room of rooms.values()){if(room.status!=='running'||!room.game||room.game.ended)continue;stepGame(room,1/30);if(room.game.paintChanges.length)broadcast(room,{type:'paint',cells:room.game.paintChanges});if(room.game.events.length)broadcast(room,{type:'events',events:room.game.events});if(room.game.ended){sendRoom(room);broadcast(room,{type:'state',state:snapshot(room.game)});continue;}broadcast(room,{type:'state',state:snapshot(room.game)});}},1000/30);
server.listen(PORT,'0.0.0.0',()=>console.log(`SHADOW POINT listening on 0.0.0.0:${PORT}`));
