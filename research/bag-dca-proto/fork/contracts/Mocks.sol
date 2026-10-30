// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// RESEARCH ONLY: stand-ins for the Composer swap so authorization paths can be proven without
/// an API key. They exercise the same approve/transferFrom shape the plan uses with Composer.
contract MockOut {
    string public constant symbol = "MOUT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
}

interface IERC20Like { function transferFrom(address, address, uint256) external returns (bool); }

contract MockRouter {
    uint8 public mode; // 0 normal, 1 revert, 2 deliver half
    function setMode(uint8 m) external { mode = m; }
    function swap(address tokenIn, uint256 amountIn, MockOut tokenOut, uint256 amountOut) external {
        if (mode == 1) revert("MockRouter: swap failed");
        require(IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        tokenOut.mint(msg.sender, mode == 2 ? amountOut / 2 : amountOut);
    }
}
