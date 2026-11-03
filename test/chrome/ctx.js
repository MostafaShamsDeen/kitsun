const fs=require('fs'),path=require('path');
const root=path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');
const uu=['438f5f8e-9c89-4d6b-a11e-d87f5f0179bc','512a5ff6-4cdb-45e7-ac48-5465ae391332','98117410-4545-4247-a9dd-19201f55b931'];
const show=(b,s,e)=>b.subarray(Math.max(0,s),Math.min(b.length,e)).toString('latin1').replace(/[^\x20-\x7e]/g,'.');
for(const p of ['Default','Profile 4','Profile 6']){
  const dir=path.join(root,p,'Local Extension Settings','fcoeoabgfenejglbffodgkkbkcdhcgfn');
  const b=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(f=>f.endsWith('.ldb')&&fs.readFileSync(path.join(dir,f)).includes('-4')) ));
  for(const u of uu){let i=-1;while((i=b.indexOf(u,i+1))>=0) console.log(p,i,'|',show(b,i-120,i+80));}
}
