import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {settings} from './settings.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const args=process.argv.slice(2),arg=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
const repo=resolve(arg('--repo')??join(root,'../../..'));
const out=resolve(arg('--out')??join(repo,'artifacts/usdg-composer',new Date().toISOString().replaceAll(':','-')));
if(existsSync(out))throw new Error('Use a new output directory.');
mkdirSync(out,{recursive:true});
const cfg=settings(arg('--env-file')??join(repo,'.env.local'));
const replayDir=arg('--replay')?resolve(arg('--replay')):null;
const replay=replayDir?JSON.parse(readFileSync(join(replayDir,'results.json'),'utf8')):null;
const replayResponse=replayDir?readFileSync(join(replayDir,'composer-response.json'),'utf8'):null;
const require=createRequire(join(repo,'package.json')),v=require('viem');
const {privateKeyToAccount,mnemonicToAccount}=require('viem/accounts'),solc=require('solc');
const {createHardhatRuntimeEnvironment}=await import(pathToFileURL(require.resolve('hardhat/hre')));
const sdk=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/index.js')));
const {lifiComposer,resolveLifiComposerAccount}=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/adapters/lifi.js')));
const {withReceiptEvidence}=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/adapters/evm.js')));
const json=x=>JSON.stringify(x,(_k,a)=>typeof a==='bigint'?String(a):a,2);
const sha=x=>createHash('sha256').update(x).digest('hex');
const assets=JSON.parse(readFileSync(join(root,'assets.json'),'utf8'));
const cases=[],localTransactions=[],upstreamMethods={};
const report={startedAt:new Date().toISOString(),status:'IN_PROGRESS',publicTransactionsSubmitted:0,
  scope:'Real Robinhood token/Composer state and program; local model account, EntryPoint and qualified ArbSys block-number read; one owner-reviewed execution, not unattended DCA',
  executionMode:replay?'CAPTURED_PROGRAM_REPLAY':'FRESH_LIVE_QUOTE',
  qualifiedSdkBaseline:'82b3b2926da467e3530eba0c9f6c38452d8511ab',sourceIdentity:'DECLARED_BASELINE_WITH_RECORDED_FILE_HASHES',sdkVersion:'0.3.0-source-unpublished',composerSdkVersion:'0.11.3',
  tokens:assets.tokens,checks:cases,localTransactions,
  runtime:{node:process.version,solc:solc.version(),hardhat:'3.14.0',viem:'2.56.0'},
  provenance:{packageLockSha256:sha(readFileSync(join(repo,'package-lock.json'))),
    sdkPackageSha256:sha(readFileSync(join(repo,'packages/bag-sdk/package.json'))),
    sdkReceiptSourceSha256:sha(readFileSync(join(repo,'packages/bag-sdk/src/receipt.ts'))),
    sdkReceiptDistSha256:sha(readFileSync(join(repo,'packages/bag-sdk/dist/receipt.js'))),
    smartSessionArtifactSha256:sha(readFileSync(join(root,'vendor/SmartSession.json')))}};
const chain=v.defineChain({id:4663,name:'ISOLATED Robinhood fork; not public mainnet',nativeCurrency:{name:'Local Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[]}}});
const tokenAbi=v.parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
const deployment={chainId:4663,factory:'0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',factoryCodeHash:'0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5'};
const arbSys='0x0000000000000000000000000000000000000064';
const arbSysAbi=[...v.parseAbi(['function arbBlockNumber() view returns(uint256)']),{type:'error',name:'UnsupportedArbSysSelector',inputs:[{name:'selector',type:'bytes4'}]}];
const allowed=new Set(['eth_chainId','net_version','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_call','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getProof','eth_getUncleCountByBlockHash','eth_getUncleByBlockHashAndIndex']);
const rejectedRpcRequests=[];
let server,connection,stage='start';
let client,owner,keeper,account,policy,ep,smart,sudo,timeframe,sessionValidator,compiled,observation;
const vendor=Object.fromEntries(['SmartSession','SudoPolicy','TimeFramePolicy'].map(n=>[n,JSON.parse(readFileSync(join(root,'vendor',n+'.json'),'utf8'))]));
const artifacts={...vendor};
const abi=n=>artifacts[n].abi;
const bytecode=n=>artifacts[n].bytecode?.object??'0x'+artifacts[n].evm.bytecode.object;
const encode=(n,fn,args)=>v.encodeFunctionData({abi:abi(n),functionName:fn,args});
const packed=(target,data)=>v.concat([target,v.toHex(0n,{size:32}),data]);
const read=(a,n,fn,args=[])=>client.readContract({address:a,abi:abi(n),functionName:fn,args});
const wallet=a=>v.createWalletClient({account:a,chain,transport:v.custom({request:x=>connection.provider.request(x)})});
async function receipt(hash,kind){const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');localTransactions.push({hash,kind,blockNumber:r.blockNumber,gasUsed:r.gasUsed});return r;}
async function send(w,a,n,fn,args=[]){return receipt(await w.writeContract({address:a,abi:abi(n),functionName:fn,args,gas:15000000n,type:'eip1559'}),fn);}
async function deploy(n,args=[]){return (await receipt(await owner.deployContract({abi:abi(n),bytecode:bytecode(n),args,gas:15000000n,type:'eip1559'}),'deploy '+n)).contractAddress;}
async function ownerCall(target,n,fn,args=[]){return send(owner,account,'Local7579Account','ownerCall',[target,encode(n,fn,args)]);}
async function check(name,fn){stage=name;try{const details=await fn();cases.push({name,status:'PASS',details});console.log('PASS '+name);return details;}catch(e){cases.push({name,status:'FAIL',error:cfg.redact(e.message)});throw e;}}
async function balances(){return Object.fromEntries(await Promise.all(Object.entries(assets.tokens).map(async([s,t])=>[s,await client.readContract({address:t.address,abi:tokenAbi,functionName:'balanceOf',args:[account]})])));}
function errorDetails(e){const parts=[];for(let x=e,i=0;x&&i<8;x=x.cause,i++){if(x.data?.errorName)parts.push(x.data.errorName);if(x.shortMessage)parts.push(x.shortMessage);if(x.details)parts.push(x.details);}return cfg.redact(parts.join(' | ')||e.message);}
try{
  stage='compile research guard';
  const sources=Object.fromEntries(['ResearchAccount.sol','ReviewedPurchase.sol','LocalArbSysRead.sol'].map(name=>[name,{content:readFileSync(join(root,'contracts',name),'utf8')} ]));
  const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const buildKey=sha(solc.version()+json(input)),buildPath=join(out,'local-build.json');
  let built=existsSync(buildPath)?JSON.parse(readFileSync(buildPath,'utf8')):null;
  if(built?.buildKey!==buildKey){const output=JSON.parse(solc.compile(JSON.stringify(input)));for(const e of output.errors??[])if(e.severity==='error')throw new Error(e.formattedMessage);built={buildKey,compiler:solc.version(),output};writeFileSync(buildPath,json(built));}
  Object.assign(artifacts,...Object.values(built.output.contracts));
  const remote=v.createPublicClient({transport:v.http(cfg.rpcUrl,{retryCount:0,timeout:30000}),cacheTime:0});
  await check('upstream is the intended chain',async()=>{assert.equal(await remote.getChainId(),4663);return {chainId:4663};});
  const block=await remote.getBlock(replay?{blockNumber:BigInt(replay.fork.blockNumber)}:{});
  if(replay)assert.equal(block.hash,replay.fork.blockHash,'Saved replay block is not canonical.');
  report.fork={blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,hardhatVersion:'3.14.0',evmModel:'L1 Cancun with modeled ArbSys.arbBlockNumber; not Nitro gas accounting'};
  server=createServer(async(req,res)=>{
    try{
      let body='';for await(const c of req){body+=c;if(body.length>4000000)throw new Error('RPC request too large');}
      const parsed=JSON.parse(body),batch=Array.isArray(parsed)?parsed:[parsed];
      for(const call of batch){if(!allowed.has(call.method)){rejectedRpcRequests.push({method:call.method,isSubmissionMethod:/^eth_send/.test(call.method)});res.writeHead(403,{'content-type':'application/json'});res.end(json({jsonrpc:'2.0',id:call.id,error:{code:-32601,message:'Local fork proxy permits read-only RPC methods'}}));return;}upstreamMethods[call.method]=(upstreamMethods[call.method]??0)+1;}
      const response=await fetch(cfg.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(30000)});
      const result=await response.text();res.writeHead(response.status,{'content-type':'application/json'});res.end(result);
    }catch{res.writeHead(502,{'content-type':'application/json'});res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Read-only upstream unavailable"}}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const localUrl='http://127.0.0.1:'+server.address().port;
  await check('public submission blocked by RPC proxy',async()=>{
    const r=await fetch(localUrl,{method:'POST',body:json({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:['0x']})});assert.equal(r.status,403);return {httpStatus:r.status};
  });
  process.chdir(root);stage='initialize local fork';
  const runtime=await createHardhatRuntimeEnvironment({paths:{cache:join(out,'cache')},chainDescriptors:{4663:{name:'Robinhood research only',chainType:'l1',hardforkHistory:{cancun:{blockNumber:0}}}},networks:{experiment:{type:'edr-simulated',chainId:4663,chainType:'l1',hardfork:'cancun',...(replay?{initialDate:new Date(Number(block.timestamp)*1000)}:{}),forking:{url:localUrl,blockNumber:block.number},allowUnlimitedContractSize:false}}});
  connection=await runtime.network.connect('experiment');
  client=v.createPublicClient({chain,transport:v.custom({request:x=>connection.provider.request(x)}),cacheTime:0,pollingInterval:10});
  await check('native ArbSys block-number read is qualified and modeled explicitly',async()=>{
    const nativeValue=await remote.readContract({address:arbSys,abi:arbSysAbi,functionName:'arbBlockNumber',blockNumber:block.number});
    assert.equal(nativeValue,block.number,'Native ArbSys block number differs from the fork RPC height.');
    const originalCode=await client.getCode({address:arbSys});
    const runtimeCode='0x'+artifacts.LocalArbSysRead.evm.deployedBytecode.object;
    await client.request({method:'hardhat_setCode',params:[arbSys,runtimeCode]});
    // A Nitro header has no Cancun blob-gas field. Mine one local EDR header before
    // executing eth_call; do not reinterpret the native header as an L1 Cancun one.
    await client.request({method:'evm_mine',params:[]});
    const localHeight=await client.getBlockNumber({cacheTime:0});
    assert.equal(localHeight,nativeValue+1n);
    assert.equal(await client.readContract({address:arbSys,abi:arbSysAbi,functionName:'arbBlockNumber'}),localHeight);
    await assert.rejects(client.readContract({address:arbSys,abi:[...arbSysAbi,...v.parseAbi(['function unsupportedProbe() view returns(uint256)'])],functionName:'unsupportedProbe'}),error=>{
      for(let cause=error;cause;cause=cause.cause)if(cause.data?.errorName==='UnsupportedArbSysSelector')return true;
      return false;
    });
    report.precompileModel={address:arbSys,kind:'LOCAL_READ_MODEL_NOT_NATIVE_NITRO',supportedSelector:v.toFunctionSelector('arbBlockNumber()'),nativeValueAtFork:nativeValue,
      qualifiedBlockHash:block.hash,qualifiedLocalHeight:localHeight,originalCode,runtimeCodeHash:v.keccak256(runtimeCode),unsupportedSelectors:'REVERT',gasEquivalent:false};
    return report.precompileModel;
  });
  const accounts=await client.request({method:'eth_accounts'});
  // Public Hardhat development mnemonic; never signs for the upstream network.
  const devMnemonic='test test test test test test test test test test test junk';
  const ownerKey=mnemonicToAccount(devMnemonic,{addressIndex:0}),keeperKey=mnemonicToAccount(devMnemonic,{addressIndex:1});
  assert.equal(ownerKey.address.toLowerCase(),accounts[0].toLowerCase());assert.equal(keeperKey.address.toLowerCase(),accounts[1].toLowerCase());
  owner=wallet(ownerKey);keeper=wallet(keeperKey);
  await check('local transaction envelope carries the expected chain domain',async()=>{
    const hash=await wallet(accounts[1]).sendTransaction({to:keeper.account.address,value:0n,gas:21000n});
    await receipt(hash,'default envelope diagnostic');
    const tx=await client.getTransaction({hash});
    report.defaultEnvelopeDiagnostic={hash,type:tx.type,chainId:tx.chainId??null,rpcChainId:await client.getChainId()};
    const signedHash=await keeper.sendTransaction({to:keeper.account.address,value:0n,gas:21000n,type:'eip1559'});
    await receipt(signedHash,'signed local envelope diagnostic');
    const signedTx=await client.getTransaction({hash:signedHash});assert.equal(signedTx.chainId,4663);assert.equal(signedTx.type,'eip1559');
    report.signedEnvelopeDiagnostic={hash:signedHash,type:signedTx.type,chainId:signedTx.chainId};
    return {unlocked:report.defaultEnvelopeDiagnostic,signed:report.signedEnvelopeDiagnostic};
  });
  await check('forked factory bytecode matches research pin',async()=>{assert.equal(v.keccak256(await client.getCode({address:deployment.factory})),deployment.factoryCodeHash);return {...deployment,productionApproved:false};});
  await check('forked tokens match the recorded USDG, WETH and cbBTC definitions',async()=>{
    const details=[];
    for(const [symbol,token]of Object.entries(assets.tokens)){
      const [actualSymbol,decimals,code]=await Promise.all([client.readContract({address:token.address,abi:tokenAbi,functionName:'symbol'}),client.readContract({address:token.address,abi:tokenAbi,functionName:'decimals'}),client.getCode({address:token.address})]);
      assert.equal(actualSymbol,symbol);assert.equal(decimals,token.decimals);assert.equal(v.keccak256(code),token.codeHash);details.push({symbol,address:token.address,decimals});
    }return details;
  });
  stage='deploy local session account';
  ep=await deploy('LocalEntryPointHarness');smart=await deploy('SmartSession');sudo=await deploy('SudoPolicy');timeframe=await deploy('TimeFramePolicy');sessionValidator=await deploy('LocalSessionSignerValidator');
  account=await deploy('Local7579Account',[owner.account.address,ep,smart]);
  await send(owner,account,'Local7579Account','installValidator');
  report.account={address:account,owner:owner.account.address,keeper:keeper.account.address,smartSession:smart,entryPointModel:ep};
  const bag={bagJson:1,definition:{kind:'STATIC_BASKET',chain:'robinhood',mutability:'MUTABLE',assets:[
    {chain:'robinhood',address:assets.tokens.WETH.address,decimals:18,weightBps:4000},
    {chain:'robinhood',address:assets.tokens.cbBTC.address,decimals:8,weightBps:3000},
    {chain:'robinhood',address:assets.tokens.USDG.address,decimals:6,weightBps:3000}],rules:{weightBounds:{minBps:100,maxBps:7000},maxAssets:10,minInvestment:null,swapSlippageBps:100,rebalance:{frequency:'MANUAL',driftThresholdBps:500},performanceFeeBps:0,noRouteAssetPolicy:'BLOCK'}}};
  const parsed=sdk.parseBag(bag);assert(parsed.ok);assert(sdk.validateBag(parsed.bag).valid);
  const plan=sdk.planPurchase(parsed.bag,{inputToken:assets.tokens.USDG.address,amountRaw:100000000n,inputTokenDecimals:6,signer:account});
  report.strategy={bag:parsed.bag,definitionHash:sdk.hashBag(parsed.bag),plan,btcVariant:'cbBTC, explicitly different from the earlier WBTC model'};
  observation=await resolveLifiComposerAccount({chainId:4663,signer:account,deployment,client});
  report.composerAccount=observation;
  const captureFetch=async(url,init)=>{
    const response=replayResponse?new Response(replayResponse,{status:200,headers:{'content-type':'application/json','x-lifi-composer-version':replay.composerSdkVersion??'0.11.3','x-revision':'CAPTURED_REPLAY'}}):await fetch(url,init);
    report.apiRequests??=[];report.apiRequests.push({path:new URL(url).pathname,status:response.status,composerVersion:response.headers.get('x-lifi-composer-version'),revision:response.headers.get('x-revision')});
    if(response.ok){const data=await response.clone().json();if(data?.data?.transactionRequest)writeFileSync(join(out,'composer-response.json'),json(data));}
    return response;
  };
  await check(replay?'saved Composer program is rebound to the same fork signer and intent':'real Composer compiles USDG basket for the smart account signer',async()=>{
    compiled=await sdk.compileBag(parsed.bag,{inputToken:assets.tokens.USDG.address,amountRaw:100000000n,inputTokenDecimals:6,signer:account},{provider:lifiComposer({apiKey:cfg.apiKey,baseUrl:'https://composer.li.quest',account:observation,fetch:captureFetch,timeoutMs:60000}),trust:observation.trust});
    report.compiled=compiled;writeFileSync(join(out,'compiled.json'),json(compiled));
    if(replay){assert.equal(compiled.transaction.data,replay.compiled.transaction.data,'Replay calldata differs from the saved program.');assert.equal(compiled.quote.plan.signer,replay.compiled.quote.plan.signer);}
    assert.equal(compiled.transaction.value,0n);assert.equal(compiled.transaction.to.toLowerCase(),deployment.factory);assert.equal(plan.swapAmountRaw,70000000n);
    return {target:compiled.transaction.to,calldataHash:v.keccak256(compiled.transaction.data),approvals:compiled.approvals,legs:compiled.quote.legs};
  });
  await check('real fork USDG funding, with no token bytecode or storage replacement',async()=>{
    let holder;
    for(const candidate of [...assets.holderCandidates].reverse()){
      const balance=await client.readContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'balanceOf',args:[candidate.address]});
      if(balance>=100000000n){holder=candidate.address;break;}
    }
    assert(holder,'Recorded fork funding sources no longer hold 100 USDG; update the research holder snapshot.');
    await client.request({method:'hardhat_impersonateAccount',params:[holder]});
    await client.request({method:'hardhat_setBalance',params:[holder,v.toHex(v.parseEther('10'))]});
    const balance=await client.readContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'balanceOf',args:[holder]});assert(balance>=100000000n);
    await receipt(await wallet(holder).writeContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'transfer',args:[account,100000000n],gas:1000000n,type:'eip1559'}),'fork-only funding');
    await client.request({method:'hardhat_stopImpersonatingAccount',params:[holder]});
    assert.equal((await balances()).USDG,100000000n);return {holder,addressImpersonatedLocally:true,fundingRaw:100000000n};
  });
  const now=(await client.getBlock()).timestamp,start=now+30n;
  policy=await deploy('ReviewedPurchase',[account,assets.tokens.USDG.address,observation.proxy,deployment.factory,report.strategy.definitionHash,start,604800n,start+3600n,100000000n,70000000n]);
  await send(owner,account,'Local7579Account','setExecutor',[policy]);
  const minima=compiled.quote.legs.map(l=>({token:l.token,amountRaw:BigInt(l.minOutRaw)}));
  report.minimumReceived=minima;
  await send(owner,policy,'ReviewedPurchase','review',[compiled.transaction.to,compiled.transaction.data,minima.map(l=>l.token),minima.map(l=>l.amountRaw)]);
  const sessionKey=privateKeyToAccount(v.keccak256(v.stringToHex('BAG_USDG_FORK_ONLY_SESSION_SIGNER')));
  const session={sessionValidator,sessionValidatorInitData:sessionKey.address,salt:v.keccak256(v.stringToHex('BAG/USDG/ONE_REVIEWED_RUN')),
    userOpPolicies:[{policy:timeframe,initData:v.concat([v.toHex(start+3600n,{size:6}),v.toHex(now,{size:6})])}],erc7739Policies:{allowedERC7739Content:[],erc1271Policies:[]},
    actions:[{actionTargetSelector:v.toFunctionSelector('run(address,bytes)'),actionTarget:policy,actionPolicies:[{policy:sudo,initData:'0x'}]}],permitERC4337Paymaster:false};
  const permissionId=await read(smart,'SmartSession','getPermissionId',[session]);await ownerCall(smart,'SmartSession','enableSessions',[[session]]);
  report.session={permissionId,signer:sessionKey.address,policy,exactReviewedCalldata:true,ownerReviewRequiredForEachNewProgram:true,upstreamCommit:'f5aaf867f7e22f3b9d746ce6f404f3a56833757f'};
  async function invoke(data=compiled.transaction.data){
    const callData=encode('Local7579Account','execute',[v.zeroHash,packed(policy,encode('ReviewedPurchase','run',[compiled.transaction.to,data]))]);
    const nonce=await read(ep,'LocalEntryPointHarness','nonce',[account]);
    const op={sender:account,nonce,initCode:'0x',callData,accountGasLimits:v.zeroHash,preVerificationGas:0n,gasFees:v.zeroHash,paymasterAndData:'0x',signature:'0x'};
    const hash=await read(ep,'LocalEntryPointHarness','getUserOpHash',[op]);op.signature=v.concat(['0x00',permissionId,await sessionKey.sign({hash})]);
    const r=await send(keeper,ep,'LocalEntryPointHarness','handle',[op]);
    const event=v.parseEventLogs({abi:abi('LocalEntryPointHarness'),logs:r.logs,eventName:'OperationResult'})[0];
    assert(event);return {success:event.args.success,result:event.args.result,transactionHash:r.transactionHash,gasUsed:r.gasUsed};
  }
  await check('session attempt before scheduled time spends no USDG',async()=>{const before=await balances(),r=await invoke();assert.equal(r.success,false);assert.deepEqual(await balances(),before);assert.equal(await read(policy,'ReviewedPurchase','runs'),0n);return r;});
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(start)]});await client.request({method:'evm_mine',params:[]});
  await check('altered Composer program is rejected without spending USDG',async()=>{const before=await balances(),r=await invoke(v.concat([compiled.transaction.data,'0x00']));assert.equal(r.success,false);assert.deepEqual(await balances(),before);assert.equal(await read(policy,'ReviewedPurchase','runs'),0n);return r;});
  await check('keeper executes real first-use Composer basket with a session signature',async()=>{
    const before=await balances(),r=await invoke(),after=await balances();report.execution={...r,before,after};
    assert.equal(r.success,true,'Real Composer call reverted: '+r.result);
    assert.equal(before.USDG-after.USDG,70000000n);assert(after.WETH>before.WETH);assert(after.cbBTC>before.cbBTC);
    assert.equal(await client.readContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'allowance',args:[account,observation.proxy]}),0n);
    assert.equal(await read(policy,'ReviewedPurchase','runs'),1n);assert.equal(await read(policy,'ReviewedPurchase','grossBudgetUsed'),100000000n);
    return {...r,before,after,retainedUSDGRaw:30000000n,allowanceAfter:0n};
  });
  await check('SDK verifies the actual inner Composer call and token balance changes',async()=>{
    const tx=await client.getTransaction({hash:report.execution.transactionHash}),r=await client.getTransactionReceipt({hash:report.execution.transactionHash});
    writeFileSync(join(out,'execution-receipt.json'),json(r));
    writeFileSync(join(out,'execution-call-trace.json'),json(await client.request({method:'debug_traceTransaction',params:[report.execution.transactionHash,{tracer:'callTracer'}]})));
    report.executionEnvelope={tx:{chainId:tx.chainId??null,type:tx.type,hash:tx.hash,from:tx.from,to:tx.to,blockHash:tx.blockHash,blockNumber:tx.blockNumber},receipt:{from:r.from,to:r.to,blockHash:r.blockHash,blockNumber:r.blockNumber}};
    const result=await sdk.verifyPurchaseReceipt(compiled,{client:withReceiptEvidence(client),transactionHash:report.execution.transactionHash,minimumReceived:minima,confirmations:1});report.receiptVerification=result;
    assert.equal(result.status,'VERIFIED',json(result));assert.equal(result.transactionBinding,'CALL_TRACE');assert.equal(result.keptBalanceVerified,true);return result;
  });
  await check('replay after the authorized purchase spends no additional USDG',async()=>{const before=await balances(),r=await invoke();assert.equal(r.success,false);assert.deepEqual(await balances(),before);assert.equal(await read(policy,'ReviewedPurchase','runs'),1n);return r;});
  report.status='REAL_USDG_COMPOSER_FORK_EXECUTION_VERIFIED';
}catch(e){report.status='INCOMPLETE';report.failedStage=stage;report.error=errorDetails(e);process.exitCode=1;console.log('STOP '+stage+': '+report.error);}
finally{
  if(connection&&report.execution?.transactionHash&&!report.execution.success){
    try{
      const hash=report.execution.transactionHash;
      const [r,trace]=await Promise.all([client.getTransactionReceipt({hash}),client.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer'}]})]);
      writeFileSync(join(out,'execution-receipt.json'),json(r));writeFileSync(join(out,'execution-call-trace.json'),json(trace));
      const failures=[];function walk(node,depth=0){if(node.error)failures.push({depth,type:node.type,to:node.to,selector:node.input?.slice(0,10),error:node.error,output:node.output,gasUsed:node.gasUsed});for(const child of node.calls??[])walk(child,depth+1);}walk(trace);
      report.executionDiagnostics={failedCallFrames:failures};
    }catch(e){report.diagnosticError=errorDetails(e);}
  }
  report.finishedAt=new Date().toISOString();report.rpcBoundary={rejectedRpcRequests,upstreamReadMethods:upstreamMethods,publicSubmissionMethodsForwarded:0};
  report.summary={pass:cases.filter(x=>x.status==='PASS').length,fail:cases.filter(x=>x.status==='FAIL').length};
  writeFileSync(join(out,'results.json'),json(report));console.log(json({status:report.status,summary:report.summary,failedStage:report.failedStage,error:report.error,outputDirectory:out}));
  if(connection)await connection.close();if(server)await new Promise(r=>server.close(r));
}
