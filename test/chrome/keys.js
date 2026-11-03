// Enumerate every key in each extension DB using the module's internals (loaded via a copy that exports them).
const fs=require('fs'),path=require('path');
let src=fs.readFileSync('D:/Claud/multi-claude/lib/chrome.js','utf8').replace("require('./stats')","require('D:/Claud/multi-claude/lib/stats')")+'\nmodule.exports.blockEntries=blockEntries;module.exports.tableBlock=tableBlock;';
const m={exports:{}};new Function('module','exports','require',src)(m,m.exports,require);const c=m.exports;
const ud=c.userDataDir();
for(const p of ['Default','Profile 4','Profile 6']){
  const db=path.join(ud,p,'Local Extension Settings',c.EXTENSION_ID);
  for(const n of fs.readdirSync(db).filter(n=>/\.ldb$/.test(n))){
    const buf=fs.readFileSync(path.join(db,n));
    const foot=buf.subarray(buf.length-48);const cur={b:foot,i:0};
    const vi=(cc)=>{let v=0,s=0;for(;;){const b=cc.b[cc.i++];v+=(b&127)*2**s;if(!(b&128))return v;s+=7}};
    vi(cur);vi(cur);const idx=c.tableBlock(buf,vi(cur),vi(cur));
    let blocks=0,entries=0,keys=new Set(),bad=0;
    for(const [,h] of c.blockEntries(idx)){const hc={b:h,i:0};const d=c.tableBlock(buf,vi(hc),vi(hc));blocks++;if(!d){bad++;continue}for(const [k] of c.blockEntries(d)){entries++;keys.add(k.subarray(0,k.length-8).toString())}}
    console.log(p,n,'blocks',blocks,'entries',entries,'unsupported',bad,'keys',[...keys].slice(0,40).join(', '));
  }
  // log: count records of a few keys
  for(const n of fs.readdirSync(db).filter(n=>/\.log$/.test(n))){
    const buf=fs.readFileSync(path.join(db,n));
    const counts={};
    for(const k of ['anonymousId','accountUuid','signIn','tabGroups','permissionConsentOwner']){let x=0;c.scanLog(buf,Buffer.from(k),()=>x++);counts[k]=x;}
    console.log(p,n,buf.length,JSON.stringify(counts));
  }
}
