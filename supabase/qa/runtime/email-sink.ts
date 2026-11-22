// QA-only email sink. No Resend API access. Never send external mail.
import {createClient} from 'npm:@supabase/supabase-js@2.49.4';
import {CooldownTracker,cors,DEFAULT_FROM,isValidEmail,json,layout,resolveFromAddress,type SendEmailOptions,type SendResult} from './email-core.ts';
export {CooldownTracker,cors,DEFAULT_FROM,isValidEmail,json,layout,resolveFromAddress};
export type {SendEmailOptions,SendResult};
export const APP_URL='https://nsshdxxdvzzxlmdomixf.supabase.co/functions/v1/qa-portal';
async function capture(to:string,subject:string,html:string,_options?:SendEmailOptions):Promise<SendResult>{
 const recipient=to.trim().toLowerCase();
 if(!/^[a-z0-9._%+-]+@qa\.invalid$/.test(recipient))return {ok:false,status:403,error:'QA only: real email recipients are forbidden.'};
 const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data,error}=await admin.rpc('qa_capture_mail',{p_recipient:recipient,p_subject:subject,p_html:html});
 if(error||data!==true)return {ok:false,status:503,error:'QA private mail capture unavailable.'};
 return {ok:true};
}
export const sendEmail=capture;
export const sendTransactionalEmail=capture;