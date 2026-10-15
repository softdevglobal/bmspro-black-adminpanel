/* eslint-disable @typescript-eslint/no-explicit-any -- Heterogeneous Firestore test doubles. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import { beginAiBooking, commitCallCenterBooking, canonicalBookingHash, validateAiDropOff } from "../lib/aiBookingCommit.js";

/** In-memory transactional test store; no Firebase project or live writes. */
function database() {
  const state=new Map<string,Record<string,any>>();let queue=Promise.resolve();let next=0;
  const snap=(ref:any)=>({exists:state.has(ref.path),id:ref.id,data:()=>state.get(ref.path)});
  const collection=(name:string)=>{
    const conditions:Array<[string,unknown]>=[];
    const query:any={where:(field:string,_op:string,value:unknown)=>{conditions.push([field,value]);return query;},
      read:()=>({docs:[...state.entries()].filter(([path,data])=>path.startsWith(name+"/")&&conditions.every(([field,value])=>data[field]===value)).map(([path,data])=>({id:path.split("/").pop(),data:()=>data}))}),
      doc:(id?:string)=>({id:id||`generated-${++next}`,path:`${name}/${id||`generated-${next}`}`})};
    return query;
  };
  const db:any={collection,runTransaction:(callback:any)=>{
    const result=queue.then(async()=>{
      const operations:Array<()=>void>=[];
      const tx:any={get:async(ref:any)=>ref.read?ref.read():snap(ref),getAll:async(...refs:any[])=>refs.map(snap),
        create:(ref:any,data:any)=>operations.push(()=>{assert.equal(state.has(ref.path),false);state.set(ref.path,data);}),
        set:(ref:any,data:any)=>operations.push(()=>state.set(ref.path,data)),
        update:(ref:any,data:any)=>operations.push(()=>state.set(ref.path,{...state.get(ref.path),...data}))};
      const value=await callback(tx);operations.forEach(op=>op());return value;
    });queue=result.then(()=>undefined,()=>undefined);return result;
  }};
  const hours=Object.fromEntries(["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map(day=>[day,{open:"09:00",close:"17:00"}]));
  state.set("branches/branch-a",{ownerUid:"owner-a",status:"Active",timezone:"Australia/Sydney",hours,bookingLimitPerDay:1});
  state.set("services/service-a",{ownerUid:"owner-a",branches:["branch-a"]});
  state.set("call_center_agents/ai-a",{accountType:"ai-front-office",brand:"black",role:"agent",suspended:false,ownerUid:"owner-a",branchId:"branch-a",assignedWorkshops:["owner-a"]});
  return {db:db as Firestore,state};
}
const scope={ownerUid:"owner-a",branchId:"branch-a",uid:"ai-a"};
const data={ownerUid:"owner-a",branchId:"branch-a",date:"2099-01-05",time:"09:00",status:"Pending",price:100,duration:30,services:[{id:"service-a"}],bookingCode:"CC-TEST",vehicleType:null,createdBy:"ai-a"};

test("same request key has one reservation and returns the saved result after commit",async()=>{
  const {db,state}=database();const results=await Promise.all([beginAiBooking(db,scope,"test-key-00000001",data),beginAiBooking(db,scope,"test-key-00000001",data)]);
  const started=results.find(result=>"reservation" in result)!;
  assert.ok("reservation" in started && started.reservation);
  const booking=await commitCallCenterBooking(db,data,started.reservation);
  const replay=await beginAiBooking(db,scope,"test-key-00000001",data);
  assert.ok("replay" in replay);assert.equal(replay.replay?.bookingId,booking.id);
  assert.equal([...state.keys()].filter(key=>key.startsWith("bookings/")).length,1);
});
test("parallel bookings cannot exceed the branch's last daily place",async()=>{
  const {db,state}=database();
  const a=await beginAiBooking(db,scope,"test-key-00000001",{...data,client:"A"});
  const b=await beginAiBooking(db,scope,"test-key-00000002",{...data,client:"B"});
  assert.ok(a.reservation && b.reservation);
  const results=await Promise.allSettled([commitCallCenterBooking(db,data,a.reservation),commitCallCenterBooking(db,data,b.reservation)]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  assert.equal([...state.keys()].filter(key=>key.startsWith("bookings/")).length,1);
});
test("same key with altered details is rejected; object key order does not matter",async()=>{
  const {db}=database();await beginAiBooking(db,scope,"test-key-00000001",data);
  await assert.rejects(beginAiBooking(db,scope,"test-key-00000001",{...data,time:"10:00"}));
  assert.equal(canonicalBookingHash({a:1,b:2}),canonicalBookingHash({b:2,a:1}));
});
test("a service from another workshop and a suspended AI identity cannot commit",async()=>{
  const {db,state}=database();const started=await beginAiBooking(db,scope,"test-key-00000001",data);
  state.set("services/service-a",{ownerUid:"owner-b",branches:["branch-a"]});
  await assert.rejects(commitCallCenterBooking(db,data,started.reservation));
  state.set("services/service-a",{ownerUid:"owner-a",branches:["branch-a"]});
  state.get("call_center_agents/ai-a")!.suspended=true;
  await assert.rejects(commitCallCenterBooking(db,data,started.reservation));
  assert.equal([...state.keys()].filter(key=>key.startsWith("bookings/")).length,0);
});
test("invalid, closed, past and off-grid drop-off times are rejected",()=>{
  const {state}=database();const branch=state.get("branches/branch-a")!;
  assert.throws(()=>validateAiDropOff(branch,"2026-02-30","09:00"));
  assert.throws(()=>validateAiDropOff(branch,"2020-01-01","09:00"));
  assert.throws(()=>validateAiDropOff(branch,"2099-01-05","09:15"));
  assert.throws(()=>validateAiDropOff(branch,"2099-01-05","17:00"));
  branch.status="Inactive";assert.throws(()=>validateAiDropOff(branch,"2099-01-05","09:00"));
});
