// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @title HookERC20
/// @notice TEST ONLY. A mintable 6-decimal token with two misbehaviours a
/// settlement contract must survive:
///   - `hookTarget`/`hookData`: when `hookFrom` sends tokens, the token calls
///     `hookTarget` with `hookData` mid-transfer and bubbles its revert —
///     used to attempt re-entering `settle`;
///   - `skim`: when `hookFrom` sends tokens, 1 unit stays behind — used to
///     check the "nothing left after settlement" invariant.
contract HookERC20 is ERC20 {
    address public hookFrom;
    address public hookTarget;
    bytes public hookData;
    bool public skim;

    constructor() ERC20('Hook USD', 'HUSD') {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address from, address target, bytes calldata data, bool skimOne) external {
        hookFrom = from;
        hookTarget = target;
        hookData = data;
        skim = skimOne;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from == hookFrom && to != address(0)) {
            if (skim && value > 0) value -= 1;
            if (hookTarget != address(0)) {
                (bool ok, bytes memory ret) = hookTarget.call(hookData);
                if (!ok) {
                    assembly {
                        revert(add(ret, 32), mload(ret))
                    }
                }
            }
        }
        super._update(from, to, value);
    }
}
