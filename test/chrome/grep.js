const fs=require('fs'),path=require('path');
const root=path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');
const uu={work:'438f5f8e-9c89-4d6b-a11e-d87f5f0179bc',personal:'512a5ff6-4cdb-45e7-ac48-5465ae391332',studio:'98117410-4545-4247-a9dd-19201f55b931'};
for(const p of ['Default','Profile 4','Profile 6']){
  const dir=path.join(root,p,'Local Extension Settings','fcoeoabgfenejglbffodgkkbkcdhcgfn');
  for(const f of fs.readdirSync(dir).filter(f=>/\.(log|ldb)$/.test(f))){
    const b=fs.readFileSync(path.join(dir,f));
    for(const [n,u] of Object.entries(uu)){
      let i=-1,c=0,pos=[];while((i=b.indexOf(u,i+1))>=0){c++;pos.push(i)}
      if(c) console.log(p,f,b.length,n,c,'first',pos[0],'last',pos[pos.length-1]);
    }
  }
}
