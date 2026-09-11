import express from 'express';
import {createClient} from '@supabase/supabase-js';
import {createAccountService} from './service.js';
import {companyScope,manager,ownAccount,route} from './security.js';

export function createAccountRouter(service) {
  const router = express.Router();
  router.get('/profile',route(async(req,res)=>{ ownAccount(req); res.json({profile:await service.profile(req.user)}); }));
  router.patch('/profile',route(async(req,res)=>{ ownAccount(req); res.json({profile:await service.saveProfile(req.user,req.body)}); }));
  router.get('/sessions',route(async(req,res)=>{ ownAccount(req); res.json({sessions:await service.sessions(req.user)}); }));
  router.get('/company-settings',route(async(req,res)=>{
    res.json({settings:await service.settings(companyScope(req.user,req.query.company_id))});
  }));
  router.patch('/company-settings',route(async(req,res)=>{
    manager(req.user);
    res.json({settings:await service.saveSettings(companyScope(req.user,req.body.company_id),req.body)});
  }));
  return router;
}
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
export default createAccountRouter(createAccountService({supabase}));
