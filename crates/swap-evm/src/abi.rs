//! Solidity ABIs for the AtomicNock HTLC and ERC20, via alloy's `sol!` macro.
//! Replaces the viem `HTLC_ABI`/`ERC20_ABI` JSON. `sol!` generates a `<fn>Call`
//! struct (params, `.abi_encode()`) and `<fn>Return` (`abi_decode_returns`) for
//! each function, so we encode calldata and decode results without a JSON ABI.

use alloy_sol_types::sol;

sol! {
    #[allow(missing_docs)]
    interface IHtlc {
        function lock(address seller, uint256 amount, bytes32 hashlock, uint256 timelock) external returns (bytes32 id);
        function withdraw(bytes32 id, bytes preimageJam) external;
        function refund(bytes32 id) external;
        function swapId(address seller, address buyer, uint256 amount, bytes32 hashlock, uint256 timelock) external pure returns (bytes32);
        function feeBps() external view returns (uint16);
        function getLock(bytes32 id) external view returns (
            address buyer,
            address seller,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            bool withdrawn,
            bool refunded
        );
        event Withdrawn(bytes32 indexed swapId, address indexed seller);
    }

    #[allow(missing_docs)]
    interface IERC20 {
        function approve(address spender, uint256 amount) external returns (bool);
        function decimals() external view returns (uint8);
        function allowance(address owner, address spender) external view returns (uint256);
        function balanceOf(address account) external view returns (uint256);
    }
}
