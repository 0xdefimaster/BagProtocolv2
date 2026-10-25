// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {ERC20Permit} from '@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

// TEST ONLY. Local stand-ins for contracts/test/RecurringPurchaseExecutor.test.ts.
// The fork test (contracts/test/fork/) uses the real USDG, Uniswap v3,
// BagFactory, StrategyRegistry and DelegationManager instead.

/// ERC-20 with EIP-2612 permit and configurable decimals (USDG has 6).
contract DcaTestToken is ERC20, ERC20Permit {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) ERC20Permit(name_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Uniswap SwapRouter02 `exactInputSingle` shape with a fixed rate per output token.
/// `consumeBps < 10000` simulates a partial fill (less input taken than offered).
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

    mapping(address => uint256) public rateNum;
    mapping(address => uint256) public rateDen;
    uint256 public consumeBps = 10_000;

    function setRate(address tokenOut, uint256 num, uint256 den) external {
        rateNum[tokenOut] = num;
        rateDen[tokenOut] = den;
    }

    function setConsumeBps(uint256 bps) external {
        consumeBps = bps;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        uint256 used = (p.amountIn * consumeBps) / 10_000;
        require(IERC20(p.tokenIn).transferFrom(msg.sender, address(this), used), 'pull');
        amountOut = (used * rateNum[p.tokenOut]) / rateDen[p.tokenOut];
        require(amountOut >= p.amountOutMinimum, 'Too little received');
        require(IERC20(p.tokenOut).transfer(p.recipient, amountOut), 'pay');
    }
}

/// A minimal smart account: ERC-1271 for its EOA owner, and token calls only from its DelegationManager.
/// @notice QuoterV2 `quoteExactInputSingle` shape over DcaMockSwapRouter02's rates (no pool, no price movement).
/// `sqrtPriceX96After` is 1, never a caller's limit, so a quote is always a full fill unless `limited` is set.
contract DcaMockQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    DcaMockSwapRouter02 public immutable dex;
    bool public limited;

    constructor(DcaMockSwapRouter02 dex_) {
        dex = dex_;
    }

    function setLimited(bool limited_) external {
        limited = limited_;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory p) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32, uint256) {
        uint256 den = dex.rateDen(p.tokenOut);
        require(den != 0, 'no pool');
        amountOut = (p.amountIn * dex.rateNum(p.tokenOut)) / den;
        sqrtPriceX96After = limited ? p.sqrtPriceLimitX96 : 1;
        return (amountOut, sqrtPriceX96After, 0, 0);
    }
}

contract DcaMockSmartAccount {
    address public immutable owner;
    address public immutable delegationManager;

    constructor(address owner_, address delegationManager_) {
        owner = owner_;
        delegationManager = delegationManager_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function executeFromDelegationManager(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == delegationManager, 'not dm');
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// Mimics DelegationManager.redeemDelegations for ONE single-mode execution. The
/// permission context is just the account address here. `amountOverride` makes the
/// account transfer a different amount (a misbehaving funding contract).
contract DcaMockDelegationManager {
    uint256 public amountOverride;
    address public allowedDelegate;

    function setAmountOverride(uint256 amount) external {
        amountOverride = amount;
    }

    function setAllowedDelegate(address delegate) external {
        allowedDelegate = delegate;
    }

    function redeemDelegations(bytes[] calldata contexts, bytes32[] calldata, bytes[] calldata calls) external {
        require(allowedDelegate == address(0) || msg.sender == allowedDelegate, 'not delegate');
        address account = abi.decode(contexts[0], (address));
        bytes calldata c = calls[0];
        address target = address(bytes20(c[:20]));
        uint256 value = uint256(bytes32(c[20:52]));
        bytes memory data = c[52:];
        if (amountOverride != 0) {
            (address to, ) = abi.decode(c[56:], (address, uint256));
            data = abi.encodeCall(IERC20.transfer, (to, amountOverride));
        }
        DcaMockSmartAccount(account).executeFromDelegationManager(target, value, data);
    }
}
