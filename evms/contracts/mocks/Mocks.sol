// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../libraries/Interfaces.sol";

// Test tokens for the local network only — never deployed to a live chain.

// a plain ERC-20 with configurable decimals (e.g. a 6-decimal "USDC")
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// WETH9-style wrapped native coin. Like the real WETH9 / WMON / WPOL it pays
// out with transfer(), which forwards only 2,300 gas: the pool's proxy must
// accept native coin within that stipend.
contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped Native", "WNATIVE") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);
    }
}

// burns 1% on every transfer — the pool must refuse it
contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 100;
        super._transfer(from, to, amount - fee);
        if (fee != 0) {
            _burn(from, fee);
        }
    }
}

// A swap adapter that misbehaves on purpose, to test the pool's own checks.
// It pays out of a balance it was pre-funded with.
contract MockMaliciousAdapter is ISwapAdapter {
    enum Mode {
        LieAboutOutput,   // claims a huge amountOut, pays the pool nothing
        RefundInput,      // pays minAmountOut, but hands part of the input back
        Reenter           // tries to call back into the pool mid-swap
    }

    Mode public mode;
    address public reentryTarget;
    bytes public reentryCall;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryCall = data;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata
    ) external returns (uint256) {
        if (mode == Mode.LieAboutOutput) {
            return type(uint128).max;
        }
        if (mode == Mode.RefundInput) {
            IERC20(tokenOut).transfer(recipient, minAmountOut);
            IERC20(tokenIn).transfer(recipient, amountIn / 2);
            return minAmountOut;
        }
        (bool ok, bytes memory reason) = reentryTarget.call(reentryCall);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        IERC20(tokenOut).transfer(recipient, minAmountOut);
        return minAmountOut;
    }
}
