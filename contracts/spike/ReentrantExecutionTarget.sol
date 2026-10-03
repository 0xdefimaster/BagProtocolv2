// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ReentrantExecutionTarget
/// @notice TEST-ONLY hostile swap target. Never deploy this anywhere real.
///
/// Exists to actually PROVE `BagExecutionRouter`'s reentrancy boundary
/// rather than assume it from the presence of a `nonReentrant` modifier.
/// When the router calls this contract as a leg, it calls straight back
/// into `BagExecutionRouter.execute()` with a plan of the attacker's
/// choosing — the canonical "external call re-enters the caller before its
/// state settles" attack.
///
/// It records whether that inner call reverted, so the test can assert the
/// re-entry was REJECTED specifically (rather than, say, the whole
/// transaction failing for some unrelated reason that would make the test
/// pass for the wrong reason).
contract ReentrantExecutionTarget {
    address public immutable router;

    /// @notice Raw calldata for the re-entrant `execute(...)` call, set by
    /// the test. Kept as opaque bytes so this helper doesn't need to
    /// import the router's structs.
    bytes public reentrantCallData;

    /// @notice True once a re-entry has been attempted at least once.
    bool public didAttemptReentry;

    /// @notice True iff the most recent re-entry attempt reverted (the
    /// outcome the reentrancy guard should produce).
    bool public reentryReverted;

    constructor(address router_) {
        router = router_;
    }

    function setReentrantCallData(bytes calldata data) external {
        reentrantCallData = data;
    }

    /// @notice The function a leg's calldata points at. Deliberately
    /// swallows the inner call's failure instead of bubbling it, so the
    /// OUTER execution continues and the test can then inspect
    /// `reentryReverted` — if the guard were missing, the inner call would
    /// succeed here and `reentryReverted` would be false.
    function attack() external {
        didAttemptReentry = true;
        (bool ok, ) = router.call(reentrantCallData);
        reentryReverted = !ok;
    }

    receive() external payable {}
}
