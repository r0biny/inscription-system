import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
test("offline worker cannot cache the lab homepage, another directory, or API responses",async()=>{
  const source=await readFile(new URL("../public/offline_sw.js",import.meta.url),"utf8");
  for(const base of ["/inscription-system/","/research/repair/"]){
    const handlers={},opened=[],stored=[];
    vm.runInNewContext(source,{
      URL, self:{location:{href:"https://lab.test"+base+"offline_sw.js",origin:"https://lab.test"},addEventListener:(type,fn)=>{handlers[type]=fn;}},
      caches:{open:async key=>{opened.push(key);return {match:async()=>null,put:async key=>{stored.push(key);}};}},
      fetch:async()=>({ok:true,clone(){return this;}}),
    });
    const dispatch=async(path,mode="cors",method="GET")=>{
      let handled=false,promise;
      handlers.fetch({request:{url:"https://lab.test"+path,mode,method},respondWith(p){handled=true;promise=p;}});
      if(promise)await promise;return handled;
    };
    assert.equal(await dispatch("/","navigate"),false);
    assert.equal(await dispatch("/other/site.js"),false);
    assert.equal(await dispatch(base+"api/status"),false);
    assert.equal(await dispatch(base+"api/offline/sync","cors","POST"),false);
    assert.equal(await dispatch(base,"navigate"),true);
    assert.equal(await dispatch(base+"assets/app.js"),true);
    assert.equal(await dispatch(base+"study-data/page.jpg?v=abc"),true);
    assert.ok(opened.every(key=>key==="paper1_lab:"+base+":offline-static-v1"));
    assert.equal(stored.length,3);
  }
});
