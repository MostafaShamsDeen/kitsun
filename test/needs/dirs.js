const fs=require('fs'),path=require('path');
const local=process.env.LOCALAPPDATA, roaming=process.env.APPDATA;
const ls=(d)=>{try{return fs.readdirSync(d)}catch{return[]}};
const mt=(f)=>{try{return fs.statSync(f).mtimeMs}catch{return -1}};
const pk=ls(path.join(local,'Packages')).filter(n=>/^Claude_/i.test(n));
function dd(a){const c=a.main?[...ls(path.join(local,'Claude-Data')).filter(n=>/^claude_/i.test(n)).map(n=>path.join(local,'Claude-Data',n)),...pk.map(n=>path.join(local,'Packages',n,'LocalCache','Roaming','Claude')),path.join(roaming,'Claude')]:[...pk.map(n=>path.join(local,'Packages',n,'LocalCache','Local','Claude-Profiles',a.id)),path.join(local,'Claude-Profiles',a.id)];
let b=null,bt=-1;for(const d of c){const t=mt(path.join(d,'config.json'));console.error(' cand',d,t);if(t>bt){b=d;bt=t}}return b}
const accts=[{id:'main',main:true,name:'Work'},{id:'personal',name:'Personal'},{id:'client-1-mvsl0lu8mg',name:'Studio'}];
const out={};for(const a of accts){out[a.name]=dd(a)}console.log(JSON.stringify(out,null,1));
