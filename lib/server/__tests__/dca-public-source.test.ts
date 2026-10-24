import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {NextRequest} from 'next/server';
import {listPublicDcaBags,loadPublicDcaBag} from '@/lib/server/dca-public-bags';
import {GET as listRoute} from '@/app/api/dca-trial/bags/route';
import {GET as detailRoute} from '@/app/api/dca-trial/bags/[id]/route';
import {POST as startRoute} from '@/app/api/bags/[id]/dca-trial/route';
import {supportsDcaTrial} from '@/lib/dca/profile';
const {startMock}=vi.hoisted(()=>({startMock:vi.fn()}));
vi.mock('@/lib/server/dca-trial',async original=>({...await original<typeof import('@/lib/server/dca-trial')>(),startDcaTrial:startMock}));
const fixtureRoot=path.resolve(import.meta.dirname,'../../../scripts/research/dca-trial/fixtures');
const fixture=JSON.parse(readFileSync(path.join(fixtureRoot,'public-bags.json'),'utf8'));
const definition=JSON.parse(readFileSync(path.join(fixtureRoot,'a3caff05-d606-486b-959f-30865a4cbfa7.bag.json'),'utf8'));
const id=definition.ref.strategyId;
const feeFree=JSON.parse(readFileSync(path.join(fixtureRoot,'955df6e0-b6ea-44ba-a5eb-1288a80c0a06.bag.json'),'utf8'));
const feeFreeId=feeFree.ref.strategyId;
let listing:any,document:any,fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('BAG_DCA_TRIAL','true');vi.stubEnv('NEXT_PUBLIC_DCA_TRIAL','true');vi.stubEnv('BAG_DCA_PUBLIC_SOURCE','bagprotocol.com');
 listing=structuredClone(fixture);document=structuredClone(definition);
 startMock.mockReset().mockResolvedValue({id:'local-test',state:'RUNNING'});
 fetchMock=vi.fn(async(url:string)=>{
  if(url==='https://bagprotocol.com/api/bags')return new Response(JSON.stringify(listing));
  if(url===`https://bagprotocol.com/api/strategies/${id}/versions/2`)return new Response(JSON.stringify(document));
  if(url===`https://bagprotocol.com/api/strategies/${feeFreeId}/versions/1`)return new Response(JSON.stringify(feeFree));
  throw new Error('Unexpected network destination');
 });vi.stubGlobal('fetch',fetchMock);
});

describe('selected BAG execution boundary',()=>{
 const settings={budget:'25',amount:'5',purchases:'5',interval:'1',unit:'days'};
 async function post(bagId:string,body:unknown){return startRoute(new NextRequest(`http://127.0.0.1:3092/api/bags/${bagId}/dca-trial`,{method:'POST',headers:{host:'127.0.0.1:3092',origin:'http://127.0.0.1:3092','content-type':'application/json','x-bag-local-trial':'1'},body:JSON.stringify(body)}),{params:Promise.resolve({id:bagId})});}
 it('starts the actual four-asset BAG with its original hash and definition',async()=>{
  const r=await post(feeFreeId,{...settings,expectedDefinitionHash:feeFree.definitionHash,expectedVersion:1});expect(r.status).toBe(202);
  const args=startMock.mock.calls[0];expect(args[0]).toBe(feeFreeId);expect(args[1].definition).toEqual(feeFree.definition);expect(args[2]).toBe(feeFree.definitionHash);expect(args[4]).toMatchObject({purchases:5,amountRaw:'5000000',budgetRaw:'25000000'});
 });
 it('rejects a changed hash before any worker starts',async()=>{const r=await post(feeFreeId,{...settings,expectedDefinitionHash:'0x'+'0'.repeat(64),expectedVersion:1});expect(r.status).toBe(409);expect(startMock).not.toHaveBeenCalled();});
 it('rejects a changed version before any worker starts',async()=>{const r=await post(feeFreeId,{...settings,expectedDefinitionHash:feeFree.definitionHash,expectedVersion:2});expect(r.status).toBe(409);expect(startMock).not.toHaveBeenCalled();});
 it('requires explicit snapshot confirmation for a real BAG',async()=>{const r=await post(feeFreeId,settings);expect(r.status).toBe(409);expect(startMock).not.toHaveBeenCalled();});
 it('rejects a performance-fee BAG without replacing it',async()=>{const r=await post(id,{...settings,expectedDefinitionHash:definition.definitionHash,expectedVersion:2});expect(r.status).toBe(422);expect(startMock).not.toHaveBeenCalled();});
 it('rejects a mismatched 30 USDG budget before any worker starts',async()=>{const r=await post(feeFreeId,{...settings,budget:'30',expectedDefinitionHash:feeFree.definitionHash,expectedVersion:1});expect(r.status).toBe(400);expect(startMock).not.toHaveBeenCalled();});
 it('supports the selected BAG allocation after its fee is verified',async()=>{const {bag}=await loadPublicDcaBag(feeFreeId);expect(bag.composition).toHaveLength(4);expect(supportsDcaTrial(bag)).toBe(true);});
 it('rejects unknown fees',()=>{const b=fixture.bags.find((b:any)=>b.id===feeFreeId);expect(supportsDcaTrial(b)).toBe(false);});
 it('rejects wrong chains and duplicate token identities',()=>{const b=fixture.bags.find((b:any)=>b.id===feeFreeId);expect(supportsDcaTrial({...b,performanceFeeBps:0,chains:['ethereum']})).toBe(false);expect(supportsDcaTrial({...b,performanceFeeBps:0,composition:[b.composition[0],b.composition[0]]})).toBe(false);});
 it('rejects an invalid weight sum',()=>{const b=structuredClone(fixture.bags.find((b:any)=>b.id===feeFreeId));b.composition[0].weightBps++;expect(supportsDcaTrial({...b,performanceFeeBps:0})).toBe(false);});
 it('blocks starts in production even with all flags present',async()=>{vi.stubEnv('NODE_ENV','production');const r=await post(feeFreeId,{...settings,expectedDefinitionHash:feeFree.definitionHash,expectedVersion:1});expect(r.status).toBe(404);expect(startMock).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('explicit public source for an isolated local DCA trial',()=>{
 it('allows a same-origin local listing request',async()=>{const r=await listRoute(new NextRequest('http://127.0.0.1:3092/api/dca-trial/bags',{headers:{host:'127.0.0.1:3092',origin:'http://127.0.0.1:3092','x-bag-local-trial':'1'}}));expect(r.status).toBe(200);expect((await r.json()).bags).toHaveLength(fixture.bags.length);});
 it('returns exactly the actual public identities without needing a database key',async()=>{
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','');
  const result=await listPublicDcaBags();expect(result.map(b=>b.id).sort()).toEqual(listing.bags.map((b:any)=>b.id).sort());
  expect(fetchMock).toHaveBeenCalledWith('https://bagprotocol.com/api/bags',expect.objectContaining({method:'GET',credentials:'omit',redirect:'error',cache:'no-store'}));
 });
 it('validates the selected version and exact definition through the SDK',async()=>{
  const result=await loadPublicDcaBag(id);expect(result.document.definitionHash).toBe(definition.definitionHash);expect(result.bag.version).toBe(2);
  expect(result.bag.composition).toEqual(expect.arrayContaining([{address:definition.definition.assets[0].address,symbol:expect.any(String),weightBps:937,weight:9.37}]));
 });
 it('rejects a mismatched declared definition hash',async()=>{document.definitionHash='0x'+'0'.repeat(64);await expect(loadPublicDcaBag(id)).rejects.toThrow(/validation|hash/);});
 it('rejects a mismatched strategy identity',async()=>{document.ref.strategyId='00000000-0000-0000-0000-000000000000';await expect(loadPublicDcaBag(id)).rejects.toThrow('identity');});
 it('rejects a mismatched strategy version',async()=>{document.ref.version=3;document.ref.parentVersion=2;await expect(loadPublicDcaBag(id)).rejects.toThrow('version');});
 it('rejects allocation changes between the list and the definition',async()=>{
  const b=listing.bags.find((b:any)=>b.id===id);b.composition[0].weightBps+=1;b.composition[1].weightBps-=1;
  await expect(loadPublicDcaBag(id)).rejects.toThrow('changed');
 });
 it('rejects an unknown BAG without substituting a reference',async()=>{await expect(loadPublicDcaBag('00000000-0000-0000-0000-000000000000')).rejects.toThrow('not present');expect(fetchMock).toHaveBeenCalledTimes(1);});
 it('rejects an invalid identifier before any network request',async()=>{await expect(loadPublicDcaBag('../../admin')).rejects.toThrow('identity');expect(fetchMock).not.toHaveBeenCalled();});
 it('rejects duplicate BAG identities',async()=>{listing.bags.push(structuredClone(listing.bags[0]));await expect(listPublicDcaBags()).rejects.toThrow('Duplicate');});
 it('rejects invalid token weights',async()=>{listing.bags[0].composition[0].weightBps=-1;await expect(listPublicDcaBags()).rejects.toThrow('composition');});
 it('disables the source in production even when all flags are enabled',async()=>{vi.stubEnv('NODE_ENV','production');await expect(listPublicDcaBags()).rejects.toThrow('local trial');expect(fetchMock).not.toHaveBeenCalled();});
 it('requires the explicit public-source flag',async()=>{vi.stubEnv('BAG_DCA_PUBLIC_SOURCE','');await expect(listPublicDcaBags()).rejects.toThrow('local trial');expect(fetchMock).not.toHaveBeenCalled();});
 it('blocks list requests from a remote host before reading the source',async()=>{
  const response=await listRoute(new NextRequest('http://example.com/api/dca-trial/bags',{headers:{origin:'http://example.com','x-bag-local-trial':'1'}}));expect(response.status).toBe(404);expect(fetchMock).not.toHaveBeenCalled();
 });
 it('blocks list requests without local request evidence',async()=>{const r=await listRoute(new NextRequest('http://127.0.0.1:3092/api/dca-trial/bags'));expect(r.status).toBe(404);expect(fetchMock).not.toHaveBeenCalled();});
 it('blocks the detail route in production',async()=>{
  vi.stubEnv('NODE_ENV','production');const r=await detailRoute(new NextRequest('http://127.0.0.1:3092/api/dca-trial/bags/'+id,{headers:{origin:'http://127.0.0.1:3092','x-bag-local-trial':'1'}}),{params:Promise.resolve({id})});expect(r.status).toBe(404);expect(fetchMock).not.toHaveBeenCalled();
 });
});
