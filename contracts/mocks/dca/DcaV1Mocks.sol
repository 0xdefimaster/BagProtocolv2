// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

// TEST ONLY. Local stand-ins for contracts/test/BagDcaExecutor.test.ts. The fork test
// (contracts/test/fork/BagDcaExecutor.fork.test.ts) uses the real USDG, tokenized
// stocks, SwapRouter02, v3 factory and BagFactory on a Robinhood Chain fork instead.

/// Mintable ERC-20 whose decimals can be changed (to test the decimals re-check).
contract DcaToken is ERC20 {
    uint8 private _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function setDecimals(uint8 d) external {
        _dec = d;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Burns `feeBps` of every transfer (fee-on-transfer).
contract DcaFeeOnTransferToken is ERC20 {
    uint256 public feeBps = 100;
    uint8 private immutable _dec;

    constructor(uint8 decimals_) ERC20('Fee Token', 'FOT') {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) return super._update(from, to, value);
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

/// Uniswap v3 factory `getPool` (symmetric), set by the test.
contract DcaMockV3Factory {
    mapping(bytes32 => address) private _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        _pools[_key(a, b, fee)] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[_key(a, b, fee)];
    }

    function _key(address a, address b, uint24 fee) private pure returns (bytes32) {
        (address x, address y) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(x, y, fee));
    }
}

/// SwapRouter02 `exactInputSingle` with a fixed rate per output token, paid from its own
/// balance (so fee-on-transfer output tokens behave as on a real pool), plus misbehaviours.
contract DcaMockSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    address public immutable factory;
    mapping(address => uint256) public rateNum;
    mapping(address => uint256) public rateDen;
    /// Share of amountIn actually pulled (partial fill when < 10000).
    uint256 public consumeBps = 10_000;
    /// Added to the reported amountOut (a router that lies about its output).
    uint256 public reportExtra;
    /// When set, the output goes here instead of `recipient`.
    address public divertTo;
    /// When set, called mid-swap with `reenterData` (revert bubbles).
    address public reenterTarget;
    bytes public reenterData;
    /// Skip the amountOutMinimum check (a router that ignores the minimum).
    bool public ignoreMinimum;
    uint256 public calls;
    uint24 public lastFee;

    constructor(address factory_) {
        factory = factory_;
    }

    function setRate(address tokenOut, uint256 num, uint256 den) external {
        rateNum[tokenOut] = num;
        rateDen[tokenOut] = den;
    }

    function setMisbehaviour(uint256 consumeBps_, uint256 reportExtra_, address divertTo_, bool ignoreMinimum_) external {
        consumeBps = consumeBps_;
        reportExtra = reportExtra_;
        divertTo = divertTo_;
        ignoreMinimum = ignoreMinimum_;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        calls += 1;
        lastFee = p.fee;
        uint256 used = (p.amountIn * consumeBps) / 10_000;
        require(IERC20(p.tokenIn).transferFrom(msg.sender, address(this), used), 'pull');
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        amountOut = (used * rateNum[p.tokenOut]) / rateDen[p.tokenOut];
        if (!ignoreMinimum) require(amountOut >= p.amountOutMinimum, 'Too little received');
        require(IERC20(p.tokenOut).transfer(divertTo == address(0) ? p.recipient : divertTo, amountOut), 'pay');
        amountOut += reportExtra;
    }
}

/// An adapter that breaks the executor's expectations (to test the executor's own checks):
/// mode 0 honest (pulls, pays `rate`), 1 leaves part of the allowance unused,
/// 2 pays less than minOut but claims success, 3 pulls and pays nothing.
contract DcaMisbehavingAdapter {
    address public immutable swapRouter;
    address public immutable poolFactory;
    uint256 public mode;
    mapping(address => uint256) public rateNum;
    mapping(address => uint256) public rateDen;

    constructor(address router_) {
        swapRouter = router_;
        poolFactory = address(0xFAC);
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function setRate(address tokenOut, uint256 num, uint256 den) external {
        rateNum[tokenOut] = num;
        rateDen[tokenOut] = den;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata) external returns (uint256 out) {
        uint256 pull = mode == 1 ? amountIn - 1 : amountIn;
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), pull), 'pull');
        if (mode == 3) return minOut;
        out = (pull * rateNum[tokenOut]) / rateDen[tokenOut];
        if (mode == 2) out = minOut - 1;
        require(IERC20(tokenOut).transfer(recipient, out), 'pay');
    }
}

/// ERC-1271 smart account: valid signatures are ECDSA signatures of `signer`; `disabled`
/// turns every signature invalid (a rotated / removed key). `exec` lets the signer act.
contract DcaMock1271Wallet {
    address public immutable signer;
    bool public disabled;

    constructor(address signer_) {
        signer = signer_;
    }

    function setDisabled(bool d) external {
        require(msg.sender == signer, 'signer');
        disabled = d;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == signer, 'signer');
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, 'exec');
        return ret;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (disabled) return 0xffffffff;
        (address got, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && got == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
