import {readFileSync} from 'node:fs';
export function settings(envFile) {
  if(!envFile)throw new Error('Supply --env-file with the configuration file path; do not pass secrets on the command line.');
  const allowed=['LIFI_API_KEY','ROBINHOOD_RPC_URL','ROBINHOOD_RPC_URL_SECONDARY','RPC_URL_ROBINHOOD'],env={};
  for(const line of readFileSync(envFile,'utf8').split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(m&&allowed.includes(m[1]))env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
  }
  const candidates=[env.ROBINHOOD_RPC_URL,env.ROBINHOOD_RPC_URL_SECONDARY,env.RPC_URL_ROBINHOOD].filter(Boolean);
  const rpcUrl=candidates.find(u=>new URL(u).hostname.endsWith('quiknode.pro'))??candidates[0];
  if(!rpcUrl||!env.LIFI_API_KEY)throw new Error('RPC/API configuration missing.');
  return {rpcUrl,apiKey:env.LIFI_API_KEY,redact:x=>{
    let s=String(x);for(const secret of [...candidates,env.LIFI_API_KEY])s=s.replaceAll(secret,'<redacted>');
    return s.replace(/https?:\/\/[^\s"'<>]+/g,'<url>').slice(0,1600);
  }};
}
