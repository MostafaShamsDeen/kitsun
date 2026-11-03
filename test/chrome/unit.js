const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const c=require('D:/Claud/multi-claude/lib/chrome.js');
const ud=c.userDataDir();
// Build a LevelDB log file with given batches [{seq, ops:[[type,key,value]]}], splitting records across 32 KB blocks.
function vint(n){const o=[];while(n>=128){o.push((n&127)|128);n=Math.floor(n/128)}o.push(n);return Buffer.from(o)}
function batch(seq,ops){const h=Buffer.alloc(12);h.writeUInt32LE(seq%2**32,0);h.writeUInt32LE(Math.floor(seq/2**32),4);h.writeUInt32LE(ops.length,8);
  return Buffer.concat([h,...ops.flatMap(([t,k,v])=>[Buffer.from([t]),vint(Buffer.byteLength(k)),Buffer.from(k),...(t===1?[vint(Buffer.byteLength(v)),Buffer.from(v)]:[])])])}
function logFile(batches){const out=[];let pos=0;
  for(const b of batches){let off=0,first=true;
    while(true){let left=32768-(pos%32768);if(left<7){out.push(Buffer.alloc(left));pos+=left;left=32768}
      const n=Math.min(b.length-off,left-7);const last=off+n===b.length;
      const type=first&&last?1:first?2:last?4:3;const h=Buffer.alloc(7);h.writeUInt16LE(n,4);h[6]=type;
      out.push(h,b.subarray(off,off+n));pos+=7+n;off+=n;first=false;if(last)break}}
  return Buffer.concat(out)}
const W='438f5f8e-9c89-4d6b-a11e-d87f5f0179bc',P='512a5ff6-4cdb-45e7-ac48-5465ae391332';
(async()=>{
  // 1. snappy round trip on a hand-made stream: literal "abcd" + copy(off 4, len 8)
  assert.equal(c.unsnappy(Buffer.from([12, 3<<2, 97,98,99,100, ((8-4)<<2)|1|(0<<5), 4])).toString(),'abcdabcdabcd');
  // 2. log: newer value wins, big batch spanning blocks, deletion = signed out but remembers last
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-chrome-db-'));
  const big='x'.repeat(70000);
  fs.writeFileSync(path.join(dir,'000005.log'),logFile([batch(10,[[1,'accountUuid',JSON.stringify(P)]]),batch(11,[[1,'tabGroups',big]]),batch(12,[[1,'foo','1'],[1,'accountUuid',JSON.stringify(W)]])]));
  let r=await c.readKey(dir,'accountUuid');assert.equal(c.uuidOf(r.value),W);assert.equal(r.seq,13);
  fs.writeFileSync(path.join(dir,'000005.log'),logFile([batch(10,[[1,'accountUuid',JSON.stringify(W)]]),batch(20,[[0,'accountUuid']])]));
  r=await c.readKey(dir,'accountUuid');assert.equal(r.deleted,true);assert.equal(c.uuidOf(r.last),W);
  // a truncated tail (Chrome mid-write) is ignored, earlier records still read
  const full=logFile([batch(10,[[1,'accountUuid',JSON.stringify(P)]]),batch(30,[[1,'accountUuid',JSON.stringify(W)]])]);
  fs.writeFileSync(path.join(dir,'000005.log'),full.subarray(0,full.length-5));
  r=await c.readKey(dir,'accountUuid');assert.equal(c.uuidOf(r.value),P);
  // 3. log newer than a real table: copy a real .ldb (read-only source) next to a log with a newer value
  const real=path.join(ud,'Default','Local Extension Settings',c.EXTENSION_ID);
  const ldb=fs.readdirSync(real).find(n=>n.endsWith('.ldb'));
  fs.copyFileSync(path.join(real,ldb),path.join(dir,ldb));
  fs.writeFileSync(path.join(dir,'000005.log'),logFile([batch(999999,[[1,'accountUuid',JSON.stringify(W)]])]));
  r=await c.readKey(dir,'accountUuid');assert.equal(c.uuidOf(r.value),W);
  fs.writeFileSync(path.join(dir,'000005.log'),Buffer.alloc(0));
  r=await c.readKey(dir,'accountUuid');assert.equal(c.uuidOf(r.value),P);
  // garbage files don't throw
  fs.writeFileSync(path.join(dir,'000007.ldb'),Buffer.from('not a table at all, definitely not'.repeat(5)));
  fs.writeFileSync(path.join(dir,'000008.log'),Buffer.from([1,2,3,4,255,255,1,9,9,9]));
  r=await c.readKey(dir,'accountUuid');assert.equal(c.uuidOf(r.value),P);
  fs.rmSync(dir,{recursive:true,force:true});
  // 4. pickProfile
  const pr=[{dir:'A',activeTime:5,writtenAt:1,uuid:W,was:W},{dir:'B',activeTime:9,writtenAt:1,uuid:null,was:P},{dir:'C',activeTime:7,writtenAt:1,uuid:P,was:P},{dir:'D',activeTime:8,writtenAt:1,uuid:P,was:P}];
  assert.equal(c.pickProfile(pr,W).profile.dir,'A');
  assert.equal(c.pickProfile(pr,P).profile.dir,'D'); // signed in beats signed-out B even though B is newer
  assert.equal(c.pickProfile(pr.filter(p=>p.uuid!==P),P).how,'last-signed-in');
  assert.equal(c.pickProfile(pr,'00000000-0000-0000-0000-000000000000'),null);
  assert.equal(c.pickProfile(pr,null),null);
  // 5. Local State parsing rejects odd folder names and bad JSON
  const ls=c.parseLocalState(JSON.stringify({profile:{profiles_order:['Profile 2','Default'],info_cache:{'Default':{name:'Me',user_name:'a@b'},'..':{name:'x'},'a\b':{name:'y'},'Profile 2':{name:''}}}}));
  assert.deepEqual(ls.map(p=>p.dir),['Profile 2','Default']);assert.equal(ls[0].name,'Profile 2');
  assert.deepEqual(c.parseLocalState('{nope'),[]);
  assert(!c.PROFILE_DIR_RE.test('..')&&!c.PROFILE_DIR_RE.test('C:/x')&&!c.PROFILE_DIR_RE.test('a\b')&&c.PROFILE_DIR_RE.test('Profile 6'));
  console.log('unit: all pass');
})().catch(e=>{console.error(e);process.exit(1)});
