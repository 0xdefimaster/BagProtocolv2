import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import * as v from 'viem';
import {parseBag,planPurchase,simulatePartition} from '@/packages/bag-sdk/src/index';
import {basketWire} from '@/scripts/research/dca-trial/basket-wire.mjs';
const dir=path.resolve(import.meta.dirname,'../../../scripts/research/dca-trial/fixtures');
const wire=basketWire(v);
for(const [id,count] of [['955df6e0-b6ea-44ba-a5eb-1288a80c0a06',4],['a3caff05-d606-486b-959f-30865a4cbfa7',5]] as const){
 const capture=JSON.parse(readFileSync(path.join(dir,id+'.probe-compiled.json'),'utf8'));
 function fixture(){const parsed=parseBag(capture.bag);if(!parsed.ok)throw Error('invalid fixture');const plan=planPurchase(parsed.bag,{inputToken:capture.plan.inputToken,amountRaw:BigInt(5_000_000),inputTokenDecimals:6,signer:capture.plan.signer});return{plan,compiled:structuredClone(capture.compiled),amounts:simulatePartition(plan.swapAmountRaw,plan.legs.map(l=>l.legBps))};}
 describe('exact allocation program profile with '+count+' assets',()=>{
  it('pins every selected token and its SDK-calculated input share',()=>{const{plan,compiled,amounts}=fixture();const p=wire.profile(compiled,plan,amounts,capture.bag.definition);expect(p.legs).toHaveLength(count);expect(p.legs.map(l=>l.token)).toEqual(plan.legs.map(l=>l.token));expect(p.legs.map(l=>l.input)).toEqual(amounts);expect(p.legs.every(l=>l.minimum>BigInt(0))).toBe(true);});
  it('normalizes only the context and the factory/proxy envelope',()=>{const{plan,compiled,amounts}=fixture();const p=wire.profile(compiled,plan,amounts,capture.bag.definition),ctx=('0x'+'12'.repeat(32)) as `0x${string}`;const before=wire.decode(compiled.transaction.data),after=wire.decode(wire.normalize(compiled.transaction.data,ctx,true,p));expect(after.wrapped).toBe(false);expect(after.instructions).toEqual(before.instructions);for(let i=0;i<before.state.length;i++)expect(after.state[i]).toBe(i===Number(p.contextSlot)?ctx:before.state[i]);});
  it('refuses a fresh quote with different instructions',()=>{const{plan,compiled,amounts}=fixture();const p=wire.profile(compiled,plan,amounts,capture.bag.definition);const changed=wire.mutate(compiled.transaction.data,x=>{x.instructions[0][0]=BigInt(0);});expect(()=>wire.normalize(changed,v.zeroHash,false,p)).toThrow('template changed');});
  it('refuses a different input split in the first program',()=>{const{plan,compiled,amounts}=fixture();const p=wire.profile(compiled,plan,amounts,capture.bag.definition);compiled.transaction.data=wire.mutateSwap(compiled.transaction.data,Number(p.legs[0].slot),args=>{args[5][0].fromAmount+=BigInt(1);});expect(()=>wire.profile(compiled,plan,amounts,capture.bag.definition)).toThrow('split differs');});
  it('refuses substitution of an output token',()=>{const{plan,compiled,amounts}=fixture();const p=wire.profile(compiled,plan,amounts,capture.bag.definition);compiled.transaction.data=wire.mutateSwap(compiled.transaction.data,Number(p.legs[0].slot),args=>{args[5][1].receivingAssetId=v.zeroAddress;});expect(()=>wire.profile(compiled,plan,amounts,capture.bag.definition)).toThrow();});
 });
}
