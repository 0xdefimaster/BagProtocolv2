// Research profile only. Unknown compiler shapes are rejected by the on-chain guard.
export function composerWire(v) {
  const instruction = {type:'tuple[]',components:[{type:'uint256'},{type:'bytes32'}]};
  const memory = {type:'tuple',components:[{type:'bytes[]'}]};
  const types = [instruction,memory];
  const swapAbi = v.parseAbi(['function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[] swapData)']);
  function unwrap(data) {
    if (v.slice(data,0,4) !== '0x22aca0ca') return {program:data,wrapped:false};
    const [program] = v.decodeAbiParameters([{type:'bytes'}],v.slice(data,4));
    if (v.concat(['0x22aca0ca',v.encodeAbiParameters([{type:'bytes'}],[program])]) !== data) throw new Error('Noncanonical factory envelope');
    return {program,wrapped:true};
  }
  function decode(data) {
    const {program,wrapped} = unwrap(data);
    if (v.slice(program,0,4) !== '0x00a32e6c') throw new Error('Unknown Composer VM wire selector');
    const [instructions,[state]] = v.decodeAbiParameters(types,v.slice(program,4));
    const result = {instructions,state,wrapped};
    if (encode(result) !== data) throw new Error('Noncanonical VM encoding');
    return result;
  }
  function encode({instructions,state,wrapped}) {
    const program = v.concat(['0x00a32e6c',v.encodeAbiParameters(types,[instructions,[state]])]);
    return wrapped ? v.concat(['0x22aca0ca',v.encodeAbiParameters([{type:'bytes'}],[program])]) : program;
  }
  function body(data) { return v.slice(v.encodeAbiParameters([{type:'bytes'}],[data]),32); }
  function swap(state) {
    const length = Number(BigInt(v.slice(state,0,32)));
    const data = v.slice(state,32,32+length);
    if (body(data) !== state) throw new Error('Noncanonical bytes body');
    return v.decodeFunctionData({abi:swapAbi,data}).args;
  }
  function swapBody(args) { return body(v.encodeFunctionData({abi:swapAbi,functionName:'swapTokensMultipleV3ERC20ToERC20',args})); }
  function mutate(data,fn) {const x=decode(data);fn(x);return encode(x);}
  function mutateSwap(data,slot,fn) {return mutate(data,x=>{const args=swap(x.state[slot]);fn(args);x.state[slot]=swapBody(args);});}
  function normalize(data,context,proxyDeployed) {
    const x=decode(data);
    if (x.instructions.length!==34 || v.keccak256(v.encodeAbiParameters([instruction],[x.instructions]))!=='0xf6f3c39cb90f6bee24b03389d8a99b1bfe5a31b4bc92f7157516802ae11d1e4d' || x.state.length!==17) throw new Error('Unsupported Composer profile');
    x.state[15]=context;x.wrapped=!proxyDeployed;
    return encode(x);
  }
  return {decode,encode,normalize,mutate,mutateSwap,swap,swapBody,body};
}
