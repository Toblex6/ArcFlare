// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract EscrowTestToken is ERC20 {
    uint256 public mode;
    address public callback;
    bytes public callbackData;
    bool public callbackSucceeded;
    constructor() ERC20("Test", "TEST") { _mint(msg.sender, 1000000); }
    function configure(uint256 mode_, address callback_, bytes calldata data_) external {
        mode = mode_; callback = callback_; callbackData = data_;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) {
            _transfer(msg.sender, to, amount - 1);
            _burn(msg.sender, 1);
            return true;
        }
        if (mode == 3) (callbackSucceeded,) = callback.call(callbackData);
        bool result = super.transfer(to, amount);
        if (mode == 4) assembly { return(0, 0) }
        return result;
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) return super.transferFrom(from, to, amount - 1);
        if (mode == 3) (callbackSucceeded,) = callback.call(callbackData);
        bool result = super.transferFrom(from, to, amount);
        if (mode == 4) assembly { return(0, 0) }
        return result;
    }
}
