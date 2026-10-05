// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ComposerSettlementProbe} from "./ComposerSettlementProbe.sol";

/// @title ProbeCallerMock
/// @notice TEST ONLY. Stands in for a Composer execution proxy on Hardhat's
/// EVM, so the probe's two delivery models can be exercised with
/// msg.sender != tx.origin. Says nothing about what Composer really does —
/// that is what the live P1 run measures.
contract ProbeCallerMock {
    /// Model 2: approve the probe, then let it pull.
    function approveAndProbe(IERC20 token, ComposerSettlementProbe probe, address recipient, uint256 amount, uint256 minReceived)
        external
        returns (uint256)
    {
        token.approve(address(probe), amount);
        return probe.probe(recipient, amount, minReceived);
    }

    /// Model 1: transfer to the probe first, then call it with no allowance.
    function pushAndProbe(IERC20 token, ComposerSettlementProbe probe, address recipient, uint256 amount, uint256 minReceived)
        external
        returns (uint256)
    {
        token.transfer(address(probe), amount);
        return probe.probe(recipient, 0, minReceived);
    }
}
