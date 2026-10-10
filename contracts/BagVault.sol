// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

/// @title BagVault (SPIKE — not deployed, not wired to the app)
/// @notice A transferable ERC-20 share of one Bag, minted and redeemed IN KIND
/// against the basket's own components. Design and threat model:
/// docs/BAG_VAULT_DESIGN.md.
///
/// What it does, and nothing else:
///   - mint: the caller deposits every component pro-rata and gets shares;
///   - redeem: the caller burns shares and gets every component pro-rata.
/// It never swaps, never calls anything but the component tokens, reads no
/// oracle and trusts no signer or backend: the price of a share is the
/// basket itself, so there is nothing to attest.
///
/// Fixed composition. The component list and the "unit basket" (the amount
/// of each component per 1e18 shares at the first mint) are set at
/// construction and never change. No rebalance, no admin. A Bag that later
/// records a new composition version keeps this vault on the version it was
/// created for (`bagVersion`, `compositionHash`); `isCurrentComposition()`
/// says whether that is still the Bag's current one.
///
/// Rounding always favours the vault (and so the remaining holders):
///   mint   pays  ceil(shares × holding_i / totalSupply) of each component;
///   redeem gets  floor(shares × holding_i / totalSupply) of each component.
///
/// Holdings are internal accounting, not `balanceOf`: tokens sent to the
/// vault directly (donations) are never counted, so they cannot move the
/// price of a share. Every transfer is checked by balance delta, which
/// refuses fee-on-transfer tokens.
///
/// Emergency pause stops MINT ONLY. Redeem can never be paused: holders can
/// always take their basket out.
contract BagVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Shares minted to DEAD_ADDRESS on the first mint and never
    /// redeemable: the supply can never return to zero, so the first-mint
    /// path (priced from the unit basket) runs exactly once.
    uint256 public constant DEAD_SHARES = 1_000;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice Smallest first mint, in share units (1e-9 of a share at 18 decimals).
    uint256 public constant MIN_FIRST_MINT = 1e9;
    /// @notice Bounds the loops in mint/redeem.
    uint256 public constant MAX_COMPONENTS = 20;
    uint256 private constant UNIT = 1e18;

    /// @notice The `Bag` this vault is the share token for.
    address public immutable bag;
    /// @notice The Bag's composition version and hash when this vault was created.
    uint256 public immutable bagVersion;
    bytes32 public immutable compositionHash;

    address[] private _tokens;
    uint256[] private _unitAmounts;
    /// @notice Internal holding of each component (index = component index).
    uint256[] private _holdings;

    /// @notice May pause and unpause MINT, and hand the role on or renounce it. Zero = nobody.
    address public guardian;
    bool public mintPaused;

    error ZeroAddress();
    error NoComponents();
    error TooManyComponents(uint256 count);
    error LengthMismatch();
    error DuplicateComponent(address token);
    error ZeroUnitAmount(address token);
    error ZeroShares();
    error FirstMintTooSmall(uint256 shares, uint256 minimum);
    error AboveMaxAmountIn(uint256 index, uint256 amount, uint256 max);
    error BelowMinAmountOut(uint256 index, uint256 amount, uint256 min);
    error TransferAmountMismatch(address token, uint256 expected, uint256 actual);
    error MintPaused();
    error NotGuardian();

    event Minted(address indexed caller, address indexed receiver, uint256 shares, uint256[] amountsIn);
    event Redeemed(address indexed owner, address indexed receiver, uint256 shares, uint256[] amountsOut);
    event MintPauseSet(bool paused);
    event GuardianSet(address indexed previous, address indexed next);

    /// @notice Constructor arguments (a struct keeps the factory's call within the stack limit).
    struct Config {
        string name;
        string symbol;
        address bag;
        uint256 bagVersion;
        bytes32 compositionHash;
        address[] tokens;
        uint256[] unitAmounts;
        address guardian;
    }

    constructor(Config memory c) ERC20(c.name, c.symbol) {
        if (c.bag == address(0)) revert ZeroAddress();
        uint256 n = c.tokens.length;
        if (n == 0) revert NoComponents();
        if (n > MAX_COMPONENTS) revert TooManyComponents(n);
        if (c.unitAmounts.length != n) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            if (c.tokens[i] == address(0)) revert ZeroAddress();
            if (c.unitAmounts[i] == 0) revert ZeroUnitAmount(c.tokens[i]);
            for (uint256 j = 0; j < i; j++) if (c.tokens[j] == c.tokens[i]) revert DuplicateComponent(c.tokens[i]);
        }
        bag = c.bag;
        bagVersion = c.bagVersion;
        compositionHash = c.compositionHash;
        _tokens = c.tokens;
        _unitAmounts = c.unitAmounts;
        _holdings = new uint256[](n);
        guardian = c.guardian;
        emit GuardianSet(address(0), c.guardian);
    }

    // ----------------------------------------------------------------- views

    function components() external view returns (address[] memory tokens, uint256[] memory unitAmounts) {
        return (_tokens, _unitAmounts);
    }

    function holdings() external view returns (uint256[] memory) {
        return _holdings;
    }

    /// @notice Amounts `mint(shares, …)` would take right now (rounded up).
    function previewMint(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _tokens.length;
        amounts = new uint256[](n);
        uint256 supply = totalSupply();
        if (supply == 0) {
            uint256 total = shares + DEAD_SHARES;
            for (uint256 i = 0; i < n; i++) amounts[i] = Math.mulDiv(total, _unitAmounts[i], UNIT, Math.Rounding.Ceil);
        } else {
            for (uint256 i = 0; i < n; i++) amounts[i] = Math.mulDiv(shares, _holdings[i], supply, Math.Rounding.Ceil);
        }
    }

    /// @notice Amounts `redeem(shares, …)` would pay right now (rounded down).
    function previewRedeem(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _tokens.length;
        amounts = new uint256[](n);
        uint256 supply = totalSupply();
        if (supply == 0) return amounts;
        for (uint256 i = 0; i < n; i++) amounts[i] = Math.mulDiv(shares, _holdings[i], supply, Math.Rounding.Floor);
    }

    /// @notice Whether the Bag's current composition is still the one this vault holds.
    function isCurrentComposition() external view returns (bool) {
        return IBagVersion(bag).version() == bagVersion && IBagVersion(bag).compositionHash() == compositionHash;
    }

    // ------------------------------------------------------------- mint/redeem

    /// @notice Deposits each component pro-rata and mints exactly `shares` to `receiver`.
    /// @param maxAmountsIn Per-component ceiling (slippage protection): reverts if any amount is above it.
    function mint(uint256 shares, address receiver, uint256[] calldata maxAmountsIn) external nonReentrant returns (uint256[] memory amounts) {
        if (mintPaused) revert MintPaused();
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 n = _tokens.length;
        if (maxAmountsIn.length != n) revert LengthMismatch();

        bool first = totalSupply() == 0;
        if (first && shares < MIN_FIRST_MINT) revert FirstMintTooSmall(shares, MIN_FIRST_MINT);

        amounts = previewMint(shares);
        for (uint256 i = 0; i < n; i++) if (amounts[i] > maxAmountsIn[i]) revert AboveMaxAmountIn(i, amounts[i], maxAmountsIn[i]);

        for (uint256 i = 0; i < n; i++) {
            if (amounts[i] == 0) continue;
            IERC20 token = IERC20(_tokens[i]);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            uint256 received = token.balanceOf(address(this)) - before;
            // Fee-on-transfer (and anything else that delivers a different amount) is refused.
            if (received != amounts[i]) revert TransferAmountMismatch(address(token), amounts[i], received);
        }

        // Holdings and supply move together, after every transfer: a view read from a
        // token hook mid-mint (read-only reentrancy) sees the old, consistent state,
        // never holdings raised for some components while the supply is not.
        for (uint256 i = 0; i < n; i++) _holdings[i] += amounts[i];
        if (first) _mint(DEAD_ADDRESS, DEAD_SHARES);
        _mint(receiver, shares);
        emit Minted(msg.sender, receiver, shares, amounts);
    }

    /// @notice Burns `shares` of the caller and sends each component pro-rata to `receiver`. Never paused.
    /// @param minAmountsOut Per-component floor (slippage protection): reverts if any amount is below it.
    function redeem(uint256 shares, address receiver, uint256[] calldata minAmountsOut) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 n = _tokens.length;
        if (minAmountsOut.length != n) revert LengthMismatch();

        amounts = previewRedeem(shares);
        for (uint256 i = 0; i < n; i++) if (amounts[i] < minAmountsOut[i]) revert BelowMinAmountOut(i, amounts[i], minAmountsOut[i]);

        // Effects before interactions: the shares are gone and the holdings
        // reduced before any token moves.
        _burn(msg.sender, shares);
        for (uint256 i = 0; i < n; i++) _holdings[i] -= amounts[i];

        for (uint256 i = 0; i < n; i++) {
            if (amounts[i] == 0) continue;
            IERC20 token = IERC20(_tokens[i]);
            uint256 before = token.balanceOf(address(this));
            token.safeTransfer(receiver, amounts[i]);
            uint256 sent = before - token.balanceOf(address(this));
            if (sent != amounts[i]) revert TransferAmountMismatch(address(token), amounts[i], sent);
        }
        emit Redeemed(msg.sender, receiver, shares, amounts);
    }

    // ---------------------------------------------------------------- guardian

    modifier onlyGuardian() {
        if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
        _;
    }

    /// @notice Pauses or resumes MINT. Has no effect on redeem.
    function setMintPaused(bool paused) external onlyGuardian {
        mintPaused = paused;
        emit MintPauseSet(paused);
    }

    /// @notice Hands the guardian role on; `address(0)` renounces it for good.
    function setGuardian(address next) external onlyGuardian {
        emit GuardianSet(guardian, next);
        guardian = next;
    }
}

interface IBagVersion {
    function version() external view returns (uint256);
    function compositionHash() external view returns (bytes32);
}
