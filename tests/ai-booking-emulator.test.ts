import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { initializeApp as clientApp, deleteApp as deleteClientApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously } from "firebase/auth";
import { getFirestore as clientFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } from "firebase/firestore";
import { beginAiBooking, commitCallCenterBooking } from "../lib/aiBookingCommit.js";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8187" || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9098") {
  throw new Error("These tests only run in the isolated demo-ai-bookings emulators.");
}
const app=initializeApp({projectId:"demo-ai-bookings"},"ai-booking-tests");
const db=getFirestore(app);
test.after(async()=>{await db.terminate();await deleteApp(app);});
async function fixture() {
  const id=randomUUID();const ownerUid=`owner-${id}`;const branchId=`branch-${id}`;const uid=`ai-${id}`;const serviceId=`service-${id}`;
  const hours=Object.fromEntries(["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map(day=>[day,{open:"09:00",close:"17:00"}]));
  await Promise.all([
    db.doc(`branches/${branchId}`).set({ownerUid,status:"Active",timezone:"Australia/Sydney",hours,bookingLimitPerDay:1}),
    db.doc(`services/${serviceId}`).set({ownerUid,branches:[branchId]}),
    db.doc(`call_center_agents/${uid}`).set({accountType:"ai-front-office",brand:"black",role:"agent",suspended:false,ownerUid,branchId,assignedWorkshops:[ownerUid]}),
  ]);
  return {scope:{ownerUid,branchId,uid},data:{ownerUid,branchId,date:"2099-01-05",time:"09:00",status:"Pending",price:100,duration:30,services:[{id:serviceId}],bookingCode:`CC-${id}`,vehicleType:null,createdBy:uid}};
}
test("Firestore transactions admit at most one concurrent request into the last daily place",async()=>{
  const {scope,data}=await fixture();
  const a=await beginAiBooking(db,scope,"emulator-key-000001",{...data,client:"A"});
  const b=await beginAiBooking(db,scope,"emulator-key-000002",{...data,client:"B"});
  assert.ok(a.reservation&&b.reservation);
  const results=await Promise.allSettled([commitCallCenterBooking(db,data,a.reservation),commitCallCenterBooking(db,data,b.reservation)]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  const bookings=await db.collection("bookings").where("ownerUid","==",scope.ownerUid).get();assert.equal(bookings.size,1);
});
test("durable retry returns the same booking and rejects an altered payload",async()=>{
  const {scope,data}=await fixture();const start=await beginAiBooking(db,scope,"emulator-key-000001",data);
  assert.ok(start.reservation);const saved=await commitCallCenterBooking(db,data,start.reservation);
  const retry=await beginAiBooking(db,scope,"emulator-key-000001",data);
  assert.equal(retry.replay?.bookingId,saved.id);
  await assert.rejects(beginAiBooking(db,scope,"emulator-key-000001",{...data,time:"10:00"}));
});
test("a cross-workshop service cannot be written",async()=>{
  const {scope,data}=await fixture();const start=await beginAiBooking(db,scope,"emulator-key-000001",data);
  await db.doc(`services/${data.services[0]!.id}`).update({ownerUid:"someone-else"});
  await assert.rejects(commitCallCenterBooking(db,data,start.reservation));
  assert.equal((await db.collection("bookings").where("ownerUid","==",scope.ownerUid).get()).size,0);
});
test("authenticated browser clients cannot read or forge AI request records and guards",async()=>{
  const browser=clientApp({projectId:"demo-ai-bookings",apiKey:"demo-key",authDomain:"demo-ai-bookings.firebaseapp.com"},"rules-test");
  const auth=getAuth(browser);connectAuthEmulator(auth,"http://127.0.0.1:9098",{disableWarnings:true});
  const client=clientFirestore(browser);connectFirestoreEmulator(client,"127.0.0.1",8187);
  await signInAnonymously(auth);
  for(const collection of ["aiBookingRequests","bookingDayGuards"]){
    const id=randomUUID();await db.doc(`${collection}/${id}`).set({serverOnly:true});
    await assert.rejects(getDoc(doc(client,collection,id)));
    await assert.rejects(setDoc(doc(client,collection,id),{response:{success:true}}));
  }
  await deleteClientApp(browser);
});
