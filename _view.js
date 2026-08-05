const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
} catch {}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const LIVE_GRACE_SEC = 150;

(async () => {
  try {
    const now = new Date();
    console.log('SERVER NOW (UTC):', now.toISOString(), '\n');
    const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    const u = await prisma.user.findUnique({ where:{ email:'lakshman@gmail.com' }, select:{ id:true } });

    // ---- 1. LIVE status (team overview / current) ----
    const latest = await prisma.activitySample.findFirst({ where:{ userId:u.id }, orderBy:{ at:'desc' } });
    let liveStatus = 'OFFLINE';
    if (latest) {
      const staleSec = Math.round((now.getTime() - latest.at.getTime())/1000);
      liveStatus = staleSec > LIVE_GRACE_SEC ? 'OFFLINE' : (latest.idle ? 'IDLE' : 'ACTIVE');
      console.log('LIVE STATUS (team overview):', liveStatus);
      console.log('   last sample:', latest.at.toISOString(), '| stale by', staleSec, 'sec (', Math.round(staleSec/60), 'min )');
      console.log('   => grace is 150s; agent counts OFFLINE when stale >150s\n');
    } else console.log('LIVE STATUS: OFFLINE (no samples)\n');

    // ---- 2. TIMELINE idle + work ----
    const idleRows = await prisma.activitySample.findMany({ where:{ userId:u.id, date, idle:true }, orderBy:{at:'asc'}, select:{at:true,durationSec:true} });
    const idleSec = idleRows.reduce((a,r)=>a+(r.durationSec??0)*1, 0);
    const online = await prisma.onlineSession.findMany({ where:{ userId:u.id, date }, select:{startedAt:true,endedAt:true,durationSec:true} });
    let workSec = 0;
    for (const o of online) workSec += o.durationSec ?? Math.max(0,Math.round(((o.endedAt??now).getTime()-o.startedAt.getTime())/1000));
    console.log('TIMELINE (today):');
    console.log('   work seconds (from online_sessions):', workSec, `(${Math.round(workSec/60)} min)`);
    console.log('   idle seconds (from activity_samples):', idleSec, `(${Math.round(idleSec/60)} min)`);

    // ---- 3. DAILY rollup active/idle ----
    const all = await prisma.activitySample.findMany({ where:{ userId:u.id, date }, orderBy:{at:'asc'}, select:{at:true,durationSec:true,idle:true} });
    let active=0, idle=0;
    all.forEach((s,i)=>{
      let dur = s.durationSec>0 ? Math.min(s.durationSec,150) : 0;
      if (dur<=0) return;
      if (s.idle) idle+=dur; else active+=dur;
    });
    console.log('\nDAILY ROLLUP (my/today):');
    console.log('   activeSec:', active, `(${Math.round(active/60)} min)`);
    console.log('   idleSec:  ', idle, `(${Math.round(idle/60)} min)`);
    console.log('   total samples today:', all.length);

    console.log('\nscreenshots today:', await prisma.screenshot.count({ where:{ userId:u.id, takenAt:{ gte:new Date(`${date}T00:00:00`) } } }));
  } catch (e) { console.log('❌', e.message); }
  finally { await prisma.$disconnect(); }
})();
