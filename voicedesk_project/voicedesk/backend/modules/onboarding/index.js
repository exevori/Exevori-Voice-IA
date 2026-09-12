// Resumable onboarding. Provisioning retains the Task 3/16 service lock.
import express from 'express';
import {createClient} from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {createRagService} from '../kb/rag.js';
import {createKnowledgeService} from '../kb/service.js';
import {createOnboardingService,onboardingRoute} from './service.js';
import {fail} from '../account/security.js';
dotenv.config();

export function createOnboardingRouter(service) {
  const router=express.Router();
  router.get('/',onboardingRoute(async(req,res,id)=>res.json(await service.state(id))));
  router.get('/provisioning-status',onboardingRoute(async(req,res,id)=>res.json(await service.state(id))));
  for(const step of [1,2,3])router.post('/step/'+step,onboardingRoute(async(req,res,id)=>{
    res.json(await service.save(id,step,req.body,req.user));
  },{write:true}));
  // Keep the existing activation URL; only its service acquires provisioning.
  router.post('/step/5',onboardingRoute(async(req,res,id)=>res.json(await service.activate(id,req.body)),{write:true}));
  router.post('/test-call',onboardingRoute(async(req,res,id)=>res.json(await service.armTest(id,req.body)),{write:true}));
  // Compatibility endpoint: no caller-supplied number or call ID can complete it.
  router.post('/step/4',onboardingRoute(async(req,res,id)=>{
    const state=await service.state(id);
    if(!state.test.verified_at)fail('real_test_call_required',409);
    res.json(state);
  },{write:true}));
  router.post('/skip',onboardingRoute(async()=>fail('skip_not_allowed',409),{write:true}));
  return router;
}
const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY
  ?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
const knowledge=supabase?createKnowledgeService({supabase,ragService:createRagService({supabase})}):null;
export default createOnboardingRouter(createOnboardingService({supabase,knowledge,
  provision:async options=>(await import('./provision_service.js')).provisionNewClient(options)}));
