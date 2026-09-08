// Guided physical-device acceptance using two isolated real MCP agents.
// Only synthetic questions are sent; answers never execute another operation.
// Usage: node scripts/iphone_acceptance.mjs /path/to/released/ask-a-human VERSION COMMIT
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';

const [binaryArg, version, commit] = process.argv.slice(2);
if (!binaryArg || !/^\d+\.\d+\.\d+$/.test(version || '') || !/^[0-9a-f]{40}$/.test(commit || '')) {
  console.error('Usage: node scripts/iphone_acceptance.mjs /path/to/released/ask-a-human VERSION FULL_COMMIT');
  process.exit(2);
}
const binary = path.resolve(binaryArg);
const info = JSON.parse(execFileSync(binary, ['version', '--json'], {encoding:'utf8'}));
assert.deepEqual(info, {version, commit}, 'Use the exact published release binary for this device test.');
const terminal = createInterface({input:process.stdin,output:process.stdout});
const agents = [], results = [];
const promptAbort = new AbortController();
let stopping = false;
let cleanup;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const proceed = async message => {console.log('\n'+message);await terminal.question('Press Return when ready. ', {signal:promptAbort.signal});};
function stop() {
  if(cleanup)return cleanup;
  stopping=true;promptAbort.abort();terminal.close();
  cleanup=Promise.all(agents.map(({name,child})=>new Promise((resolve,reject)=>{
    if(!child.pid || child.exitCode!==null || child.signalCode!==null){resolve();return;}
    const finish=()=>{clearTimeout(killTimer);clearTimeout(exitTimer);resolve();};
    child.once('exit',finish);
    const killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);
    const exitTimer=setTimeout(()=>reject(new Error(name+' did not exit during cleanup')),5000);
    child.kill('SIGTERM');
  })));
  return cleanup;
}
const onSignal=code=>{process.exitCode=code;void stop().catch(error=>{console.error(error.message);process.exitCode=1;});};
process.once('SIGINT',()=>onSignal(130));
process.once('SIGTERM',()=>onSignal(143));
function mcp(name) {
  const vapid=createECDH('prime256v1');vapid.generateKeys();
  const child=spawn(binary,['serve','--relay','wss://ask-a-human.ai/ws','--name',name],{
    env:{...process.env,AAH_VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),AAH_VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url')},
    // Pairing codes stay in the user's local terminal/loopback pairing page.
    stdio:['pipe','pipe','inherit'],
  });
  let buffer='',sequence=0;
  const pending=new Map();
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',fail);
  child.on('exit',()=>fail(new Error(name+' process exited')));
  child.stdin.on('error',fail);
  child.stdout.setEncoding('utf8'); // Pipe chunks may split a Unicode scalar's bytes.
  child.stdout.on('data',data=>{
    buffer+=data;
    if(buffer.length>1024*1024){fail(new Error('Unexpectedly large MCP output'));child.kill();return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let message;try{message=JSON.parse(line);}catch{fail(new Error('Invalid MCP output'));continue;}
      if(!message || typeof message!=='object' || Array.isArray(message) || message.jsonrpc!=='2.0') {
        fail(new Error('Invalid MCP message shape'));continue;
      }
      if(message.id===undefined) {
        if(typeof message.method!=='string')fail(new Error('Invalid MCP notification'));
        continue;
      }
      if(!Number.isSafeInteger(message.id) || message.id<=0 || Object.hasOwn(message,'result')===Object.hasOwn(message,'error')) {
        fail(new Error('Invalid MCP response'));continue;
      }
      const p=pending.get(message.id);if(!p)continue;
      pending.delete(message.id);clearTimeout(p.timer);
      message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);
    }
  });
  const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(name+' MCP call timed out'));},150000);
    pending.set(id,{resolve,reject,timer});send({id,method,params});
  });
  const agent={name,child,tool:(name,args={})=>rpc('tools/call',{name,arguments:args}),initialize:async()=>{
    await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'physical-iphone-acceptance',version}});
    send({method:'notifications/initialized'});
  }};
  agents.push(agent);return agent;
}
const toolText=result=>(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
async function pair(agent) {
  await agent.initialize();
  const start=await agent.tool('start_pairing');assert.notEqual(start.isError,true);
  console.log('\nPair '+agent.name+' using the code in its local pairing page or terminal.');
  const end=Date.now()+180000;
  for(;;){
    if(stopping)throw new Error('Stopped');
    const status=await agent.tool('pair_status');
    if(/^paired\s*[—-]/.test(toolText(status)))break;
    if(Date.now()>end)throw new Error('Pairing was not completed within three minutes');
    await wait(1500);
  }
  console.log(agent.name+' paired.');
}
async function ask(agent,label,args,expected) {
  console.log('\n'+label+' — '+agent.name);
  const result=await agent.tool('request_approval',{category:'other',expires_in_s:120,...args});
  if(expected==='timeout') {
    assert.equal(result.isError,true,'Expired request must not return an answer');
    assert.match(toolText(result), /agent: request timed out|context deadline exceeded/, 'A transport or validation error is not proof of expiry');
  }
  else {
    assert.notEqual(result.isError,true,toolText(result));
    assert.deepEqual(result.structuredContent,expected,label+' structured output must contain exactly the expected result field');
    assert.equal(result.content?.length,1,label+' must have exactly one text representation');
    assert.equal(result.content[0].type,'text');
    assert.deepEqual(JSON.parse(result.content[0].text),expected,label+' text output must match the exact structured result');
  }
  results.push({test:label,passed:true});
  console.log('PASS: '+label+'; the MCP caller received the expected outcome.');
}
try {
  console.log(`Physical iPhone acceptance for ${version} (${commit.slice(0,7)}). No approval triggers an external action.`);
  await proceed('Open the deployed Home Screen app. Use Add agent and verify its footer shows this version/commit.');
  const a=mcp('Phone test A');await pair(a);
  await proceed('While the app is listening, tap Enable notifications and allow them. Confirm notification setup is reported.');
  await ask(a,'Full text and canceled swipe',{
    title:'Read the complete harmless test request — '+ 'Visible context. '.repeat(16)+'END-TITLE-7391',
    summary:'Scroll through the full text. Try beginning an approval swipe and then cancel it by moving vertically. It must remain unanswered. Finally tap Decline.\n\n'+ 'This is synthetic test context. '.repeat(35)+'END-SUMMARY-7391',response_kind:'yesno',
  },{approved:false});
  const options=Array.from({length:32},(_,i)=>`Option ${String(i+1).padStart(2,'0')}: ${'Read the complete label. '.repeat(3)}END-${i+1}`);
  await ask(a,'All 32 choices', {title:'Choose option 32',summary:'Scroll to the final option and select it. Confirm its entire label is readable.',response_kind:'choice',options},{choice:options[31]});
  await proceed('Verify Answer received by agent remains visible for at least five seconds and the complete chosen label is readable. Tap Done; listening should return.');
  await ask(a,'Unicode text and keyboard', {title:'Paste exactly: 😀é漢字🚀',summary:'Paste the five characters from the title, open the keyboard, and send. The counter should show 5/5.',response_kind:'text',max_len:5},{text:'😀é漢字🚀'});
  const longReply='This synthetic reply must remain fully readable.\n'.repeat(24)+'END-REPLY-7391';
  console.log('\nCopy the following synthetic text for the next reply:\n\n'+longReply+'\n');
  await proceed('Copy this text to paste on the phone. The next question also contains the same text for selection.');
  await ask(a,'Long reply receipt', {title:'Paste the complete synthetic reply',summary:'Copy only the text below into the reply, including its final marker:\n\n'+longReply,response_kind:'text',max_len:4096},{text:longReply});
  await proceed('Verify the receipt label remains visible, scroll the full reply to END-REPLY-7391, wait at least five seconds, and tap Done. Listening should return.');
  await proceed('Next is a 15-second expiry test. Once the request appears, switch agents/screens or background the app for at least 20 seconds. Reopening must not restart the deadline or allow approval.');
  await ask(a,'Expiry across backgrounding',{title:'Do not answer this expiry test',summary:'Background the app for at least 20 seconds; return and verify this request cannot be approved.',response_kind:'yesno',expires_in_s:15},'timeout');
  await proceed('Reopen the app. The next request tests reconnect: enable Airplane Mode briefly, disable it, then reopen the app and decline the same request.');
  await ask(a,'Network recovery',{title:'Reconnect, then decline',summary:'Toggle Airplane Mode on for about 10 seconds, turn it off, return here, and tap Decline.',response_kind:'yesno'},{approved:false});
  await proceed('Use Add agent for Phone test B. Keep A paired.');
  const b=mcp('Phone test B');await pair(b);
  await proceed('Confirm notifications are set up for two agents without another permission prompt. Close and reopen the Home Screen app; both should return.');
  for(const agent of [a,b,a]) {
    await proceed('Lock the iPhone before requesting a notification from '+agent.name+'. Tap its generic notification, confirm the matching agent opens, and decline.');
    await ask(agent,'Locked-phone notification '+agent.name,{title:'Harmless notification from '+agent.name,summary:'Confirm the notification opened this exact agent, then tap Decline.',response_kind:'yesno'},{approved:false});
  }
  await proceed('Forget Phone test A in the app. Keep B paired, reopen the app, and lock the phone again.');
  await ask(b,'Sibling notification after forgetting A',{title:'B still works after forgetting A',summary:'A was removed. This notification must still open B. Tap Decline.',response_kind:'yesno'},{approved:false});
  await proceed('Block notifications in iPhone Settings and reopen the app. Confirm the blocked status is visible. Restore permission afterward, then remove the two synthetic Phone test entries.');
  console.log('\n'+JSON.stringify({version,commit,tests:results,device:'physical iPhone; record iOS version and any visual/notification failure separately'},null,2));
} catch(error) {
  if(!stopping)throw error;
} finally {await stop();}
