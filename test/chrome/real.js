const path=require('path'),fs=require('fs');
const c=require('D:/Claud/multi-claude/lib/chrome.js');
const ud=c.userDataDir();
(async()=>{
  const profs=c.parseLocalState(fs.readFileSync(path.join(ud,'Local State'),'utf8'));
  console.log(profs);
  for(const p of profs){
    const db=path.join(ud,p.dir,'Local Extension Settings',c.EXTENSION_ID);
    const t=Date.now();
    // every record of accountUuid, per file
    for(const n of fs.readdirSync(db).filter(n=>/\.(log|ldb)$/.test(n))){
      const buf=fs.readFileSync(path.join(db,n)); const recs=[];
      const f=(seq,del,v)=>recs.push([seq,del,v&&v.toString()]);
      try{ n.endsWith('.log')?c.scanLog(buf,Buffer.from('accountUuid'),f):c.scanTable(buf,Buffer.from('accountUuid'),f);}catch(e){console.log('ERR',n,e.message)}
      console.log(' ',p.dir,n,JSON.stringify(recs));
    }
    const r=await c.readKey(db,'accountUuid');
    console.log(p.dir,'=>',r&&{seq:r.seq,deleted:r.deleted,uuid:c.uuidOf(r.value),was:c.uuidOf(r.last)},Date.now()-t,'ms');
  }
  const accounts=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'Kitsun','profiles.json'),'utf8')).accounts;
  const ch=c.createChrome();
  let t=Date.now(); const s=await ch.snapshot(accounts); console.log('snapshot',Date.now()-t,'ms');
  console.log(JSON.stringify(s,null,1));
  t=Date.now(); await ch.snapshot(accounts,{fresh:true}); console.log('cached snapshot',Date.now()-t,'ms');
  console.log('isProfile', await ch.isProfile('Profile 6'), await ch.isProfile('..'), await ch.isProfile('Profile 9'), await ch.isProfile('C:/x'));
})();
