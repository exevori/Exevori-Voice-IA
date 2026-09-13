import {createClient} from '@supabase/supabase-js';
export async function runNotificationMaintenance({supabase,maxBatches=20}){
  let scrubbed=0;
  for(let i=0;i<maxBatches;i++){
    const {data,error}=await supabase.rpc('scrub_expired_product_notifications',{p_limit:500}).abortSignal(AbortSignal.timeout(10000));
    if(error||!Number.isInteger(data)||data<0||data>500)throw new Error('notification_retention_unavailable');
    scrubbed+=data;if(data<500)return {scrubbed,backlog:false};
  }
  return {scrubbed,backlog:true};
}
export function startNotificationMaintenance({supabase,logger=console}={}){
  const storage=supabase||createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
  let stopped=false,timer;
  const tick=async()=>{
    let retry=false;
    try{retry=(await runNotificationMaintenance({supabase:storage})).backlog;}
    catch{retry=true;logger.error('Notification retention unavailable');}
    if(!stopped){timer=setTimeout(tick,retry?300000:3600000);timer.unref?.();}
  };
  void tick();return()=>{stopped=true;clearTimeout(timer);};
}
