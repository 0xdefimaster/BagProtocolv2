// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

/// @title CreatorRewardsVault
/// @notice Real settlement/claim contract for creator rewards (fork
/// royalties / performance fees). Production deployment target is
/// Robinhood Chain mainnet (chain id 4663), reward token USDG
/// (`lib/config/robinhood-chain.ts` — address verified against
/// docs.robinhood.com/chain/contracts).
///
/// v2 design change from the first version of this contract: `credit()`
/// used to ONLY write accounting, trusting that matching tokens had
/// already, separately, landed in this contract. That left a window where
/// `balanceOf` could be incremented before real money backed it — exactly
/// the "database row pretending to be money" failure mode this rewrite
/// closes. `settleReward()` now pulls the exact tokens it credits, in the
/// SAME transaction, from the caller (a `settler` — see below). If that
/// transfer fails, the whole settlement reverts, accounting included.
/// `totalOutstanding <= rewardToken.balanceOf(address(this))` is therefore
/// an invariant of the code, not a runtime check bolted on after the fact.
///
/// Two independent settler use cases are expected to call this contract:
///   1. A backend settlement worker (fork royalty rewards resolved by the
///      cross-chain purchase-execution flow — see the settlement worker
///      doc block in lib/server/creator-rewards-settlement.ts for why that
///      path can't yet be made single-transaction-atomic with the user's
///      own purchase, and settles in a following, still-idempotent step).
///   2. `RedeemFeeRouter` (contracts/RedeemFeeRouter.sol) — settles the
///      performance fee atomically, in the SAME transaction as the user's
///      own redeem swap, no separate backend step at all.
/// Both are added via `setSettler`, both are subject to the exact same
/// `settleReward` guarantees — this contract has no way to tell them apart
/// or trust one more than the other.
contract CreatorRewardsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The ERC-20 reward funds are held and paid out in. Fixed at
    /// deployment — a new vault is deployed rather than repointing this if
    /// the reward currency ever changes, so past creator balances are
    /// never left denominated ambiguously.
    IERC20 public immutable rewardToken;

    /// @notice Contract owner — can add/remove settlers and sweep foreign
    /// tokens. Not itself a settler. Production deployment MUST use a
    /// multisig here (see PRODUCTION.md / .env.example
    /// CREATOR_REWARDS_OWNER_ADDRESS) — never a hot EOA.
    address public owner;

    /// @notice Addresses allowed to call `settleReward`. Deliberately a
    /// set, not a single address: the backend settlement worker and
    /// `RedeemFeeRouter` are both legitimate, independent settlement
    /// paths (see contract-level doc). Neither has any elevated
    /// withdrawal right beyond `settleReward` itself — `withdraw` /
    /// `withdrawAll` don't check this mapping at all.
    mapping(address => bool) public isSettler;

    /// @notice creator address -> claimable reward-token balance not yet
    /// withdrawn. The ONLY state `settleReward` increases, and the ONLY
    /// state `withdraw`/`withdrawAll` decrease (always for the caller's
    /// own slot on the withdrawal side).
    mapping(address => uint256) public balanceOf;

    /// @notice Lifetime total ever credited to `creator`. Monotonically
    /// non-decreasing on-chain audit trail, independent of `balanceOf`.
    mapping(address => uint256) public totalCredited;

    /// @notice Lifetime total ever withdrawn by `creator`.
    mapping(address => uint256) public totalWithdrawn;

    /// @notice Marks off-chain reward events (`refId`) already settled, so
    /// a retried settlement job, or a resubmitted router transaction,
    /// can never double-credit the same event. `refId` is a deterministic
    /// function of the source event (see `settleReward` NatSpec) — never
    /// random — so a genuine retry naturally collides here and is
    /// rejected, rather than silently minting extra claimable balance.
    mapping(bytes32 => bool) public refUsed;

    /// @notice Sum of every creator's outstanding (credited, not yet
    /// withdrawn) balance across ALL creators. Because `settleReward`
    /// pulls the exact `amount` it credits in the same transaction,
    /// `totalOutstanding <= rewardToken.balanceOf(address(this))` holds by
    /// construction.
    uint256 public totalOutstanding;

    error ZeroAddress();
    error NotOwner();
    error NotSettler();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error CannotSweepRewardToken();
    error RefAlreadyUsed(bytes32 refId);
    error UnexpectedTransferAmount(uint256 expected, uint256 actualReceived);

    /// @notice Emitted once per successful settlement. `refId` is an
    /// opaque, deterministic off-chain reference (see `settleReward`) so
    /// every credit is traceable back to the exact reward event that
    /// produced it, without this contract needing to understand
    /// `FORK_ROYALTY` vs `PERFORMANCE_FEE` itself.
    event Credited(address indexed creator, uint256 amount, bytes32 indexed refId, address indexed settler);

    /// @notice Emitted whenever a creator withdraws — always their own
    /// funds, to their own address.
    event Withdrawn(address indexed creator, address indexed to, uint256 amount);

    event SettlerUpdated(address indexed settler, bool allowed);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event ForeignTokenSwept(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySettler() {
        if (!isSettler[msg.sender]) revert NotSettler();
        _;
    }

    constructor(address _rewardToken, address _owner, address initialSettler) {
        if (_rewardToken == address(0) || _owner == address(0) || initialSettler == address(0)) revert ZeroAddress();
        rewardToken = IERC20(_rewardToken);
        owner = _owner;
        isSettler[initialSettler] = true;
        emit SettlerUpdated(initialSettler, true);
    }

    /// @notice Atomically settles one off-chain-computed reward event:
    /// pulls `amount` of `rewardToken` from `msg.sender` (a settler — via
    /// a pre-existing ERC-20 approval, or, for `RedeemFeeRouter`, tokens
    /// the router itself just received from the same redeem swap) AND
    /// credits `creator`'s claimable balance, in the SAME transaction.
    ///
    /// Guards against a non-standard (fee-on-transfer/rebasing) reward
    /// token silently under-funding the vault: measures the ACTUAL
    /// balance delta and reverts if it doesn't exactly equal `amount`.
    /// @param creator The wallet to credit — resolved off-chain from the
    /// authenticated user's linked wallet_address (see lib/auth/session.ts)
    /// for the backend path, or supplied directly by the redeeming
    /// creator's own signed attestation for the router path.
    /// @param amount Amount of `rewardToken`, in its native decimals.
    /// @param refId Deterministic off-chain reference, e.g.
    /// keccak256("creator_reward_settlements:" || id) — see
    /// `lib/server/creator-rewards-settlement.ts`. Must be non-zero and
    /// never previously used.
    function settleReward(address creator, uint256 amount, bytes32 refId) external onlySettler nonReentrant {
        if (creator == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (refId == bytes32(0) || refUsed[refId]) revert RefAlreadyUsed(refId);
        refUsed[refId] = true;

        balanceOf[creator] += amount;
        totalCredited[creator] += amount;
        totalOutstanding += amount;

        emit Credited(creator, amount, refId, msg.sender);

        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = rewardToken.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);
    }

    /// @notice Withdraws `amount` of the caller's own claimable balance to
    /// the caller's own address. No approval, allowlist, or settler
    /// signature required. Cannot touch any other address's `balanceOf`
    /// slot.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = balanceOf[msg.sender];
        if (amount > available) revert InsufficientBalance(amount, available);

        balanceOf[msg.sender] = available - amount;
        totalWithdrawn[msg.sender] += amount;
        totalOutstanding -= amount;

        emit Withdrawn(msg.sender, msg.sender, amount);
        rewardToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Convenience wrapper: withdraws the caller's entire
    /// claimable balance. Identical guarantees to `withdraw`.
    function withdrawAll() external nonReentrant {
        uint256 available = balanceOf[msg.sender];
        if (available == 0) revert ZeroAmount();

        balanceOf[msg.sender] = 0;
        totalWithdrawn[msg.sender] += available;
        totalOutstanding -= available;

        emit Withdrawn(msg.sender, msg.sender, available);
        rewardToken.safeTransfer(msg.sender, available);
    }

    /// @notice Adds or removes a settler. Owner-only. Removing a settler
    /// takes effect immediately — any in-flight transaction from that
    /// address still reverts at `onlySettler` if it lands after this call.
    function setSettler(address settler, bool allowed) external onlyOwner {
        if (settler == address(0)) revert ZeroAddress();
        isSettler[settler] = allowed;
        emit SettlerUpdated(settler, allowed);
    }

    /// @notice Transfers ownership. Never touches settlers, `balanceOf`,
    /// or any reward-token funds.
    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Recovers ERC-20 tokens OTHER than `rewardToken` mistakenly
    /// sent directly to this contract. Explicitly cannot touch
    /// `rewardToken` — that balance is exactly what backs every creator's
    /// `balanceOf`, and letting `owner` sweep it would reintroduce the
    /// "operator/owner can redirect creator funds" risk this contract
    /// exists to remove.
    function sweepForeignToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(rewardToken)) revert CannotSweepRewardToken();
        if (to == address(0)) revert ZeroAddress();
        emit ForeignTokenSwept(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }
}
