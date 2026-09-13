// Personal notification inbox. Critical events are emitted transactionally by
// migration 020; ticket transactional emails retain their existing durable outbox.
import express from 'express';
import rateLimit from 'express-rate-limit';
import {createClient} from '@supabase/supabase-js';
import {Resend} from 'resend';
import dotenv from 'dotenv';
import {createNotificationService,inboxScope,boundedInteger} from './service.js';
import {fail} from '../account/security.js';
dotenv.config();

function handler(action){
  return async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{const scope=inboxScope(req);res.json(await action(req,scope));}
    catch(error){res.status(error.status||503).json({error:error.code||'notifications_unavailable'});}
  };
}
export function createNotificationRouter(service){
  const router=express.Router();
  router.get('/',handler((req,scope)=>{
    const limit=boundedInteger(req.query.limit,25,100),offset=boundedInteger(req.query.offset,0,10000);
    if(limit<1||req.query.unread_only!==undefined&&!['true','false'].includes(req.query.unread_only))fail('invalid_pagination');
    return service.list(scope,{limit,offset,unreadOnly:req.query.unread_only==='true'});
  }));
  router.get('/unread-count',handler(async(req,scope)=>({unread_count:await service.count(scope)})));
  router.post('/mark-all-read',handler((req,scope)=>service.markAll(scope,req.body?.before)));
  router.post('/:id/read',handler((req,scope)=>service.markOne(scope,req.params.id)));
  router.delete('/:id',handler((req,scope)=>service.remove(scope,req.params.id)));
  router.get('/preferences',handler((req,scope)=>service.preferences(scope.userId)));
  router.patch('/preferences',handler((req,scope)=>service.savePreferences(scope.userId,req.body)));
  router.post('/send-test',rateLimit({windowMs:3600000,limit:3,standardHeaders:'draft-7',legacyHeaders:false,
    keyGenerator:req=>req.user?.id||'unauthenticated',message:{error:'email_test_rate_limited'}}),
    handler(req=>service.sendTest(req.user)));
  return router;
}
const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY
  ?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
const resend=process.env.RESEND_API_KEY?new Resend(process.env.RESEND_API_KEY):null;
export default createNotificationRouter(createNotificationService({supabase,resend}));
