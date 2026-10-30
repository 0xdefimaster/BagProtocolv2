import assert from 'node:assert/strict';
import {composerWire} from '../usdg-recurring/wire.mjs';
export function basketWire(v) {
  const wire=composerWire(v),instruction={type:'tuple[]',components:[{type:'uint256'},{type:'bytes32'}]};
  const hash=items=>v.keccak256(v.encodeAbiParameters([instruction],[items]));
  function profile(compiled,plan,amounts,definition) {
    const x=wire.decode(compiled.transaction.data);
    assert(x.instructions.length>0&&x.state.length<=127);
    assert.equal(x.instructions[0][0],9n);
    const contextSlot=Number(BigInt(v.slice(x.instructions[0][1],2,3)));
    const pull=x.instructions.filter(([op])=>op===3n);assert.equal(pull.length,1);
    const amountSlot=Number(BigInt(v.slice(pull[0][1],21,22)));
    assert.equal(v.slice(pull[0][1],0,20).toLowerCase(),plan.inputToken);
    assert.equal(Number(BigInt(v.slice(pull[0][1],20,21))),contextSlot);
    assert.equal(BigInt(x.state[amountSlot]),plan.swapAmountRaw);
    const slots=[];
    for(let i=0;i<x.state.length;i++)try{slots.push({slot:i,args:wire.swap(x.state[i])});}catch{}
    assert.equal(slots.length,plan.legs.length);
    const legs=plan.legs.map((leg,i)=>{
      const matches=slots.filter(s=>s.args[5].at(-1)?.receivingAssetId.toLowerCase()===leg.token);assert.equal(matches.length,1);
      const {slot,args}=matches[0],swaps=args[5];assert.equal(swaps.length,2);
      assert.equal(swaps[0].fromAmount,amounts[i],'Compiler split differs from the SDK partition');
      assert.equal(swaps[0].sendingAssetId.toLowerCase(),plan.inputToken);
      const minimum=BigInt(compiled.quote.legs[i].minOutRaw)*9900n/10000n;assert(minimum>0n);
      const asset=definition.assets.find(a=>a.address.toLowerCase()===leg.token);assert(asset);
      return {token:leg.token,weightBps:BigInt(asset.weightBps),input:swaps[0].fromAmount,net:swaps[1].fromAmount,minimum,slot:BigInt(slot),feeHash:v.keccak256(swaps[0].callData)};
    });
    return {instructions:x.instructions,state:x.state,contextSlot:BigInt(contextSlot),amountSlot:BigInt(amountSlot),legs,commandsHash:hash(x.instructions)};
  }
  function normalize(data,context,deployed,p) {
    const x=wire.decode(data);
    assert.equal(hash(x.instructions),p.commandsHash,'Compiler instruction template changed');
    assert.equal(x.state.length,p.state.length,'Compiler memory shape changed');
    x.state[Number(p.contextSlot)]=context;x.wrapped=!deployed;return wire.encode(x);
  }
  return {...wire,profile,normalize};
}
