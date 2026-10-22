import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {settings} from '../usdg-composer/settings.mjs';
import {composerWire} from '../usdg-recurring/wire.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const shared=resolve(root,'../usdg-composer');
const args=process.argv.slice(2),arg=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
if(arg('--replay'))throw new Error('Recurring qualification requires fresh quotes; use usdg-composer/run.mjs for captured single-call replay.');
const repo=resolve(arg('--repo')??join(root,'../../..'));
const out=resolve(arg('--out')??join(repo,'artifacts/dca-trial-cli',new Date().toISOString().replaceAll(':','-')));
if(existsSync(out))throw new Error('Use a new output directory.');
mkdirSync(out,{recursive:true});
const cfg=settings(arg('--env-file')??join(repo,'.env.local'));
const replayDir=arg('--replay')?resolve(arg('--replay')):null;
const replay=replayDir?JSON.parse(readFileSync(join(replayDir,'results.json'),'utf8')):null;
const replayResponse=replayDir?readFileSync(join(replayDir,'composer-response.json'),'utf8'):null;
const require=createRequire(join(repo,'package.json')),v=require('viem');
const wire=composerWire(v);
const {privateKeyToAccount,mnemonicToAccount}=require('viem/accounts'),solc=require('solc');
const {createHardhatRuntimeEnvironment}=await import(pathToFileURL(require.resolve('hardhat/hre')));
const sdk=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/index.js')));
const {lifiComposer,resolveLifiComposerAccount}=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/adapters/lifi.js')));
const {withReceiptEvidence}=await import(pathToFileURL(join(repo,'packages/bag-sdk/dist/adapters/evm.js')));
const json=x=>JSON.stringify(x,(_k,a)=>typeof a==='bigint'?String(a):a,2);
const sha=x=>createHash('sha256').update(x).digest('hex');
const assets=JSON.parse(readFileSync(join(shared,'assets.json'),'utf8'));
const {buildDcaPlan}=await import(pathToFileURL(join(repo,'lib/dca/plan.ts')));
if(!arg('--config'))throw new Error('Pass --config with the local trial request JSON');
const config=JSON.parse(readFileSync(resolve(arg('--config')),'utf8'));
const checked=buildDcaPlan(config.settings);
for(const field of ['budgetRaw','amountRaw','remainderRaw','purchases','intervalSeconds'])assert.equal(config.plan[field],checked[field],'Plan/settings mismatch: '+field);
const gross=BigInt(checked.amountRaw),budget=BigInt(checked.budgetRaw),runCount=checked.purchases;

const cases=[],localTransactions=[],upstreamMethods={};
const report={startedAt:new Date().toISOString(),status:'IN_PROGRESS',publicTransactionsSubmitted:0,
  scope:'Real Robinhood token/Composer state and program; local model account, EntryPoint and qualified ArbSys block-number read; user-configured, policy-validated recurring purchases; accelerated local schedule, not production DCA',
  executionMode:replay?'CAPTURED_PROGRAM_REPLAY':'FRESH_LIVE_QUOTE',
  qualifiedSdkBaseline:'82b3b2926da467e3530eba0c9f6c38452d8511ab',sourceIdentity:'DECLARED_BASELINE_WITH_RECORDED_FILE_HASHES',sdkVersion:'0.3.0-source-unpublished',composerSdkVersion:'0.11.3',
  tokens:assets.tokens,checks:cases,localTransactions,
  runtime:{node:process.version,solc:solc.version(),hardhat:'3.14.0',viem:'2.56.0'},
  provenance:{packageLockSha256:sha(readFileSync(join(repo,'package-lock.json'))),
    sdkPackageSha256:sha(readFileSync(join(repo,'packages/bag-sdk/package.json'))),
    sdkReceiptSourceSha256:sha(readFileSync(join(repo,'packages/bag-sdk/src/receipt.ts'))),
    sdkReceiptDistSha256:sha(readFileSync(join(repo,'packages/bag-sdk/dist/receipt.js'))),
    recurringGuardSha256:sha(readFileSync(join(root,'contracts/ConfiguredPurchase.sol'))),wireSha256:sha(readFileSync(join(root,'../usdg-recurring/wire.mjs'))),runnerSha256:sha(readFileSync(join(root,'run.mjs'))),smartSessionArtifactSha256:sha(readFileSync(join(shared,'vendor/SmartSession.json')))}};
const chain=v.defineChain({id:4663,name:'ISOLATED Robinhood fork; not public mainnet',nativeCurrency:{name:'Local Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[]}}});
const tokenAbi=v.parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
const deployment={chainId:4663,factory:'0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',factoryCodeHash:'0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5'};
const arbSys='0x0000000000000000000000000000000000000064';
const arbSysAbi=[...v.parseAbi(['function arbBlockNumber() view returns(uint256)']),{type:'error',name:'UnsupportedArbSysSelector',inputs:[{name:'selector',type:'bytes4'}]}];
const allowed=new Set(['eth_chainId','net_version','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_call','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getProof','eth_getUncleCountByBlockHash','eth_getUncleByBlockHashAndIndex']);
const rejectedRpcRequests=[];
let server,connection,stage='start';
let client,owner,keeper,account,policy,ep,smart,sudo,timeframe,sessionValidator,compiled,observation;
const vendor=Object.fromEntries(['SmartSession','SudoPolicy','TimeFramePolicy'].map(n=>[n,JSON.parse(readFileSync(join(shared,'vendor',n+'.json'),'utf8'))]));
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
  const sources=Object.fromEntries(['ResearchAccount.sol','LocalArbSysRead.sol'].map(name=>[name,{content:readFileSync(join(shared,'contracts',name),'utf8')} ]));
  sources['ConfiguredPurchase.sol']={content:readFileSync(join(root,'contracts/ConfiguredPurchase.sol'),'utf8')};
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
  const runtime=await createHardhatRuntimeEnvironment({paths:{cache:join(out,'cache')},chainDescriptors:{4663:{name:'Robinhood research only',chainType:'l1',hardforkHistory:{cancun:{blockNumber:0}}}},networks:{experiment:{type:'edr-simulated',chainId:4663,chainType:'l1',hardfork:'cancun',...(replay?{initialDate:new Date(Number(block.timestamp)*1000)}:{}),forking:{url:localUrl,blockNumber:block.number},allowUnlimitedContractSize:false,throwOnTransactionFailures:false}}});
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
  account=await deploy('Local7579Account',[owner.account.address,ep,smart]);await send(owner,account,'Local7579Account','installValidator');
  report.account={address:account,owner:owner.account.address,keeper:keeper.account.address,smartSession:smart,entryPointModel:ep};
  const parsed=sdk.parseBag(config.bag);assert(parsed.ok);assert(sdk.validateBag(parsed.bag).valid);
  assert.equal(sdk.hashBag(parsed.bag),config.definitionHash);
  const expectedTokens=new Map([[assets.tokens.WETH.address,4000],[assets.tokens.cbBTC.address,3000],[assets.tokens.USDG.address,3000]]);
  assert.equal(parsed.bag.definition.chain,'robinhood');assert.equal(parsed.bag.definition.assets.length,3);
  for(const a of parsed.bag.definition.assets)assert.equal(expectedTokens.get(a.address.toLowerCase()),a.weightBps);
  assert(!parsed.bag.definition.rules.performanceFeeBps,'Performance-fee accounting is outside this local trial');
  const plan=sdk.planPurchase(parsed.bag,{inputToken:assets.tokens.USDG.address,amountRaw:gross,inputTokenDecimals:6,signer:account});
  const swapAmount=plan.swapAmountRaw;
  assert.equal(swapAmount+plan.kept.amountRaw,gross);
  assert(plan.kept.amountRaw>=gross*3000n/10000n&&plan.kept.amountRaw<=gross*3000n/10000n+1n);
  report.settings=config.settings;report.requestedPlan=config.plan;
  report.strategy={bag:parsed.bag,definitionHash:sdk.hashBag(parsed.bag),plan};
  const captureFetch=async(url,init)=>{
    const response=await fetch(url,init);report.apiRequests??=[];
    report.apiRequests.push({path:new URL(url).pathname,status:response.status,composerVersion:response.headers.get('x-lifi-composer-version'),revision:response.headers.get('x-revision')});
    if(response.ok){const data=await response.clone().json();if(data?.data?.transactionRequest)writeFileSync(join(out,'composer-response.json'),json(data));}
    return response;
  };
  observation=await resolveLifiComposerAccount({chainId:4663,signer:account,deployment,client});
  await check('Composer compiles the selected Bag and purchase amount',async()=>{
    compiled=await sdk.compileBag(parsed.bag,{inputToken:assets.tokens.USDG.address,amountRaw:gross,inputTokenDecimals:6,signer:account},{provider:lifiComposer({apiKey:cfg.apiKey,baseUrl:'https://composer.li.quest',account:observation,fetch:captureFetch,timeoutMs:60000}),trust:observation.trust});
    assert.equal(compiled.transaction.value,0n);assert.equal(compiled.transaction.to.toLowerCase(),deployment.factory);return {definitionHash:report.strategy.definitionHash,grossRaw:gross,swapRaw:swapAmount};
  });
  await check('the selected USDG budget is funded only on the local fork',async()=>{
    let holder;
    for(const candidate of [...assets.holderCandidates].reverse())if(await client.readContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'balanceOf',args:[candidate.address]})>=budget){holder=candidate.address;break;}
    assert(holder,'Recorded public-holder funding source does not cover the selected local budget');
    await client.request({method:'hardhat_impersonateAccount',params:[holder]});await client.request({method:'hardhat_setBalance',params:[holder,v.toHex(v.parseEther('10'))]});
    await receipt(await wallet(holder).writeContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'transfer',args:[account,budget],gas:1000000n,type:'eip1559'}),'fork-only funding');
    await client.request({method:'hardhat_stopImpersonatingAccount',params:[holder]});assert.equal((await balances()).USDG,budget);return {budgetRaw:budget,holder,localImpersonation:true};
  });
  const decoded=wire.decode(compiled.transaction.data),btcSwap=wire.swap(decoded.state[6]),ethSwap=wire.swap(decoded.state[10]);
  const profile={btcInput:btcSwap[5][0].fromAmount,ethInput:ethSwap[5][0].fromAmount,btcNet:btcSwap[5][1].fromAmount,ethNet:ethSwap[5][1].fromAmount,partitionHash:v.keccak256(decoded.state[12]),btcFeeHash:v.keccak256(btcSwap[5][0].callData),ethFeeHash:v.keccak256(ethSwap[5][0].callData)};
  const floors=compiled.quote.legs.map(l=>({token:l.token,amountRaw:BigInt(l.minOutRaw)*9900n/10000n}));
  assert.equal(floors[0].token.toLowerCase(),assets.tokens.WETH.address);assert.equal(floors[1].token.toLowerCase(),assets.tokens.cbBTC.address);
  assert(floors.every(l=>l.amountRaw>0n));
  const now=(await client.getBlock()).timestamp,period=BigInt(config.plan.intervalSeconds),start=now+period,expiry=start+period*BigInt(runCount+2);
  policy=await deploy('ConfiguredPurchase',[account,report.strategy.definitionHash,gross,budget,start,period,expiry,floors[0].amountRaw,floors[1].amountRaw,profile]);
  await send(owner,account,'Local7579Account','setExecutor',[policy]);
  const context=await read(policy,'ConfiguredPurchase','context');
  const normalize=(result,observed)=>({...result,transaction:{...result.transaction,to:observed.proxyDeployed?observed.proxy:observed.factory,data:wire.normalize(result.transaction.data,context,observed.proxyDeployed)}});
  compiled=normalize(compiled,observation);
  report.policy={address:policy,definitionHash:report.strategy.definitionHash,grossPerRun:gross,swapPerRun:swapAmount,keptPerRun:gross-swapAmount,maxRuns:runCount,maxGross:budget,start,periodSeconds:period,expiry,ownerFloors:floors,profile,context,pricePolicy:'FIXED_INITIAL_QUANTITY_FLOORS_NOT_LIVE_ORACLE',schedule:'REQUESTED_INTERVAL_IN_LOCAL_BLOCK_TIMESTAMPS; TIME_ADVANCED_NOT_WALL_CLOCK'};
  const sessionKey=privateKeyToAccount(v.keccak256(v.stringToHex('BAG_USDG_FORK_ONLY_RECURRING_SESSION_SIGNER')));
  const session={sessionValidator,sessionValidatorInitData:sessionKey.address,salt:v.keccak256(v.stringToHex('BAG/USDG/RECURRING_POLICY_V1')),
    userOpPolicies:[{policy:timeframe,initData:v.concat([v.toHex(expiry+600n,{size:6}),v.toHex(now,{size:6})])}],erc7739Policies:{allowedERC7739Content:[],erc1271Policies:[]},
    actions:[{actionTargetSelector:v.toFunctionSelector('run(address,bytes)'),actionTarget:policy,actionPolicies:[{policy:sudo,initData:'0x'}]}],permitERC4337Paymaster:false};
  const permissionId=await read(smart,'SmartSession','getPermissionId',[session]);await ownerCall(smart,'SmartSession','enableSessions',[[session]]);
  report.session={permissionId,signer:sessionKey.address,policy,ownerPolicyGrants:1,ownerReviewRequiredForEachNewProgram:false,upstreamCommit:'f5aaf867f7e22f3b9d746ce6f404f3a56833757f',accountAndEntryPoint:'MINIMAL_LOCAL_MODELS_NOT_PRODUCTION_WALLET'};
  async function invoke(options={}){
    const tx=options.tx??compiled.transaction;
    const actionTarget=options.actionTarget??policy;
    const actionData=options.actionData??encode('ConfiguredPurchase','run',[tx.to,tx.data]);
    const callData=encode('Local7579Account','execute',[v.zeroHash,packed(actionTarget,actionData)]);
    const nonce=await read(ep,'LocalEntryPointHarness','nonce',[account]);
    const op=options.op??{sender:account,nonce,initCode:'0x',callData,accountGasLimits:v.zeroHash,preVerificationGas:0n,gasFees:v.zeroHash,paymasterAndData:'0x',signature:'0x'};
    if(!options.op){const hash=await read(ep,'LocalEntryPointHarness','getUserOpHash',[op]);op.signature=v.concat(['0x00',permissionId,await (options.signer??sessionKey).sign({hash})]);}
    const hash=await keeper.writeContract({address:ep,abi:abi('LocalEntryPointHarness'),functionName:'handle',args:[op],gas:15000000n,type:'eip1559'});
    const r=await client.waitForTransactionReceipt({hash});
    localTransactions.push({hash,kind:'session handle',blockNumber:r.blockNumber,gasUsed:r.gasUsed,outerStatus:r.status});
    const event=v.parseEventLogs({abi:abi('LocalEntryPointHarness'),logs:r.logs,eventName:'OperationResult'})[0];
    if(r.status==='reverted')return {success:false,outerRejected:true,transactionHash:hash,gasUsed:r.gasUsed,op};
    assert(event);return {success:event.args.success,result:event.args.result,transactionHash:hash,gasUsed:r.gasUsed,op};
  }
  async function counters(){return {runs:await read(policy,'ConfiguredPurchase','runs'),gross:await read(policy,'ConfiguredPurchase','grossBudgetUsed'),last:await read(policy,'ConfiguredPurchase','lastExecution'),window:await read(policy,'ConfiguredPurchase','lastWindow'),allowance:await client.readContract({address:assets.tokens.USDG.address,abi:tokenAbi,functionName:'allowance',args:[account,observation.proxy]})};}
  async function rejected(name,options={},error){return check(name,async()=>{
    const before=await balances(),budget=await counters(),r=await invoke(options);
    assert.equal(r.success,false,'Attempt unexpectedly succeeded');
    if(error)assert.equal(r.result?.slice(0,10),v.toFunctionSelector(error),'Unexpected rejection: '+r.result);
    assert.deepEqual(await balances(),before);assert.deepEqual(await counters(),budget);
    return {transactionHash:r.transactionHash,outerRejected:r.outerRejected??false,revertData:r.result,budgetUnchanged:true,balancesUnchanged:true};
  });}
  async function advance(t){const current=(await client.getBlock()).timestamp;if(t>current){await client.request({method:'evm_setNextBlockTimestamp',params:[Number(t)]});await client.request({method:'evm_mine',params:[]});}}
  async function branch(fn){const id=await client.request({method:'evm_snapshot',params:[]}),first=localTransactions.length;try{return await fn();}finally{assert(await client.request({method:'evm_revert',params:[id]}));for(const tx of localTransactions.slice(first))tx.revertedBySnapshot=true;}}
  function changed(fn){return {tx:{...compiled.transaction,data:wire.mutate(compiled.transaction.data,fn)}};}
  function changedSwap(fn,slot=6){return {tx:{...compiled.transaction,data:wire.mutateSwap(compiled.transaction.data,slot,fn)}};}

  await rejected('before the selected interval: no USDG is spent',{},'NotDue()');
  await advance(start);
  await check('selected budget, amount and interval are enforced on chain',async()=>{
    assert.equal(await read(policy,'ConfiguredPurchase','grossAmount'),gross);assert.equal(await read(policy,'ConfiguredPurchase','maxGross'),budget);assert.equal(await read(policy,'ConfiguredPurchase','maxRuns'),BigInt(runCount));assert.equal(await read(policy,'ConfiguredPurchase','period'),period);
    await read(policy,'ConfiguredPurchase','validate',[compiled.transaction.to,compiled.transaction.data]);return report.policy;
  });
  await rejected('changed Composer instruction is rejected',changed(x=>{x.instructions[0][0]=0n;}),'ProfileViolation(uint256)');
  await rejected('changed amount in a constant slot is rejected',changed(x=>{x.state[9]=v.toHex(swapAmount+1n,{size:32});}),'ProfileViolation(uint256)');
  await rejected('unapproved recipient is rejected',changedSwap(x=>{x[3]=keeper.account.address;}),'ProfileViolation(uint256)');
  await rejected('lower minimum output is rejected',changedSwap(x=>{x[4]=0n;}),'ProfileViolation(uint256)');
  await branch(async()=>{await send(owner,policy,'ConfiguredPurchase','setPaused',[true]);await rejected('paused policy cannot spend',{},'Denied()');});
  await branch(async()=>{await send(owner,policy,'ConfiguredPurchase','revoke');await rejected('revoked policy cannot spend',{},'Denied()');});
  await branch(async()=>{await advance(expiry+1n);await rejected('expired policy cannot spend',{},'Denied()');});
  const badRoute=changedSwap(x=>{x[5][1].callData=v.concat([v.slice(x[5][1].callData,0,4),'0xdeadbeef']);});
  await read(policy,'ConfiguredPurchase','validate',[badRoute.tx.to,badRoute.tx.data]);
  await rejected('failed route rolls back the budget, balance and approvals',badRoute);
  report.executions=[];
  for(let round=0;round<runCount;round++){
    const dir=join(out,'round-'+String(round+1).padStart(2,'0'));mkdirSync(dir,{recursive:true});
    const remoteAccount=await resolveLifiComposerAccount({chainId:4663,signer:account,deployment,client:remote});
    observation=await resolveLifiComposerAccount({chainId:4663,signer:account,deployment,client});
    const upstream=lifiComposer({apiKey:cfg.apiKey,baseUrl:'https://composer.li.quest',account:remoteAccount,fetch:captureFetch,timeoutMs:60000});let rawResult;
    const provider={name:'local-trial-envelope',async compile(req){rawResult=await upstream.compile(req);return normalize(rawResult,observation);}};
    await check('fresh Composer quote '+(round+1)+' matches the approved profile',async()=>{
      compiled=await sdk.compileBag(parsed.bag,{inputToken:assets.tokens.USDG.address,amountRaw:gross,inputTokenDecimals:6,signer:account},{provider,trust:observation.trust});
      await read(policy,'ConfiguredPurchase','validate',[compiled.transaction.to,compiled.transaction.data]);
      writeFileSync(join(dir,'compiled.json'),json(compiled));writeFileSync(join(dir,'upstream-adapter-result.json'),json(rawResult));writeFileSync(join(dir,'composer-response.json'),readFileSync(join(out,'composer-response.json')));
      return {programHash:v.keccak256(compiled.transaction.data),remoteTarget:rawResult.transaction.to,localTarget:compiled.transaction.to};
    });
    if(round>0)await advance((await counters()).last+period);
    let execution;
    await check('scheduled purchase '+(round+1)+' executes with the selected amount',async()=>{
      const before=await balances(),r=await invoke(),after=await balances();assert.equal(r.success,true,'Composer execution failed: '+r.result);
      const budgetState=await counters();assert.equal(before.USDG-after.USDG,swapAmount);assert.equal(budgetState.runs,BigInt(round+1));assert.equal(budgetState.gross,BigInt(round+1)*gross);assert.equal(budgetState.allowance,0n);
      assert(after.WETH-before.WETH>=floors[0].amountRaw);assert(after.cbBTC-before.cbBTC>=floors[1].amountRaw);
      const receipt=await client.getTransactionReceipt({hash:r.transactionHash});
      const approvals=v.parseEventLogs({abi:v.parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)']),logs:receipt.logs,eventName:'Approval'}).filter(x=>x.address.toLowerCase()===assets.tokens.USDG.address&&x.args.owner.toLowerCase()===account.toLowerCase());
      assert(approvals.some(x=>x.args.value===swapAmount));assert(approvals.every(x=>x.args.spender.toLowerCase()===observation.proxy.toLowerCase()&&x.args.value<=swapAmount));
      execution={round:round+1,transactionHash:r.transactionHash,gasUsed:r.gasUsed,before,after,budget:budgetState,programHash:v.keccak256(compiled.transaction.data),approvals:approvals.map(x=>({spender:x.args.spender,value:x.args.value}))};report.executions.push(execution);
      writeFileSync(join(dir,'execution-receipt.json'),json(receipt));return execution;
    });
    await check('SDK verifies actual call and balances for purchase '+(round+1),async()=>{
      const result=await sdk.verifyPurchaseReceipt(compiled,{client:withReceiptEvidence(client),transactionHash:execution.transactionHash,minimumReceived:floors,confirmations:1});
      assert.equal(result.status,'VERIFIED',json(result));assert.equal(result.transactionBinding,'CALL_TRACE');assert.equal(result.keptBalanceVerified,true);execution.receiptVerification=result;
      writeFileSync(join(dir,'execution-call-trace.json'),json(await client.request({method:'debug_traceTransaction',params:[execution.transactionHash,{tracer:'callTracer'}]})));return result;
    });
    console.log('PURCHASE '+(round+1));
    if(round===0&&runCount>1){
      const repeat={...compiled.transaction,to:observation.proxy,data:wire.normalize(compiled.transaction.data,context,true)};
      await rejected('an immediate repeat cannot spend a second purchase',{tx:repeat},'NotDue()');
    }
  }
  await advance((await counters()).last+period);
  await rejected('no extra purchase is allowed after the complete-purchase budget',{},'Denied()');
  await check('remaining balance is reserved USDG plus the unallocated remainder',async()=>{
    const final=await balances(),state=await counters(),spent=swapAmount*BigInt(runCount),reserved=(gross-swapAmount)*BigInt(runCount);
    assert.equal(final.USDG,budget-spent);assert.equal(state.runs,BigInt(runCount));assert.equal(state.gross,gross*BigInt(runCount));assert.equal(state.allowance,0n);assert.equal(final.USDG,reserved+BigInt(config.plan.remainderRaw));
    report.finalBalances=final;report.finalReservedRaw=reserved;report.totalSpentRaw=spent;return {final,reserved,remainderRaw:config.plan.remainderRaw,state};
  });
  report.status='CONFIGURED_USDG_RECURRING_FORK_VERIFIED';
}catch(e){report.status='INCOMPLETE';report.failedStage=stage;report.error=errorDetails(e);process.exitCode=1;console.log('STOP '+stage+': '+report.error);}
finally{
  report.finishedAt=new Date().toISOString();report.rpcBoundary={rejectedRpcRequests,upstreamReadMethods:upstreamMethods,publicSubmissionMethodsForwarded:0};
  report.summary={pass:cases.filter(x=>x.status==='PASS').length,fail:cases.filter(x=>x.status==='FAIL').length};
  writeFileSync(join(out,'results.json'),json(report));console.log(json({status:report.status,summary:report.summary,failedStage:report.failedStage,error:report.error,outputDirectory:out}));
  if(connection)await connection.close();if(server)await new Promise(r=>server.close(r));
}
